import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertIdle, assertVmIdentity } from './gcp-login-readonly.mjs';

export const PINNED_PROJECT = 'hsr-currency-war-worker';
export const PINNED_ZONE = 'us-central1-a';
export const PINNED_INSTANCE = 'hsr-worker-standby';
export const PINNED_INSTANCE_ID = '4111188809525812699';
export const PINNED_NODE_BINARY = '/opt/node-v24.22.3-linux-x64/bin/node';
export const PINNED_STATE_DIR = '/var/lib/hsr-transfer-worker-production';
export const PINNED_PROFILE_DIR = '/var/lib/hsr-transfer-worker-staging/login/gcp-readonly-profile-login-20261112';

const CONFIG_KEYS = ['version', 'project', 'zone', 'instance', 'instanceId', 'nodeBinary', 'stateDirectory', 'profileDirectory'];
const CHROME_LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
const MAX_CONFIG_BYTES = 16384;
const MAX_RECEIPT_BYTES = 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_FS = { lstat, realpath, open };

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function readBoundedFile(filePath, maxBytes, { platform, uid, fs, allowRootGroupRead = false, code = 'PREFLIGHT_STATE' }) {
  const before = await fs.lstat(filePath).catch(() => fail(code, 'Required regular file is missing or unreadable.'));
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) {
    fail(code, 'Bounded regular file required.');
  }
  if (platform === 'linux') {
    if (before.nlink !== 1) fail(code, 'Hardlinked state or configuration files are forbidden.');
    if (allowRootGroupRead) {
      if (![0, uid].includes(before.uid) || (before.mode & 0o027) !== 0) {
        fail('PREFLIGHT_PERMS', 'Protected configuration file permissions required.');
      }
    } else if (before.uid !== uid || (before.mode & 0o077) !== 0) {
      fail('PREFLIGHT_PERMS', 'Private owner-only file permissions required.');
    }
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK);
  const handle = await fs.open(filePath, flags).catch(() => fail(code, 'Failed to open regular file safely.'));
  const buffer = Buffer.alloc(maxBytes + 1);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameStat(before, stat)) fail(code, 'File changed during bounded read.');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await fs.lstat(filePath);
    if (offset > maxBytes || offset !== before.size || after.isSymbolicLink()
        || !sameStat(before, after) || !sameStat(before, await handle.stat())) {
      fail(code, 'File drifted or exceeded size limit during bounded read.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch (error) {
    if (error.code?.startsWith('PREFLIGHT_')) throw error;
    fail(code, 'Invalid UTF-8 file contents.');
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}

async function verifyPrivateDirectory(dirPath, { platform, uid, fs, code = 'PREFLIGHT_PATH' }) {
  const st = await fs.lstat(dirPath).catch(() => fail(code, 'Required directory is missing.'));
  if (!st.isDirectory() || st.isSymbolicLink()) fail(code, 'Non-symlink directory required.');
  const actual = await fs.realpath(dirPath).catch(() => fail(code, 'Cannot resolve directory realpath.'));
  if (actual !== dirPath) fail(code, 'Symlinked ancestor directory is forbidden.');
  if (platform === 'linux' && (st.uid !== uid || (st.mode & 0o077) !== 0)) {
    fail('PREFLIGHT_PERMS', 'Private owner-only directory permissions required.');
  }
}

async function assertAbsent(filePath, code, fs) {
  let exists = true;
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') exists = false;
    else fail(code, 'Unable to verify lock absence.');
  }
  if (exists) fail(code, 'Active lock or ownership marker requires manual inspection.');
}

function parseJsonObject(text, code) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(code, 'Invalid JSON document.');
  }
  if (!isPlainObject(parsed)) fail(code, 'Expected a JSON object.');
  return parsed;
}

/**
 * Validates the non-secret production preflight configuration against pinned GCP identities.
 */
export function validatePreflightConfig(config) {
  const invalid = () => fail('PREFLIGHT_CONFIG', 'Only the exact pinned production preflight configuration is accepted.');
  if (!isPlainObject(config) || Object.keys(config).sort().join() !== [...CONFIG_KEYS].sort().join()) invalid();
  if (config.version !== 1
      || config.project !== PINNED_PROJECT
      || config.zone !== PINNED_ZONE
      || config.instance !== PINNED_INSTANCE
      || config.instanceId !== PINNED_INSTANCE_ID
      || config.nodeBinary !== PINNED_NODE_BINARY
      || config.stateDirectory !== PINNED_STATE_DIR
      || config.profileDirectory !== PINNED_PROFILE_DIR) {
    invalid();
  }
  return Object.freeze({ ...config });
}

/**
 * Verifies non-root runtime, pinned VM identity, worker/Chrome idleness, profile ownership,
 * absence of locks, and quiescent three-file production state before starting the worker.
 */
export async function verifyProductionProfileAndState({
  config: rawConfig,
  platform = process.platform,
  getuid = () => process.getuid?.(),
  execPath = process.execPath,
  checkNodeBinary = true,
  checkIdentity,
  checkIdle,
  now = () => new Date(),
  fsOps = DEFAULT_FS,
} = {}) {
  const config = validatePreflightConfig(rawConfig);
  const uid = getuid();
  if (platform === 'linux') {
    if (!Number.isInteger(uid) || uid <= 0) {
      fail('PREFLIGHT_USER', 'Production worker preflight must run as non-root hsr-worker.');
    }
    if (checkNodeBinary !== false && execPath !== PINNED_NODE_BINARY) {
      fail('PREFLIGHT_RUNTIME', 'Production worker must run on the pinned Node 24 executable.');
    }
  }

  const identityCheck = checkIdentity ?? (() => assertVmIdentity({
    project: config.project,
    zone: config.zone,
    instance: config.instance,
    approvedTarget: { instanceId: config.instanceId },
  }));
  try {
    await identityCheck(config);
  } catch (error) {
    if (error.code?.startsWith('PREFLIGHT_')) throw error;
    fail('PREFLIGHT_IDENTITY', 'GCP VM identity verification failed.');
  }

  const idleCheck = checkIdle ?? (() => assertIdle());
  try {
    await idleCheck();
  } catch (error) {
    if (error.code?.startsWith('PREFLIGHT_')) throw error;
    fail('PREFLIGHT_IDLE', 'Another worker, login session, or browser process is active.');
  }

  const profileParent = posix.dirname(config.profileDirectory);
  await verifyPrivateDirectory(profileParent, { platform, uid, fs: fsOps, code: 'PREFLIGHT_PROFILE' });
  await verifyPrivateDirectory(config.profileDirectory, { platform, uid, fs: fsOps, code: 'PREFLIGHT_PROFILE' });

  await assertAbsent(posix.join(profileParent, '.readonly-session-lock'), 'PREFLIGHT_LOCK_ACTIVE', fsOps);
  await assertAbsent(posix.join(config.profileDirectory, '.readonly-owner'), 'PREFLIGHT_LOCK_ACTIVE', fsOps);
  for (const chromeLock of CHROME_LOCKS) {
    await assertAbsent(posix.join(config.profileDirectory, chromeLock), 'PREFLIGHT_CHROME_LOCK_ACTIVE', fsOps);
  }

  const receiptText = await readBoundedFile(posix.join(config.profileDirectory, '.readonly-vm.json'), MAX_RECEIPT_BYTES, {
    platform, uid, fs: fsOps, code: 'PREFLIGHT_PROFILE_RECEIPT',
  });
  const receipt = parseJsonObject(receiptText, 'PREFLIGHT_PROFILE_RECEIPT');
  if (receipt.project !== config.project
      || receipt.instanceId !== config.instanceId
      || receipt.profileName !== posix.basename(config.profileDirectory)) {
    fail('PREFLIGHT_PROFILE_RECEIPT', 'Profile receipt does not match this pinned VM and directory.');
  }

  await verifyPrivateDirectory(config.stateDirectory, { platform, uid, fs: fsOps, code: 'PREFLIGHT_STATE' });
  await assertAbsent(posix.join(config.stateDirectory, 'transfers.json.lock'), 'PREFLIGHT_TRANSFER_LOCK_ACTIVE', fsOps);

  const transfers = parseJsonObject(
    await readBoundedFile(posix.join(config.stateDirectory, 'transfers.json'), MAX_STATE_BYTES, {
      platform, uid, fs: fsOps, code: 'PREFLIGHT_STATE',
    }),
    'PREFLIGHT_STATE',
  );
  if (transfers.version !== 1 || !isPlainObject(transfers.transfers)) {
    fail('PREFLIGHT_STATE', 'Invalid production transfers state schema.');
  }
  for (const record of Object.values(transfers.transfers)) {
    if (!isPlainObject(record)) fail('PREFLIGHT_STATE', 'Invalid transfer record.');
    if (record.verificationPending === true) {
      fail('PREFLIGHT_PENDING_VERIFICATION', 'Pending publication verification must be reconciled before startup.');
    }
  }

  const jobs = parseJsonObject(
    await readBoundedFile(posix.join(config.stateDirectory, 'jobs.json'), MAX_STATE_BYTES, {
      platform, uid, fs: fsOps, code: 'PREFLIGHT_STATE',
    }),
    'PREFLIGHT_STATE',
  );
  if (jobs.version !== 4 || !isPlainObject(jobs.settings) || !isPlainObject(jobs.jobs)
      || !isPlainObject(jobs.quota) || !Array.isArray(jobs.quota.events) || !Number.isFinite(jobs.quota.blockedUntil)) {
    fail('PREFLIGHT_STATE', 'Invalid production jobs state schema.');
  }
  if (jobs.settings.publicSubmissionsEnabled !== false) {
    fail('PREFLIGHT_ADMISSION_OPEN', 'Production worker must start with publicSubmissionsEnabled=false until verified.');
  }
  for (const job of Object.values(jobs.jobs)) {
    if (!isPlainObject(job) || !['completed', 'failed'].includes(job.status)) {
      fail('PREFLIGHT_ACTIVE_JOBS', 'Active or ambiguous jobs must be drained/reconciled before startup.');
    }
  }

  const security = parseJsonObject(
    await readBoundedFile(posix.join(config.stateDirectory, 'jobs.json.security.json'), MAX_STATE_BYTES, {
      platform, uid, fs: fsOps, code: 'PREFLIGHT_STATE',
    }),
    'PREFLIGHT_STATE',
  );
  if (security.version !== 1 || !isPlainObject(security.requests) || !isPlainObject(security.sessions)) {
    fail('PREFLIGHT_STATE', 'Invalid production security state schema.');
  }

  return {
    ok: true,
    checkedAt: now().toISOString(),
    instanceId: config.instanceId,
    profileVerified: true,
    stateVerified: true,
    publicSubmissionsEnabled: false,
  };
}

export function parsePreflightArguments(args) {
  if (Array.isArray(args)) {
    if (args.length === 2 && args[0] === 'validate' && typeof args[1] === 'string' && args[1] && !args[1].startsWith('-')) {
      return { command: 'validate', configPath: args[1] };
    }
    if (args.length === 1 && typeof args[0] === 'string' && args[0] && !args[0].startsWith('-')) {
      return { command: 'verify', configPath: args[0] };
    }
  }
  fail('PREFLIGHT_ARGUMENTS', 'Usage: <preflight-config.json> OR validate <preflight-config.json>.');
}

async function main() {
  const args = parsePreflightArguments(process.argv.slice(2));
  const configPath = resolve(args.configPath);
  const raw = await readBoundedFile(configPath, MAX_CONFIG_BYTES, {
    platform: process.platform,
    uid: process.getuid?.(),
    fs: DEFAULT_FS,
    allowRootGroupRead: true,
    code: 'PREFLIGHT_CONFIG',
  });
  const parsed = parseJsonObject(raw, 'PREFLIGHT_CONFIG');
  if (args.command === 'validate') {
    const validated = validatePreflightConfig(parsed);
    console.log(JSON.stringify({ ok: true, schemaValid: true, instanceId: validated.instanceId, nodeBinary: validated.nodeBinary }));
    return;
  }
  const result = await verifyProductionProfileAndState({ config: parsed });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = typeof error?.code === 'string' && error.code.startsWith('PREFLIGHT_') ? error.code : 'PREFLIGHT_FAILED';
    console.error(JSON.stringify({ ok: false, code, message: 'Production profile/state preflight failed.' }));
    process.exitCode = 1;
  });
}
