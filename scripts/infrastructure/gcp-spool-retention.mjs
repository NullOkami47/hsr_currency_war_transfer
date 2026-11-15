import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeBackupRetention } from './backup-retention.mjs';

// Local-only extraction of azure-backup-retention.mjs's fd-anchored spool adapter.
// No Azure runtime, cloud client, private key, publisher control or lock acquisition.
// CLI: node gcp-spool-retention.mjs /etc/hsr-gcp-production/backup.json
//      /etc/hsr-gcp-production/restore-baseline.json [--apply] [--pin-namespace=gcp]
// Feed the successful scheduled uploader's JSON on stdin, still inside its flock.
// Without --apply this is a dry-run. Cloud pin translation is never inferred.
const ROOT = '/var/lib/hsr-worker-backups-gcp-production', LOCK = '/run/hsr-worker-backup.flock';
const CONFIG = '/etc/hsr-gcp-production/backup.json', ETC = '/etc/hsr-gcp-production';
const CONTROL = '/var/lib/hsr-worker-backup-control', SERVICE = 'hsr-worker-production.service';
const PREFIX = 'hsr-state/', CLOUD_PREFIX = 'gcp-production/hsr-state/';
const EVENTS = 'gcp-production/monitor/events/', BUCKET = 'hsr-worker-backups-282550645630';
const FORMAT = 'hsr-worker-backup/v1', MAX_ARCHIVE = 64 * 1024 * 1024, JSON_LIMIT = 16384;
const WEEK = 7 * 86400000, FRESH = 36 * 3600000;
const NAME = /^hsr-state\/hsr-state-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.(enc|receipt)\.json$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join() === expected.split(',').sort().join();
const check = condition => { if (!condition) throw new Error('GCP spool retention safety check failed.'); };
const signalCheck = signal => check(signal instanceof AbortSignal && !signal.aborted);
const identity = st => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const localVersion = st => ({ etag: `"${hash(identity(st))}"` });

function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
  const time = Date.parse(value);
  check(Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === value);
  return time;
}
function nameTime(name) {
  check(typeof name === 'string'); const match = NAME.exec(name); check(match);
  return timestamp(match[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
}

/** Trust only the separately protected external restore attestation; never auto-adopt a receipt. */
export function normaliseGcpSpoolBaseline(value, namespace = 'local') {
  check(namespace === 'local' || namespace === 'gcp');
  check(keys(value, 'archiveName,bytes,createdAt,format,recipient,restoreVerifiedAt,sha256,verification'));
  check(value.format === FORMAT && value.verification === 'external-gcm-restore/v1'
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && typeof value.recipient === 'string' && /^[a-f0-9]{64}$/.test(value.recipient)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX_ARCHIVE);
  const created = timestamp(value.createdAt), verified = timestamp(value.restoreVerifiedAt);
  const expected = `hsr-state-${value.createdAt.replace(/[:.]/g, '-')}.enc.json`;
  check(value.archiveName === (namespace === 'gcp' ? CLOUD_PREFIX : PREFIX) + expected && verified >= created);
  // Explicit namespace-only alias; hashes, byte count, recipient and restore time are unchanged.
  return Object.freeze({ ...value, archiveName: PREFIX + expected });
}

function configuration(value) {
  check(keys(value, 'service,endpoint,environmentFile,publicKeyPath,backupDirectory,paths,gcs,azureSecondary')
    && value.service === SERVICE && value.endpoint === 'http://127.0.0.1:8787/'
    && value.environmentFile === ETC + '/worker.env' && value.publicKeyPath === ETC + '/recipient-public.pem'
    && value.backupDirectory === ROOT && keys(value.paths, 'transfers,jobs,security')
    && value.paths.transfers === '/var/lib/hsr-transfer-worker-production/transfers.json'
    && value.paths.jobs === '/var/lib/hsr-transfer-worker-production/jobs.json'
    && value.paths.security === '/var/lib/hsr-transfer-worker-production/jobs.json.security.json'
    && keys(value.gcs, 'enabled,bucket,archivePrefix,eventPrefix') && value.gcs.enabled === true
    && value.gcs.bucket === BUCKET && value.gcs.archivePrefix === CLOUD_PREFIX && value.gcs.eventPrefix === EVENTS
    && keys(value.azureSecondary, 'enabled') && value.azureSecondary.enabled === false);
}

function successfulUpload(value, time) {
  check(keys(value, 'transportVerified,restoreVerified,createdAt,sha256,bucket,objectPrefix,mode,perDest,statusEvent')
    && value.mode === 'scheduled' && value.transportVerified === true && value.restoreVerified === false
    && value.bucket === BUCKET && value.objectPrefix === CLOUD_PREFIX && /^[a-f0-9]{64}$/.test(value.sha256)
    && keys(value.perDest, 'azure,gcs'));
  for (const name of ['azure', 'gcs']) {
    const state = value.perDest[name], ok = name === 'gcs';
    check(keys(state, 'status,transportVerified,restoreVerified') && state.status === (ok ? 'success' : 'skipped')
      && state.transportVerified === ok && state.restoreVerified === false);
  }
  check(keys(value.statusEvent, 'status,transportVerified,object') && value.statusEvent.status === 'success'
    && value.statusEvent.transportVerified === true && typeof value.statusEvent.object === 'string');
  const event = /^gcp-production\/monitor\/events\/(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.exec(value.statusEvent.object);
  check(event);
  const created = timestamp(value.createdAt);
  const eventAt = timestamp(event[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
  check(created <= eventAt && eventAt <= time && time - created <= FRESH);
  return Object.freeze({ archiveName: PREFIX + `hsr-state-${value.createdAt.replace(/[:.]/g, '-')}.enc.json`,
    sha256: value.sha256, created, eventAt });
}

function privateFile(st, maximum = MAX_ARCHIVE) {
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0n && (st.mode & 0o7777n) === 0o600n
    && st.nlink === 1n && st.size > 0n && st.size <= BigInt(maximum));
}
async function directory(io, path, privateMode = false) {
  const st = await io.lstat(path, { bigint: true });
  check(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0n
    && (privateMode ? (st.mode & 0o7777n) === 0o700n : !(st.mode & 0o022n))
    && await io.realpath(path) === path);
  return st;
}
async function boundedRead(handle, maximum, signal) {
  const chunks = []; let bytes = 0;
  while (true) {
    signalCheck(signal); const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - bytes));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) return Buffer.concat(chunks);
    bytes += bytesRead; check(bytes <= maximum); chunks.push(chunk.subarray(0, bytesRead));
  }
}
async function protectedJson(io, path) {
  check(path === CONTROL + '/status.json' || path === CONTROL + '/journal.json'
    || path.startsWith(ETC + '/') && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(path.slice(ETC.length + 1)));
  for (const parent of path.startsWith(CONTROL + '/') ? ['/var', '/var/lib', CONTROL] : ['/etc', ETC]) {
    await directory(io, parent, parent === CONTROL);
  }
  const before = await io.lstat(path, { bigint: true }); privateFile(before, JSON_LIMIT);
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = await handle.stat({ bigint: true }); privateFile(held, JSON_LIMIT); check(identity(held) === identity(before));
    const bytes = await boundedRead(handle, JSON_LIMIT, new AbortController().signal);
    const after = await io.lstat(path, { bigint: true }); privateFile(after, JSON_LIMIT);
    check(identity(before) === identity(after) && identity(before) === identity(await handle.stat({ bigint: true })));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

async function rootAuthority(io) {
  check(process.platform === 'linux' && process.getuid?.() === 0 && process.env.HSR_BACKUP_FLOCK_HELD === '1');
  await directory(io, '/run');
  const st = await io.lstat(LOCK, { bigint: true });
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0n && (st.mode & 0o7777n) === 0o600n && st.nlink === 1n);
  const ancestors = new Set(); let pid = process.pid;
  for (let i = 0; i < 32 && pid > 0; i++) {
    check(!ancestors.has(pid)); ancestors.add(pid);
    const bytes = await io.readFile(`/proc/${pid}/stat`); check(Buffer.isBuffer(bytes) && bytes.length <= 8192);
    const text = bytes.toString('utf8'), parts = text.slice(text.lastIndexOf(')') + 2).split(' ');
    pid = Number(parts[1]); check(Number.isSafeInteger(pid) && pid >= 0);
  }
  const bytes = await io.readFile('/proc/locks'); check(Buffer.isBuffer(bytes) && bytes.length <= 2 * 1024 * 1024);
  const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & 0xfffff000n);
  const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & 0xffffff00n);
  check(bytes.toString('utf8').split('\n').some(line => {
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/.exec(line);
    return match && ancestors.has(Number(match[1])) && BigInt('0x' + match[2]) === major
      && BigInt('0x' + match[3]) === minor && BigInt(match[4]) === st.ino;
  }));
}

/** Linux root + existing ancestor flock only. filesystem is for isolated fixture observations. */
export async function createGcpSpoolRetentionStorage({ pinnedBaseline, successfulUpload: uploaded,
  apply = false, now = () => new Date(), filesystem: io = fs } = {}) {
  const pin = normaliseGcpSpoolBaseline(pinnedBaseline); check(typeof apply === 'boolean' && typeof now === 'function');
  let previous = -1;
  const clock = () => {
    const date = now(), time = date instanceof Date ? date.getTime() : NaN;
    check(Number.isFinite(time) && time >= previous && timestamp(pin.restoreVerifiedAt) <= time);
    previous = time; return time;
  };
  const uploadedPair = successfulUpload(uploaded, clock());
  async function spoolDirectory() {
    for (const path of ['/var', '/var/lib']) await directory(io, path);
    return directory(io, ROOT, true);
  }
  await rootAuthority(io); const initial = await spoolDirectory();
  const dir = await io.open(ROOT, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const anchored = `/proc/self/fd/${dir.fd}`;
  let closed = false, listed = new Map(), reads = new Map();
  async function authority(signal) {
    signalCheck(signal); check(!closed); clock(); await rootAuthority(io);
    const st = await spoolDirectory(), held = await dir.stat({ bigint: true });
    check(st.ino === initial.ino && st.dev === initial.dev && held.ino === initial.ino && held.dev === initial.dev);
  }
  function pathFor(name) { nameTime(name); return anchored + '/' + name.slice(PREFIX.length); }
  function entry(name, expected) {
    const item = listed.get(name); check(item && keys(expected, 'etag') && expected.etag === item.version.etag); return item;
  }
  async function read(name, expected, maximum, signal) {
    await authority(signal); const path = pathFor(name), item = entry(name, expected);
    check(Number.isSafeInteger(maximum) && maximum >= item.bytes && maximum <= MAX_ARCHIVE);
    const pathStat = await io.lstat(path, { bigint: true }); privateFile(pathStat);
    check(localVersion(pathStat).etag === item.version.etag);
    const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true }); privateFile(before); check(identity(before) === identity(pathStat));
      const body = await boundedRead(handle, maximum, signal);
      const after = await handle.stat({ bigint: true }), current = await io.lstat(path, { bigint: true });
      privateFile(after); privateFile(current);
      check(identity(before) === identity(after) && identity(before) === identity(current) && body.length === item.bytes);
      if (name === uploadedPair.archiveName) check(hash(body) === uploadedPair.sha256);
      await authority(signal); return { body, version: { ...item.version } };
    } finally { await handle.close(); }
  }
  const storage = {
    async list({ prefix, limit, signal }) {
      await authority(signal); check(prefix === PREFIX && Number.isSafeInteger(limit) && limit >= 1 && limit <= 257);
      listed = new Map(); reads = new Map(); let count = 0, newest = -1;
      for await (const item of await io.opendir(anchored)) {
        signalCheck(signal); if (++count > Math.min(limit, 256)) return { complete: false, objects: [] };
        check(!item.isSymbolicLink());
        // Unknown files (including old .enc.json/.receipt.json copies) are never opened or removed.
        if (!/^hsr-state-[^/]*\.(enc|receipt)\.json$/.test(item.name)) continue;
        const name = PREFIX + item.name; newest = Math.max(newest, nameTime(name));
        const st = await io.lstat(anchored + '/' + item.name, { bigint: true }); privateFile(st);
        listed.set(name, { name, bytes: Number(st.size), version: localVersion(st) });
      }
      check(newest === uploadedPair.created && listed.has(uploadedPair.archiveName)
        && listed.has(uploadedPair.archiveName.replace(/\.enc\.json$/, '.receipt.json')));
      await authority(signal); return { complete: true, objects: [...listed.values()].map(item => structuredClone(item)) };
    },
    async get({ name, version, maxBytes, signal }) {
      const result = await read(name, version, maxBytes, signal); reads.set(name, hash(result.body)); return result;
    },
    async delete({ name, version, signal }) {
      const deleting = () => {
        const created = nameTime(name), time = clock();
        check(apply === true && created < time - WEEK && time - uploadedPair.created <= FRESH
          && name !== pin.archiveName && name !== pin.archiveName.replace(/\.enc\.json$/, '.receipt.json')
          && name !== uploadedPair.archiveName && name !== uploadedPair.archiveName.replace(/\.enc\.json$/, '.receipt.json'));
      };
      await authority(signal); deleting(); const item = entry(name, version), priorHash = reads.get(name);
      check(typeof priorHash === 'string');
      const result = await read(name, version, item.bytes, signal); check(hash(result.body) === priorHash);
      await authority(signal); deleting();
      const path = pathFor(name), current = await io.lstat(path, { bigint: true }); privateFile(current);
      check(localVersion(current).etag === item.version.etag); signalCheck(signal);
      // POSIX unlink has no version precondition. The root-only directory and SAME
      // ancestor flock serialize cooperating writers; privileged bypass is out of scope.
      await io.unlink(path); reads.delete(name); listed.delete(name); return { deleted: true };
    },
  };
  let pending = 0, closePromise;
  const closeDirectory = () => closePromise ??= dir.close();
  return {
    async close() {
      closed = true;
      // An operation may outlive the engine's deadline. Keep its fd anchor alive
      // until it settles; never let a reused fd redirect an uncertain unlink.
      if (!pending) await closeDirectory();
    },
    ...Object.fromEntries(Object.entries(storage).map(([name, operation]) => [name, async args => {
      check(!closed); pending++;
      try { return await operation(args); }
      finally { if (--pending === 0 && closed) await closeDirectory(); }
    }])),
  };
}

/** Call only after the native scheduled uploader succeeds, inside its SAME ancestor flock. */
export async function runGcpSpoolRetention({ config, pinnedBaseline, baselineNamespace = 'local',
  successfulUpload: uploaded, apply = false, now = () => new Date(), filesystem = fs } = {}) {
  configuration(config); check(typeof apply === 'boolean');
  const pin = normaliseGcpSpoolBaseline(pinnedBaseline, baselineNamespace);
  const time = now().getTime(), proof = successfulUpload(uploaded, time); await rootAuthority(filesystem);
  const status = await protectedJson(filesystem, CONTROL + '/status.json');
  const journal = await protectedJson(filesystem, CONTROL + '/journal.json');
  check(keys(status, 'version,result,lastAttemptAt,lastSuccessAt,lastFailureAt,stage,workerHealth,transportVerified,restoreVerified')
    && status.version === 1 && status.result === 'success' && status.stage === 'complete' && status.workerHealth === 'confirmed'
    && status.transportVerified === true && status.restoreVerified === false);
  const attempt = timestamp(status.lastAttemptAt), success = timestamp(status.lastSuccessAt);
  check(attempt <= proof.created && proof.eventAt <= success && success <= time
    && (status.lastFailureAt === null || timestamp(status.lastFailureAt) <= attempt));
  check(keys(journal, 'version,runId,service,originalAdmission,phase,updatedAt') && journal.version === 1
    && journal.service === SERVICE && journal.phase === 'complete' && typeof journal.originalAdmission === 'boolean'
    && typeof journal.runId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(journal.runId)
    && timestamp(journal.updatedAt) >= proof.created && timestamp(journal.updatedAt) <= success);
  const storage = await createGcpSpoolRetentionStorage({ pinnedBaseline: pin, successfulUpload: uploaded, apply, now, filesystem });
  try { return await executeBackupRetention({ storage, pinnedBaseline: pin, apply, now }); }
  finally { await storage.close(); }
}

export function parseGcpSpoolRetentionArguments(args) {
  check(Array.isArray(args) && args.length >= 2 && args.length <= 4);
  const [configPath, pinPath, ...flags] = args;
  check(configPath === CONFIG && typeof pinPath === 'string' && pinPath.startsWith(ETC + '/')
    && pinPath !== CONFIG && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(pinPath.slice(ETC.length + 1)));
  let apply = false, baselineNamespace = 'local', namespaceSeen = false;
  for (const flag of flags) {
    if (flag === '--apply') { check(!apply); apply = true; }
    else {
      check(!namespaceSeen && ['--pin-namespace=local', '--pin-namespace=gcp'].includes(flag));
      namespaceSeen = true; baselineNamespace = flag.slice('--pin-namespace='.length);
    }
  }
  return { configPath, pinPath, apply, baselineNamespace };
}

export async function runGcpSpoolRetentionFromFiles({ configPath, pinPath, apply = false,
  baselineNamespace = 'local', filesystem = fs, ...options } = {}) {
  parseGcpSpoolRetentionArguments([configPath, pinPath, `--pin-namespace=${baselineNamespace}`, ...(apply ? ['--apply'] : [])]);
  await rootAuthority(filesystem);
  return runGcpSpoolRetention({ ...options, config: await protectedJson(filesystem, configPath),
    pinnedBaseline: await protectedJson(filesystem, pinPath), baselineNamespace, apply, filesystem });
}

async function main() {
  const args = parseGcpSpoolRetentionArguments(process.argv.slice(2)); await rootAuthority(fs);
  let interrupted = false;
  const cancel = () => { interrupted = true; process.stdin.destroy(new Error('GCP spool retention interrupted.')); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const timer = setTimeout(cancel, 120000); const chunks = []; let size = 0;
  try {
    // The wrapper first captures the successful uploader JSON, then passes it on
    // stdin here, without releasing its flock. Do not use ExecStartPost or resend.
    for await (const chunk of process.stdin) { size += chunk.length; check(size <= JSON_LIMIT); chunks.push(chunk); }
    clearTimeout(timer); check(size > 0 && !interrupted);
    const uploaded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const result = await runGcpSpoolRetentionFromFiles({ ...args, successfulUpload: uploaded,
      now: () => { check(!interrupted); return new Date(); } });
    console.log(JSON.stringify(result));
    if (!['ready', 'applied'].includes(result.status)) process.exitCode = 1;
  } finally { clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('GCP spool retention failed; inspect protected local diagnostics. No restore success is claimed.'); process.exitCode = 1;
});
