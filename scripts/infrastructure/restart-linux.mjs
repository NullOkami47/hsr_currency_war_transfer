import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, stat, readFile, readlink, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRestartJournal, readRestartFile, readRestartState, stateProof, digest } from './restart-control-state.mjs';

const run = promisify(execFile);
export const SERVICE = 'hsr-worker-production.service';
const SOURCE = '/opt/hsr-transfer-worker-staging';
const NODE = '/opt/node-v24.22.3-linux-x64/bin/node';
const BACKUP_LOCK = '/run/hsr-worker-backup.flock';
const PUBLISHER_LOCK = '/var/lib/hsr-transfer-worker-staging/login/.production-worker.flock';
const STATE = '/var/lib/hsr-transfer-worker-production';
const PROFILE = '/var/lib/hsr-transfer-worker-staging/login/gcp-readonly-profile-login-20261112';
const PREFLIGHT = SOURCE + '/scripts/infrastructure/gcp-production-profile-preflight.mjs';
const PREFLIGHT_CONFIG = '/etc/hsr-gcp-production/worker-preflight.json';
const PREFLIGHT_SHA = '4d8fac701742e667874ea4c9358e842fd2463d4d0831ebbc93c85f3f9008de63';
const ENVIRONMENT = '/etc/hsr-gcp-production/worker.env';
const fail = message => { throw new Error(message); };
const properties = text => Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const sha = text => createHash('sha256').update(text).digest('hex');
const WRITER = /(?:^|\/)(?:worker-server|transfer|adopt-mapping|connector-login|gcp-login-readonly|gcp-login-startup-gate)\.mjs$/;
const chrome = p => p.args.some(a => /(?:^|\/)(?:chrome(?:-headless-shell)?|chromium(?:-browser)?|chrome_crashpad_handler)$/.test(a));
const writer = p => p.args.some(a => WRITER.test(a));
const publisher = p => p.args.includes(SOURCE + '/scripts/worker-server.mjs');

export function assertServicePolicy(unit) {
  if (unit.LoadState !== 'loaded' || unit.KillMode !== 'mixed' || unit.SendSIGKILL !== 'no'
      || !['4min', '240s', '240000000'].includes(unit.TimeoutStopUSec) || unit.Restart !== 'no'
      || unit.User !== 'hsr-worker' || unit.WorkingDirectory !== SOURCE) fail('Unsafe service stop/start policy');
}
export function assertProcessEvidence({ unit, processes, cgroupPids, stopped, original, allowFailedStart = false }) {
  if (stopped) {
    const inactive = unit.ActiveState === 'inactive' && unit.SubState === 'dead' && unit.Result === 'success';
    const endedStart = allowFailedStart && (unit.ActiveState === 'failed' && unit.SubState === 'failed' || unit.ActiveState === 'inactive' && unit.SubState === 'dead');
    if ((!inactive && !endedStart) || unit.MainPID !== '0' || unit.ControlPID !== '0' || unit.Job) fail('Service stop/start outcome is not definitely terminal');
    if (cgroupPids.length) fail('Live service cgroup processes remain');
    if (processes.some(p => writer(p) || chrome(p))) fail('Live publisher, Chrome or writer process remains');
    if (original?.processes?.some(p => processes.some(x => x.pid === p.pid && x.start === p.start))) fail('Original owner process still live');
    return;
  }
  const workers = processes.filter(writer); const owner = workers.find(p => publisher(p) && String(p.pid) === unit.MainPID);
  if (unit.ActiveState !== 'active' || unit.SubState !== 'running' || unit.ControlPID !== '0' || unit.Job || workers.length !== 1 || !owner
      || !cgroupPids.includes(owner.pid) || processes.filter(chrome).some(p => !cgroupPids.includes(p.pid))) fail('Ambiguous live publisher/process ownership');
}
export async function verifySharedLock({ path = BACKUP_LOCK, fd = 9 } = {}) {
  if (process.platform !== 'linux') fail('Linux kernel flock evidence required');
  const target = await lstat(path); const inherited = await stat(`/proc/self/fd/${fd}`);
  if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || target.uid !== process.getuid() || target.mode & 0o077
      || target.dev !== inherited.dev || target.ino !== inherited.ino || await realpath('/run') !== '/run') fail('Shared flock file/descriptor mismatch');
  const info = await readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
  if (!/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\S+\s+\S+\s+0\s+EOF\s*$/m.test(info)) fail('Inherited exclusive kernel flock required, not an environment assertion');
}

async function absent(path) {
  try { await lstat(path); fail('Live or stale lock requires manual reconciliation'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function assertRestartLocks(paths) {
  for (const path of paths) await absent(path);
}
async function processes() {
  const result = [];
  for (const id of (await readdir('/proc')).filter(n => /^\d+$/.test(n))) {
    try {
      const args = (await readFile(`/proc/${id}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const raw = await readFile(`/proc/${id}/stat`, 'utf8'); const start = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
      const status = await readFile(`/proc/${id}/status`, 'utf8'); const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      result.push({ pid: Number(id), start, args, uid });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return result;
}
async function cgroupPids() {
  const root = '/sys/fs/cgroup/system.slice/' + SERVICE;
  async function visit(directory) {
    const pids = (await readFile(join(directory, 'cgroup.procs'), 'utf8')).split(/\s+/).filter(Boolean).map(Number);
    for (const item of await readdir(directory, { withFileTypes: true })) if (item.isDirectory()) pids.push(...await visit(join(directory, item.name)));
    return pids;
  }
  try { return await visit(root); } catch (error) { if (error.code === 'ENOENT' && !await lstat(root).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e))) return []; throw error; }
}
async function ownedPublisherFlock(pid) {
  const lock = await lstat(PUBLISHER_LOCK);
  if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1) fail('Invalid publisher flock file');
  for (const fd of await readdir(`/proc/${pid}/fdinfo`)) {
    try {
      const target = await stat(`/proc/${pid}/fd/${fd}`);
      if (target.ino === lock.ino && target.dev === lock.dev && /^lock:.*FLOCK\s+ADVISORY\s+WRITE\s+/m.test(await readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))) return;
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  fail('Publisher does not own its required kernel flock');
}

export async function createLinuxRestartOperations() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.execPath !== NODE) fail('Linux root and pinned Node binary required');
  await verifySharedLock();
  const { stdout: uidText } = await run('/usr/bin/id', ['-u', 'hsr-worker'], { timeout: 5000 });
  const uid = Number(uidText.trim()); if (!Number.isInteger(uid) || uid <= 0) fail('Non-root worker owner required');
  const paths = { jobs: STATE + '/jobs.json', transfers: STATE + '/transfers.json', security: STATE + '/jobs.json.security.json' };
  const environmentText = await readRestartFile(ENVIRONMENT, { owner: 0, maximum: 65536 });
  const env = {};
  for (const line of environmentText.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (!match || Object.hasOwn(env, match[1])) fail('Unsupported environment syntax');
    let value = match[2].trim(); if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  const token = env.CURRENCY_WAR_WORKER_TOKEN;
  if (!token || !/^[\x21-\x7e]{24,256}$/.test(token) || env.CURRENCY_WAR_STATE_PATH !== paths.transfers
      || env.CURRENCY_WAR_JOB_STATE_PATH !== paths.jobs || env.CURRENCY_WAR_PROFILE_DIR !== PROFILE
      || (env.CURRENCY_WAR_WORKER_HOST ?? '127.0.0.1') !== '127.0.0.1' || (env.CURRENCY_WAR_WORKER_PORT ?? '8787') !== '8787') fail('Pinned state/profile/loopback environment required');
  async function request(path, method = 'GET', body) {
    const response = await fetch('http://127.0.0.1:8787' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) fail('Authenticated maintenance request failed');
    const text = await response.text(); if (text.length > 8 * 1024 * 1024) fail('Unbounded worker response'); return JSON.parse(text);
  }
  const show = async () => properties((await run('/usr/bin/systemctl', ['show', SERVICE, '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Result,Job,ControlGroup,InvocationID,KillMode,SendSIGKILL,TimeoutStopUSec,Restart,User,Group,WorkingDirectory,ExecStart,ExecStartPre,EnvironmentFiles'], { timeout: 10000, maxBuffer: 65536 })).stdout);
  async function contract() {
    await verifySharedLock(); const unit = await show(); assertServicePolicy(unit);
    if (unit.ControlGroup && unit.ControlGroup !== '/system.slice/' + SERVICE) fail('Unexpected service cgroup');
    const expectedStart = `/usr/bin/flock --no-fork --nonblock --conflict-exit-code 75 ${PUBLISHER_LOCK} ${NODE} ${SOURCE}/scripts/worker-server.mjs`;
    const expectedPreflight = `${NODE} ${PREFLIGHT} ${PREFLIGHT_CONFIG}`;
    const argv = value => value?.match(/argv\[\]=(.*?)\s*;/)?.[1];
    if (argv(unit.ExecStart) !== expectedStart || argv(unit.ExecStartPre) !== expectedPreflight
        || unit.Group !== 'hsr-worker' || unit.EnvironmentFiles !== `${ENVIRONMENT} (ignore_errors=no)`) fail('Service entrypoint/preflight/environment changed');
    const preflightText = await readRestartFile(PREFLIGHT, { owner: 0, privateMode: false });
    if (sha(preflightText) !== PREFLIGHT_SHA) fail('Strict deployed preflight changed');
    const configText = await readRestartFile(PREFLIGHT_CONFIG, { owner: 0, privateMode: false, maximum: 16384 });
    const config = JSON.parse(configText);
    if (digest(config) !== digest({ version: 1, project: 'hsr-currency-war-worker', zone: 'us-central1-a', instance: 'hsr-worker-standby', instanceId: '4111188809525812699', nodeBinary: NODE, stateDirectory: STATE, profileDirectory: PROFILE })) fail('Strict preflight configuration changed');
    return digest({ cat: (await run('/usr/bin/systemctl', ['cat', SERVICE], { timeout: 10000, maxBuffer: 131072 })).stdout,
      preflight: sha(preflightText), config: sha(configText), environment: sha(await readRestartFile(ENVIRONMENT, { owner: 0, maximum: 65536 })) });
  }
  async function observation(stopped, original, options = {}) {
    const unit = await show(); assertServicePolicy(unit); const procs = await processes(); const group = await cgroupPids();
    assertProcessEvidence({ unit, processes: procs, cgroupPids: group, stopped, original, allowFailedStart: options.allowFailedStart });
    if (stopped) {
      await assertRestartLocks([paths.transfers + '.lock', PROFILE + '/SingletonLock', PROFILE + '/SingletonSocket', PROFILE + '/SingletonCookie', PROFILE + '/.readonly-owner', '/var/lib/hsr-transfer-worker-staging/login/.readonly-session-lock']);
      await run('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', PUBLISHER_LOCK, '/usr/bin/true'], { timeout: 5000 });
      return { stopped: true, outcome: unit.ActiveState + '/' + unit.SubState, result: unit.Result };
    }
    const owner = procs.find(p => String(p.pid) === unit.MainPID);
    if (owner.uid !== uid || await readlink(`/proc/${owner.pid}/exe`) !== NODE || procs.filter(chrome).some(p => p.uid !== uid)) fail('Publisher/Chrome uid or pinned executable mismatch');
    await ownedPublisherFlock(owner.pid);
    const identity = { boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), invocation: unit.InvocationID,
      processes: procs.filter(p => group.includes(p.pid)).map(p => ({ pid: p.pid, start: p.start })).sort((a, b) => a.pid - b.pid), mainPid: owner.pid, start: owner.start };
    if (!identity.invocation) fail('Missing publisher invocation identity');
    return { running: true, identity: digest({ boot: identity.boot, invocation: identity.invocation, pid: owner.pid, start: owner.start }), ...identity };
  }
  const journal = createRestartJournal({ directory: '/var/lib/hsr-worker-maintenance-control', service: SERVICE });
  return {
    journal, acquire: () => verifySharedLock(), release: async () => {}, checkBackup: () => journal.checkBackup('/var/lib/hsr-worker-backup-control'), contract,
    observe: async () => { const unit = await show(); return { active: unit.ActiveState, sub: unit.SubState, mainPid: Number(unit.MainPID) }; },
    assertRunning: async expected => { const observed = await observation(false); if (expected && observed.identity !== expected.identity) fail('Publisher identity changed'); return observed; },
    assertStopped: (original, options) => observation(true, original, options),
    dashboard: () => request('/admin'), setAdmission: enabled => request('/admin', 'PUT', { publicSubmissionsEnabled: enabled }),
    state: () => readRestartState(paths, uid),
    stop: () => run('/usr/bin/systemctl', ['stop', SERVICE], { timeout: 510000, maxBuffer: 65536 }),
    start: () => run('/usr/bin/systemctl', ['start', SERVICE], { timeout: 30000, maxBuffer: 65536 }),
    preflight: async () => { stateProof(await readRestartState(paths, uid)); /* systemd alone invokes the unchanged non-root ExecStartPre. */ },
    health: async () => { const health = await request('/health'); if (health.status !== 'ok') fail('Worker unhealthy'); await request('/admin'); },
    sleep: () => new Promise(r => setTimeout(r, 1000)), now: () => Date.now(),
  };
}
