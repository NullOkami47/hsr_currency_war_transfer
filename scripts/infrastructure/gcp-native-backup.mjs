import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { boundedRequest, readEncryptedBackupPair, readMonitorSnapshot, runMonitoredBackup, validateEncryptedBackup } from './azure-blob-backup.mjs';
import { createStatusStore } from './backup-control-state.mjs';
import { createMetadataTokenProvider } from './cloud-backup-monitor/server.mjs';

export const GCS_BUCKET = 'hsr-worker-backups-282550645630';
export const GCP_ARCHIVE_PREFIX = 'gcp-production/hsr-state/';
export const GCP_EVENT_PREFIX = 'gcp-production/monitor/events/';
export const PINNED_PROJECT = 'hsr-currency-war-worker';
export const PINNED_INSTANCE = 'hsr-worker-standby';
export const PINNED_INSTANCE_ID = '4111188809525812699';
export const PINNED_SERVICE = 'hsr-worker-production.service';
export const PINNED_CONFIG_PATH = '/etc/hsr-gcp-production/backup.json';
export const PINNED_SPOOL_DIR = '/var/lib/hsr-worker-backups-gcp-production';
export const PINNED_CONTROL_DIR = '/var/lib/hsr-worker-backup-control';

const STATE_DIR = '/var/lib/hsr-transfer-worker-production';
const ALLOWED_CONFIG_KEYS = new Set([
  'service', 'endpoint', 'environmentFile', 'paths', 'publicKeyPath', 'backupDirectory', 'gcs', 'azureSecondary',
]);
const PHASES = new Set([
  'prepared', 'closing_admission', 'draining', 'stopping', 'stopped',
  'snapshotting', 'starting', 'restoring_admission', 'complete',
]);
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validates the non-secret GCP-native backup configuration against pinned production targets.
 */
export function validateGcpNativeBackupConfig(config) {
  const invalid = () => {
    throw failure('GCP_BACKUP_CONFIG', 'Invalid GCP-native backup configuration.');
  };
  if (!isPlainObject(config)) invalid();
  if (Object.keys(config).some(key => !ALLOWED_CONFIG_KEYS.has(key))) invalid();
  if (config.service !== PINNED_SERVICE
      || config.endpoint !== 'http://127.0.0.1:8787/'
      || config.environmentFile !== '/etc/hsr-gcp-production/worker.env'
      || config.publicKeyPath !== '/etc/hsr-gcp-production/recipient-public.pem'
      || typeof config.backupDirectory !== 'string'
      || !isAbsolute(config.backupDirectory)) {
    invalid();
  }
  const paths = config.paths;
  if (!isPlainObject(paths)
      || Object.keys(paths).sort().join() !== 'jobs,security,transfers'
      || paths.transfers !== `${STATE_DIR}/transfers.json`
      || paths.jobs !== `${STATE_DIR}/jobs.json`
      || paths.security !== `${STATE_DIR}/jobs.json.security.json`) {
    invalid();
  }
  const gcs = config.gcs;
  if (!isPlainObject(gcs)
      || gcs.enabled !== true
      || Object.keys(gcs).some(key => !['enabled', 'bucket', 'archivePrefix', 'eventPrefix'].includes(key))
      || (gcs.bucket !== undefined && gcs.bucket !== GCS_BUCKET)
      || (gcs.archivePrefix !== undefined && gcs.archivePrefix !== GCP_ARCHIVE_PREFIX)
      || (gcs.eventPrefix !== undefined && gcs.eventPrefix !== GCP_EVENT_PREFIX)) {
    invalid();
  }
  if (config.azureSecondary !== undefined) {
    if (!isPlainObject(config.azureSecondary)
        || Object.keys(config.azureSecondary).some(key => key !== 'enabled')
        || typeof config.azureSecondary.enabled !== 'boolean') {
      invalid();
    }
  }
  return {
    ...config,
    gcs: {
      enabled: true,
      bucket: GCS_BUCKET,
      archivePrefix: GCP_ARCHIVE_PREFIX,
      eventPrefix: GCP_EVENT_PREFIX,
    },
    azureSecondary: {
      enabled: config.azureSecondary?.enabled === true,
    },
  };
}

function budget(timeoutMs, shouldAbort) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240000) {
    throw failure('GCP_BACKUP_CONFIG', 'Invalid GCP backup deadline configuration.');
  }
  const end = performance.now() + timeoutMs;
  return {
    remaining() {
      if (shouldAbort()) throw failure('GCP_BACKUP_INTERRUPTED', 'Backup interrupted.');
      const left = Math.ceil(end - performance.now());
      if (left <= 0) throw failure('GCP_BACKUP_DEADLINE', 'GCP backup deadline exceeded.');
      return left;
    },
    async wait(operation, limit) {
      const left = Math.min(this.remaining(), limit);
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(failure('GCP_BACKUP_DEADLINE', 'GCP backup deadline exceeded.')), left);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function retryRequest(request, url, options, clock) {
  for (let attempt = 0; attempt < 3; attempt++) {
    clock.remaining();
    try {
      const timeoutMs = Math.min(clock.remaining(), options.timeoutMs ?? 60000);
      const response = await clock.wait(() => request(url, { ...options, timeoutMs }), timeoutMs);
      clock.remaining();
      if (!Number.isInteger(response?.status) || !Buffer.isBuffer(response.body) || response.body.length > options.maxBytes) {
        throw failure('GCP_BACKUP_TRANSPORT', 'Invalid bounded GCS response.');
      }
      if (response.status !== 408 && response.status !== 429 && response.status < 500) return response;
    } catch (error) {
      if (error.code === 'GCP_BACKUP_INTERRUPTED' || error.code === 'GCP_BACKUP_DEADLINE') throw error;
    }
    if (attempt === 2) throw failure('GCP_BACKUP_TRANSPORT', 'GCS transport retries exhausted.');
    await clock.wait(() => new Promise(resolveDelay => setTimeout(resolveDelay, 100 * (attempt + 1))), 300);
  }
}

function statusEvent({ result, stage, mode, perDest, snapshot }) {
  const final = result === 'success' ? 'success' : 'failure';
  const destinations = {};
  for (const name of ['azure', 'gcs']) {
    const state = perDest?.[name]?.status;
    destinations[name] = {
      status: ['success', 'failure', 'skipped'].includes(state) ? state : 'skipped',
      transportVerified: state === 'success',
      restoreVerified: false,
    };
  }
  return {
    version: 1,
    source: 'gcp',
    runId: randomUUID(),
    at: new Date().toISOString(),
    result: final,
    stage: ['coordinator', 'validation', 'delivery', 'complete'].includes(stage) ? stage : 'coordinator',
    mode: mode === 'resend' ? 'resend' : 'scheduled',
    perDest: destinations,
    snapshot: {
      runStatus: final,
      workerHealth: snapshot?.workerHealth === 'confirmed' ? 'confirmed' : 'unknown',
      admission: typeof snapshot?.admission === 'boolean' ? snapshot.admission : 'unknown',
      journal: {
        phase: PHASES.has(snapshot?.journal?.phase) ? snapshot.journal.phase : 'unknown',
        originalAdmission: typeof snapshot?.journal?.originalAdmission === 'boolean'
          ? snapshot.journal.originalAdmission
          : null,
      },
    },
    restoreVerified: false,
  };
}

/**
 * Creates an immutable GCS backup and status-event client authenticated solely
 * via short-lived GCE instance metadata tokens. Never calls Azure IMDS or STS.
 */
export function createGcpNativeBackupClient({
  config: rawConfig,
  request = boundedRequest,
  getToken,
  shouldAbort = () => false,
  timeoutMs = 180000,
}) {
  const config = validateGcpNativeBackupConfig(rawConfig);
  budget(timeoutMs, shouldAbort);

  let activeClock;
  const cachedProvider = getToken ?? createMetadataTokenProvider({
    request: (url, options) => retryRequest(request, url, options, activeClock),
  });

  async function authenticate(clock) {
    try {
      activeClock = clock;
      const token = await clock.wait(() => cachedProvider(), 10000);
      if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) {
        throw failure('GCP_BACKUP_AUTH', 'Invalid GCE metadata access token.');
      }
      return token;
    } catch (error) {
      if (error.code === 'GCP_BACKUP_DEADLINE' || error.code === 'GCP_BACKUP_INTERRUPTED') throw error;
      throw failure('GCP_BACKUP_AUTH', 'GCE metadata authentication unavailable.');
    }
  }

  async function immutable(name, bytes, token, clock) {
    const headers = { authorization: `Bearer ${token}` };
    const readUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(name)}?alt=media`;
    const readOptions = { method: 'GET', headers, timeoutMs: 60000, maxBytes: Math.max(bytes.length, 65536) };
    const matches = response => response.status === 200
      && response.body.length === bytes.length
      && digest(response.body) === digest(bytes);

    const existing = await retryRequest(request, readUrl, readOptions, clock);
    if (existing.status === 200) {
      if (!matches(existing)) throw failure('GCP_BACKUP_CHECKSUM', 'GCS read-back checksum collision or mismatch.');
      return;
    }
    if (existing.status !== 404) throw failure('GCP_BACKUP_READ', 'GCS existing-object read failed.');

    const upload = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o`);
    upload.search = new URLSearchParams({ uploadType: 'media', name, ifGenerationMatch: '0' }).toString();
    const response = await retryRequest(request, upload.href, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': String(bytes.length) },
      body: bytes,
      timeoutMs: 60000,
      maxBytes: 65536,
    }, clock);
    if (![200, 201, 412].includes(response.status)) {
      throw failure('GCP_BACKUP_UPLOAD', 'GCS immutable upload failed.');
    }
    const readback = await retryRequest(request, readUrl, readOptions, clock);
    if (!matches(readback)) throw failure('GCP_BACKUP_CHECKSUM', 'GCS read-back checksum collision or mismatch.');
  }

  return {
    async deliver(snapshot) {
      const clock = budget(timeoutMs, shouldAbort);
      const { name, ciphertext, receiptBytes, receipt } = await validateEncryptedBackup({ config, snapshot });
      const token = await authenticate(clock);
      await immutable(`${GCP_ARCHIVE_PREFIX}${name}`, ciphertext, token, clock);
      await immutable(`${GCP_ARCHIVE_PREFIX}${name.replace(/\.enc\.json$/, '.receipt.json')}`, receiptBytes, token, clock);
      clock.remaining();
      return {
        transportVerified: true,
        restoreVerified: false,
        createdAt: receipt.createdAt,
        sha256: receipt.sha256,
        bucket: GCS_BUCKET,
        objectPrefix: GCP_ARCHIVE_PREFIX,
      };
    },
    async recordStatus(state) {
      const clock = budget(Math.min(timeoutMs, 30000), () => false);
      const event = statusEvent(state);
      const token = await authenticate(clock);
      const objectName = `${GCP_EVENT_PREFIX}${event.at.replace(/[:.]/g, '-')}-${event.runId}.json`;
      await immutable(objectName, Buffer.from(JSON.stringify(event) + '\n'), token, clock);
      return { status: 'success', transportVerified: true, object: objectName };
    },
  };
}

async function runGcpDestinations({
  config: rawConfig,
  obtainSnapshot,
  request = boundedRequest,
  getToken,
  deliverAzureSecondary,
  onRecovered = () => {},
  shouldAbort = () => false,
  readMonitor = readMonitorSnapshot,
  mode = 'scheduled',
}) {
  const config = validateGcpNativeBackupConfig(rawConfig);
  if (config.azureSecondary.enabled && typeof deliverAzureSecondary !== 'function') {
    throw failure('GCP_BACKUP_SECONDARY_UNAVAILABLE', 'GCP-to-Azure secondary backup adapter is not configured.');
  }
  const client = createGcpNativeBackupClient({ config, request, getToken, shouldAbort });
  const skipped = () => ({ status: 'skipped', transportVerified: false, restoreVerified: false });
  const perDest = { azure: skipped(), gcs: skipped() };
  let snapshot, gcsResult, stage = mode === 'resend' ? 'validation' : 'coordinator', failed = false, recovered = false;
  try {
    snapshot = await obtainSnapshot();
    await onRecovered();
    recovered = mode === 'scheduled';
    stage = 'delivery';
    const tasks = [Promise.resolve().then(() => client.deliver(snapshot))];
    const names = ['gcs'];
    if (config.azureSecondary.enabled) {
      tasks.push(Promise.resolve().then(() => deliverAzureSecondary(snapshot)));
      names.push('azure');
    }
    const outcomes = await Promise.allSettled(tasks);
    for (const [index, name] of names.entries()) {
      const outcome = outcomes[index];
      const ok = outcome.status === 'fulfilled' && outcome.value?.transportVerified === true;
      perDest[name] = { status: ok ? 'success' : 'failure', transportVerified: ok, restoreVerified: false };
      if (!ok) failed = true;
      if (name === 'gcs' && ok) gcsResult = outcome.value;
    }
  } catch {
    failed = true;
  }
  let statusEventResult;
  try {
    let monitoring = {};
    try {
      monitoring = await readMonitor({ service: config.service, recovered });
    } catch { /* Unknown recovery evidence remains explicit. */ }
    statusEventResult = await client.recordStatus({
      result: failed ? 'failure' : 'success',
      stage: failed ? stage : 'complete',
      mode,
      perDest,
      snapshot: { ...monitoring, workerHealth: recovered ? 'confirmed' : 'unknown' },
    });
  } catch {
    statusEventResult = { status: 'failure', transportVerified: false };
  }
  if (failed || statusEventResult.status !== 'success') {
    const error = failure(
      failed ? 'BACKUP_RUN_FAILED' : 'BACKUP_STATUS_FAILED',
      'GCP backup run failed; inspect destination status and protected local recovery evidence.',
    );
    error.perDest = perDest;
    error.statusEvent = statusEventResult;
    error.stage = stage;
    error.mode = mode;
    throw error;
  }
  return { ...gcsResult, perDest, statusEvent: statusEventResult, mode };
}

export async function runGcpScheduledBackup({ runCoordinator, ...options }) {
  return runGcpDestinations({
    ...options,
    mode: 'scheduled',
    obtainSnapshot: async () => {
      const result = await runCoordinator();
      if (!result || result.offVmDeliveryVerified !== false || !result.localSnapshot) {
        throw failure('GCP_BACKUP_COORDINATOR', 'Invalid coordinator result.');
      }
      return result.localSnapshot;
    },
  });
}

export async function resendGcpBackupPair({ config, file, receiptFile, ...options }) {
  const { snapshot } = await readEncryptedBackupPair({ config, file, receiptFile });
  return runGcpDestinations({
    ...options,
    config,
    mode: 'resend',
    obtainSnapshot: async () => snapshot,
  });
}

export function parseGcpBackupArguments(args) {
  const [configPath, flag, file, receiptFile] = args ?? [];
  if (configPath === PINNED_CONFIG_PATH) {
    if (args.length === 1) return { configPath, mode: 'scheduled' };
    if (args.length === 4 && flag === '--resend-pair' && file && receiptFile) {
      return { configPath, mode: 'resend', file, receiptFile };
    }
  }
  throw failure('GCP_BACKUP_ARGUMENTS', 'Expected approved GCP backup configuration, optionally followed by --resend-pair FILE RECEIPT.');
}

async function main() {
  const { configPath, mode, file, receiptFile } = parseGcpBackupArguments(process.argv.slice(2));
  const resend = mode === 'resend';
  if (process.platform !== 'linux' || process.getuid?.() !== 0
      || (!resend && process.env.HSR_BACKUP_FLOCK_HELD !== '1')) {
    throw failure('GCP_BACKUP_AUTH', 'Root, approved configuration and flock for scheduled backup required.');
  }
  let interrupted = false;
  process.on('SIGTERM', () => { interrupted = true; });
  process.on('SIGINT', () => { interrupted = true; });
  const loadConfig = async () => {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) {
      throw failure('GCP_BACKUP_CONFIG', 'Protected root-owned configuration required.');
    }
    const parsed = validateGcpNativeBackupConfig(JSON.parse(await readFile(configPath, 'utf8')));
    if (parsed.backupDirectory !== PINNED_SPOOL_DIR) {
      throw failure('GCP_BACKUP_CONFIG', 'Pinned GCP production spool directory required.');
    }
    return parsed;
  };
  if (resend) {
    console.log(JSON.stringify(await resendGcpBackupPair({
      config: await loadConfig(),
      file,
      receiptFile,
      shouldAbort: () => interrupted,
    })));
    return;
  }
  const result = await runMonitoredBackup({
    status: createStatusStore({ directory: PINNED_CONTROL_DIR }),
    execute: async onRecovered => {
      const config = await loadConfig();
      if (interrupted) throw failure('GCP_BACKUP_INTERRUPTED', 'Backup interrupted.');
      return runGcpScheduledBackup({
        config,
        onRecovered,
        shouldAbort: () => interrupted,
        runCoordinator: async () => {
          const { stdout } = await run(
            process.execPath,
            [resolve(import.meta.dirname, 'coordinated-worker-backup.mjs'), configPath, '--authorise-service-pause'],
            { maxBuffer: 32768 },
          );
          return JSON.parse(stdout);
        },
      });
    },
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({
      code: error?.code === 'BACKUP_STATUS_FAILED' ? 'BACKUP_STATUS_FAILED' : 'BACKUP_RUN_FAILED',
      ...(error?.perDest ? { perDest: error.perDest, statusEvent: error.statusEvent, stage: error.stage, mode: error.mode } : {}),
      message: 'GCP backup delivery failed; check service, admission and protected local diagnostics. No restore verification is claimed.',
    }));
    process.exitCode = 1;
  });
}
