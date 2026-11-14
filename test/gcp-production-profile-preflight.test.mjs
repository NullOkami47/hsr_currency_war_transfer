import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PINNED_INSTANCE,
  PINNED_INSTANCE_ID,
  PINNED_NODE_BINARY,
  PINNED_PROFILE_DIR,
  PINNED_PROJECT,
  PINNED_STATE_DIR,
  PINNED_ZONE,
  parsePreflightArguments,
  validatePreflightConfig,
  verifyProductionProfileAndState,
} from '../scripts/infrastructure/gcp-production-profile-preflight.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/infrastructure/gcp-production-profile-preflight.mjs');

const validConfig = () => ({
  version: 1,
  project: PINNED_PROJECT,
  zone: PINNED_ZONE,
  instance: PINNED_INSTANCE,
  instanceId: PINNED_INSTANCE_ID,
  nodeBinary: PINNED_NODE_BINARY,
  stateDirectory: PINNED_STATE_DIR,
  profileDirectory: PINNED_PROFILE_DIR,
});

async function createSandboxFixture(t, { platform = process.platform, uid = 1000 } = {}) {
  await mkdir(join(root, 'var'), { recursive: true });
  const base = await mkdtemp(join(root, 'var', 'preflight-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const loginParent = join(base, 'login');
  const profileDir = join(loginParent, 'gcp-readonly-profile-login-20261112');
  const stateDir = join(base, 'state');
  await mkdir(loginParent, { recursive: true, mode: 0o700 });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  await writeFile(
    join(profileDir, '.readonly-vm.json'),
    JSON.stringify({ project: PINNED_PROJECT, instanceId: PINNED_INSTANCE_ID, profileName: posix.basename(PINNED_PROFILE_DIR) }),
    { mode: 0o600 },
  );
  await writeFile(
    join(stateDir, 'transfers.json'),
    JSON.stringify({ version: 1, transfers: { '6ae853e2267945d9413ab49e': { globalId: '6af6c58512a0abef3146dc33', sourceHash: 'abc', shareCode: 'S1' } } }),
    { mode: 0o600 },
  );
  await writeFile(
    join(stateDir, 'jobs.json'),
    JSON.stringify({
      version: 4,
      settings: { publicSubmissionsEnabled: false },
      jobs: { 'job-1': { id: 'job-1', sourceId: '6ae853e2267945d9413ab49e', status: 'completed' } },
      quota: { events: [], blockedUntil: 0 },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(stateDir, 'jobs.json.security.json'),
    JSON.stringify({ version: 1, requests: {}, sessions: {} }),
    { mode: 0o600 },
  );

  const profileParentVirtual = posix.dirname(PINNED_PROFILE_DIR);
  const mapPath = virtualPath => {
    if (virtualPath === profileParentVirtual) return loginParent;
    if (virtualPath.startsWith(profileParentVirtual + '/')) {
      return join(loginParent, ...virtualPath.slice(profileParentVirtual.length + 1).split('/'));
    }
    if (virtualPath === PINNED_STATE_DIR) return stateDir;
    if (virtualPath.startsWith(PINNED_STATE_DIR + '/')) {
      return join(stateDir, ...virtualPath.slice(PINNED_STATE_DIR.length + 1).split('/'));
    }
    return virtualPath;
  };
  const reverseMap = new Map([
    [resolve(loginParent), profileParentVirtual],
    [resolve(profileDir), PINNED_PROFILE_DIR],
    [resolve(stateDir), PINNED_STATE_DIR],
  ]);

  const fsOps = {
    async lstat(p) {
      const st = await lstat(mapPath(p));
      if (platform !== 'linux' || process.platform === 'linux') return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
        uid,
        mode: st.isDirectory() ? (constants.S_IFDIR | 0o700) : (constants.S_IFREG | 0o600),
      });
    },
    async realpath(p) {
      const resolved = await realpath(mapPath(p));
      return reverseMap.get(resolve(resolved)) ?? resolved;
    },
    async open(p, flags) {
      const handle = await open(mapPath(p), flags);
      if (platform !== 'linux' || process.platform === 'linux') return handle;
      const origStat = handle.stat.bind(handle);
      return {
        read: handle.read.bind(handle),
        close: handle.close.bind(handle),
        async stat() {
          const st = await origStat();
          return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
            uid,
            mode: constants.S_IFREG | 0o600,
          });
        },
      };
    },
  };

  return { base, loginParent, profileDir, stateDir, fsOps };
}

test('validatePreflightConfig accepts only pinned non-secret GCP production schema', () => {
  const validated = validatePreflightConfig(validConfig());
  assert.equal(validated.instanceId, PINNED_INSTANCE_ID);
  assert.equal(validated.nodeBinary, PINNED_NODE_BINARY);

  for (const patch of [
    { version: 2 },
    { project: 'other-project' },
    { zone: 'us-central1-b' },
    { instance: 'hsr-worker-other' },
    { instanceId: '9999999999' },
    { nodeBinary: '/usr/bin/node' },
    { stateDirectory: '/var/lib/hsr-transfer-worker' },
    { profileDirectory: '/var/lib/hsr-transfer-worker-production/browser-profile' },
    { token: 'SECRET_CANARY' },
    { extra: true },
  ]) {
    assert.throws(
      () => validatePreflightConfig({ ...validConfig(), ...patch }),
      error => error.code === 'PREFLIGHT_CONFIG' && !error.message.includes('SECRET_CANARY'),
    );
  }
  assert.deepEqual(parsePreflightArguments(['validate', 'cfg.json']), { command: 'validate', configPath: 'cfg.json' });
  assert.deepEqual(parsePreflightArguments(['/etc/hsr-gcp-production/worker-preflight.json']), {
    command: 'verify',
    configPath: '/etc/hsr-gcp-production/worker-preflight.json',
  });
  assert.throws(() => parsePreflightArguments(['--force']), { code: 'PREFLIGHT_ARGUMENTS' });
});

test('verifyProductionProfileAndState passes with pinned runtime, identity, clean locks and quiescent 3-file state', async t => {
  const fixture = await createSandboxFixture(t, { platform: 'linux', uid: process.getuid?.() ?? 1000 });
  const result = await verifyProductionProfileAndState({
    config: validConfig(),
    platform: 'linux',
    getuid: () => process.getuid?.() ?? 1000,
    execPath: PINNED_NODE_BINARY,
    checkIdentity: async () => {},
    checkIdle: async () => {},
    now: () => new Date('2026-11-13T18:00:00.000Z'),
    fsOps: fixture.fsOps,
  });
  assert.deepEqual(result, {
    ok: true,
    checkedAt: '2026-11-13T18:00:00.000Z',
    instanceId: PINNED_INSTANCE_ID,
    profileVerified: true,
    stateVerified: true,
    publicSubmissionsEnabled: false,
  });
});

test('preflight rejects root user, wrong Node executable, VM identity mismatch, and non-idle workers', async t => {
  const fixture = await createSandboxFixture(t, { platform: 'linux', uid: 1000 });
  const baseArgs = {
    config: validConfig(),
    platform: 'linux',
    getuid: () => 1000,
    execPath: PINNED_NODE_BINARY,
    checkIdentity: async () => {},
    checkIdle: async () => {},
    fsOps: fixture.fsOps,
  };

  await assert.rejects(() => verifyProductionProfileAndState({ ...baseArgs, getuid: () => 0 }), { code: 'PREFLIGHT_USER' });
  await assert.rejects(() => verifyProductionProfileAndState({ ...baseArgs, execPath: '/usr/bin/node' }), { code: 'PREFLIGHT_RUNTIME' });
  await assert.rejects(
    () => verifyProductionProfileAndState({ ...baseArgs, checkIdentity: async () => { throw new Error('metadata mismatch'); } }),
    { code: 'PREFLIGHT_IDENTITY' },
  );
  await assert.rejects(
    () => verifyProductionProfileAndState({ ...baseArgs, checkIdle: async () => { throw new Error('active chrome'); } }),
    { code: 'PREFLIGHT_IDLE' },
  );
});

test('preflight rejects active readonly locks, Chrome Singleton locks, and mismatched VM receipts without removing them', async t => {
  const uid = process.getuid?.() ?? 1000;
  for (const [relativePath, expectedCode] of [
    ['login/.readonly-session-lock', 'PREFLIGHT_LOCK_ACTIVE'],
    ['login/gcp-readonly-profile-login-20261112/.readonly-owner', 'PREFLIGHT_LOCK_ACTIVE'],
    ['login/gcp-readonly-profile-login-20261112/SingletonLock', 'PREFLIGHT_CHROME_LOCK_ACTIVE'],
    ['login/gcp-readonly-profile-login-20261112/SingletonSocket', 'PREFLIGHT_CHROME_LOCK_ACTIVE'],
    ['login/gcp-readonly-profile-login-20261112/SingletonCookie', 'PREFLIGHT_CHROME_LOCK_ACTIVE'],
    ['state/transfers.json.lock', 'PREFLIGHT_TRANSFER_LOCK_ACTIVE'],
  ]) {
    const fixture = await createSandboxFixture(t, { platform: 'linux', uid });
    const lockFile = join(fixture.base, ...relativePath.split('/'));
    await writeFile(lockFile, '1234\n', { mode: 0o600 });
    await assert.rejects(
      () => verifyProductionProfileAndState({
        config: validConfig(),
        platform: 'linux',
        getuid: () => uid,
        execPath: PINNED_NODE_BINARY,
        checkIdentity: async () => {},
        checkIdle: async () => {},
        fsOps: fixture.fsOps,
      }),
      { code: expectedCode },
    );
    // Lock file must NOT be deleted or adopted.
    assert.ok((await lstat(lockFile)).isFile());
  }

  const badReceipt = await createSandboxFixture(t, { platform: 'linux', uid });
  await writeFile(
    join(badReceipt.profileDir, '.readonly-vm.json'),
    JSON.stringify({ project: PINNED_PROJECT, instanceId: '000000', profileName: posix.basename(PINNED_PROFILE_DIR) }),
    { mode: 0o600 },
  );
  await assert.rejects(
    () => verifyProductionProfileAndState({
      config: validConfig(),
      platform: 'linux',
      getuid: () => uid,
      execPath: PINNED_NODE_BINARY,
      checkIdentity: async () => {},
      checkIdle: async () => {},
      fsOps: badReceipt.fsOps,
    }),
    { code: 'PREFLIGHT_PROFILE_RECEIPT' },
  );
});

test('preflight rejects pending verification, open public submissions, active jobs, or missing state files', async t => {
  const uid = process.getuid?.() ?? 1000;
  const runCheck = fixture => verifyProductionProfileAndState({
    config: validConfig(),
    platform: 'linux',
    getuid: () => uid,
    execPath: PINNED_NODE_BINARY,
    checkIdentity: async () => {},
    checkIdle: async () => {},
    fsOps: fixture.fsOps,
  });

  const fPending = await createSandboxFixture(t, { platform: 'linux', uid });
  await writeFile(
    join(fPending.stateDir, 'transfers.json'),
    JSON.stringify({ version: 1, transfers: { '6ae853e2267945d9413ab49e': { globalId: '6af6c58512a0abef3146dc33', verificationPending: true } } }),
    { mode: 0o600 },
  );
  await assert.rejects(() => runCheck(fPending), { code: 'PREFLIGHT_PENDING_VERIFICATION' });

  const fOpen = await createSandboxFixture(t, { platform: 'linux', uid });
  await writeFile(
    join(fOpen.stateDir, 'jobs.json'),
    JSON.stringify({ version: 4, settings: { publicSubmissionsEnabled: true }, jobs: {}, quota: { events: [], blockedUntil: 0 } }),
    { mode: 0o600 },
  );
  await assert.rejects(() => runCheck(fOpen), { code: 'PREFLIGHT_ADMISSION_OPEN' });

  const fQueued = await createSandboxFixture(t, { platform: 'linux', uid });
  await writeFile(
    join(fQueued.stateDir, 'jobs.json'),
    JSON.stringify({
      version: 4,
      settings: { publicSubmissionsEnabled: false },
      jobs: { 'job-1': { id: 'job-1', sourceId: '6ae853e2267945d9413ab49e', status: 'queued' } },
      quota: { events: [], blockedUntil: 0 },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(() => runCheck(fQueued), { code: 'PREFLIGHT_ACTIVE_JOBS' });

  const fMissingSec = await createSandboxFixture(t, { platform: 'linux', uid });
  await rm(join(fMissingSec.stateDir, 'jobs.json.security.json'));
  await assert.rejects(() => runCheck(fMissingSec), { code: 'PREFLIGHT_STATE' });
});

test('POSIX preflight rejects symlinked state files and loose permissions', { skip: process.platform === 'win32' }, async t => {
  const uid = process.getuid();
  const fixture = await createSandboxFixture(t, { platform: 'linux', uid });
  await chmod(join(fixture.stateDir, 'jobs.json'), 0o644);
  await assert.rejects(
    () => verifyProductionProfileAndState({
      config: validConfig(),
      platform: 'linux',
      getuid: () => uid,
      execPath: PINNED_NODE_BINARY,
      checkIdentity: async () => {},
      checkIdle: async () => {},
      fsOps: fixture.fsOps,
    }),
    { code: 'PREFLIGHT_PERMS' },
  );
  await chmod(join(fixture.stateDir, 'jobs.json'), 0o600);
  await rm(join(fixture.stateDir, 'jobs.json'));
  await symlink(join(fixture.stateDir, 'transfers.json'), join(fixture.stateDir, 'jobs.json'));
  await assert.rejects(
    () => verifyProductionProfileAndState({
      config: validConfig(),
      platform: 'linux',
      getuid: () => uid,
      execPath: PINNED_NODE_BINARY,
      checkIdentity: async () => {},
      checkIdle: async () => {},
      fsOps: fixture.fsOps,
    }),
    { code: 'PREFLIGHT_STATE' },
  );
});

test('CLI validate accepts valid config and rejects secrets or POSIX FIFO without leaking', async t => {
  await mkdir(join(root, 'var'), { recursive: true });
  const dir = await mkdtemp(join(root, 'var', 'preflight-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const cfgPath = join(dir, 'worker-preflight.json');
  await writeFile(cfgPath, JSON.stringify(validConfig()), { mode: 0o600 });
  const ok = spawnSync(process.execPath, [script, 'validate', cfgPath], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).schemaValid, true);

  const badPath = join(dir, 'bad-preflight.json');
  await writeFile(badPath, JSON.stringify({ ...validConfig(), secret: 'SECRET_CANARY_PREFLIGHT' }), { mode: 0o600 });
  const bad = spawnSync(process.execPath, [script, 'validate', badPath], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stdout + bad.stderr, /SECRET_CANARY_PREFLIGHT/);

  if (process.platform !== 'win32') {
    const fifoDir = await mkdtemp(join(tmpdir(), 'hsr-preflight-fifo-'));
    try {
      const fifo = join(fifoDir, 'preflight.fifo');
      assert.equal(spawnSync('mkfifo', ['-m', '600', fifo], { encoding: 'utf8' }).status, 0);
      const res = spawnSync(process.execPath, [script, 'validate', fifo], { encoding: 'utf8', timeout: 2000 });
      assert.equal(res.error, undefined);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /PREFLIGHT_CONFIG/);
    } finally {
      await rm(fifoDir, { recursive: true, force: true });
    }
  }
});
