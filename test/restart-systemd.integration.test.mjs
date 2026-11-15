// Isolated Linux/systemd host only; never addresses a real worker service.
// HSR_RESTART_SYSTEMD_TEST=1 node --test test/restart-systemd.integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonWorkerJobStore, TransferJobQueue, createWorkerHandler } from '../src/worker.mjs';
import { createRestartJournal, readRestartState, digest, stateProof } from '../scripts/infrastructure/restart-control-state.mjs';
import { coordinatedRestart } from '../scripts/infrastructure/coordinated-worker-restart.mjs';
import { verifySharedLock } from '../scripts/infrastructure/restart-linux.mjs';

const run = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const token = 'synthetic-systemd-restart-token-123456';
const serviceTime = new Date('2026-11-15T12:00:00Z');
function pathsAt(root) { return { jobs: join(root, 'jobs.json'), transfers: join(root, 'transfers.json'), security: join(root, 'jobs.json.security.json') }; }
async function worker(root) {
  const store = new JsonWorkerJobStore(pathsAt(root).jobs, { now: () => serviceTime });
  const queue = new TransferJobQueue({ store, transferFn: async () => { throw new Error('Unexpected strategy replay'); } });
  await queue.start();
  const server = createServer(createWorkerHandler({ store, queue, token })); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await writeFile(join(root, 'endpoint'), String(server.address().port), { mode: 0o600 });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); server.closeIdleConnections(); });
}
async function execute(root, service, recover) {
  await verifySharedLock({ path: join(root, 'shared.flock'), fd: 9 });
  const control = args => run('/usr/bin/systemctl', [...args, service], { timeout: 30000, maxBuffer: 65536 });
  const show = async () => Object.fromEntries((await control(['show', '--property=ActiveState,SubState,MainPID,ControlPID,Result,Job,InvocationID'])).stdout.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  const pids = async () => {
    try { return (await readFile('/sys/fs/cgroup/system.slice/' + service + '/cgroup.procs', 'utf8')).split(/\s+/).filter(Boolean); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  const assertRunning = async expected => {
    const s = await show(); assert.equal(s.ActiveState, 'active'); assert.equal(s.SubState, 'running'); assert.notEqual(s.MainPID, '0'); assert.equal(s.ControlPID, '0');
    assert.deepEqual(await pids(), [s.MainPID]); const identity = s.InvocationID + ':' + s.MainPID;
    if (expected) assert.equal(expected.identity, identity); return { identity };
  };
  const journal = createRestartJournal({ directory: join(root, 'maintenance'), service });
  const request = async (path, method = 'GET', body) => {
    const port = (await readFile(join(root, 'endpoint'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.equal(response.ok, true); return response.json();
  };
  const ops = {
    journal, acquire: () => verifySharedLock({ path: join(root, 'shared.flock'), fd: 9 }), release: async () => {},
    checkBackup: () => journal.checkBackup(join(root, 'backup')),
    contract: async () => digest((await control(['cat'])).stdout), observe: show, assertRunning,
    dashboard: () => request('/admin'), setAdmission: enabled => request('/admin', 'PUT', { publicSubmissionsEnabled: enabled }),
    state: () => readRestartState(pathsAt(root)), now: () => serviceTime.getTime(), sleep: () => delay(50),
    stop: () => control(['stop']),
    assertStopped: async (_original, { allowFailedStart = false } = {}) => {
      const s = await show(); assert.equal(s.MainPID, '0'); assert.equal(s.ControlPID, '0'); assert.equal(s.Job, ''); assert.deepEqual(await pids(), []);
      assert.ok(s.ActiveState === 'inactive' && s.SubState === 'dead' || allowFailedStart && s.ActiveState === 'failed' && s.SubState === 'failed');
      const procs = (await readdir('/proc')).filter(n => /^\d+$/.test(n));
      for (const pid of procs) { try { const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'); assert.ok(!(args.includes('--fixture-worker') && args.includes(root))); } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; } }
      await run('/usr/bin/flock', ['-n', '-E', '75', join(root, 'publisher.flock'), '/usr/bin/true'], { timeout: 3000 });
    },
    preflight: async () => { stateProof(await readRestartState(pathsAt(root))); },
    start: async () => {
      await run('/usr/bin/env', ['sh', '-c', 'printf "attempt\\n" >> "$1/start-attempts"', 'fixture', root]);
      await control(['start']);
      for (let i = 0; i < 40; i++) { try { await request('/admin'); return; } catch { await delay(50); } }
      throw new Error('Synthetic service startup health timeout');
    },
    health: async () => { assert.equal((await request('/health')).status, 'ok'); await request('/admin'); },
  };
  return coordinatedRestart({ operations: ops, authorised: true, recover, maxPolls: 10 });
}

if (process.argv[2] === '--fixture-worker') {
  await worker(process.argv[3]);
} else if (process.argv[2] === '--fixture-coordinator') {
  try { console.log(JSON.stringify(await execute(process.argv[3], process.argv[4], process.argv[5] === 'recover'))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  const enabled = process.platform === 'linux' && process.env.HSR_RESTART_SYSTEMD_TEST === '1';
  for (const failedStart of [false, true]) test(`real isolated systemd coordinated restart${failedStart ? ' with explicit failed-start recovery' : ''}`, { skip: !enabled, timeout: 90000 }, async t => {
    assert.equal(process.getuid(), 0, 'Run this opt-in fixture as root in isolated systemd host');
    const root = await mkdtemp(join(tmpdir(), 'hsr-restart-systemd-')); const service = `hsr-restart-fixture-${process.pid}-${failedStart ? 'failure' : 'success'}.service`;
    const unitPath = '/run/systemd/system/' + service;
    const control = args => run('/usr/bin/systemctl', [...args, service], { timeout: 30000 });
    t.after(async () => {
      await control(['stop']).catch(() => {});
      const unit = (await control(['show', '--property=MainPID,ControlPID,ActiveState'])).stdout;
      assert.match(unit, /MainPID=0/); assert.match(unit, /ControlPID=0/); assert.match(unit, /ActiveState=(inactive|failed)/);
      await unlink(unitPath); await run('/usr/bin/systemctl', ['daemon-reload']); await control(['reset-failed']).catch(() => {});
      const actual = await realpath(root); assert.equal(actual, resolve(root)); assert.ok(actual.startsWith(resolve(tmpdir()) + '/hsr-restart-systemd-')); await rm(actual, { recursive: true });
    });
    for (const dir of ['maintenance', 'backup']) await mkdir(join(root, dir), { mode: 0o700 });
    for (const file of ['shared.flock', 'publisher.flock']) await writeFile(join(root, file), '', { mode: 0o600 });
    const store = new JsonWorkerJobStore(pathsAt(root).jobs, { now: () => serviceTime }); await store.initialise({ publicSubmissionsEnabled: true });
    const { job } = await store.createOrGetActive('a'.repeat(24)); await store.update(job.id, { status: 'completed', result: { globalId: 'never-replay' } });
    await writeFile(pathsAt(root).transfers, JSON.stringify({ version: 1, transfers: { a: { globalId: 'never-replay', verificationPending: false } } }), { mode: 0o600 });
    await writeFile(pathsAt(root).security, JSON.stringify({ version: 1, requests: {}, sessions: {} }), { mode: 0o600 });
    await writeFile(join(root, 'backup/journal.json'), JSON.stringify({ version: 1, service, runId: 'synthetic-backup', phase: 'complete', originalAdmission: true, updatedAt: serviceTime.toISOString() }), { mode: 0o600 });
    await writeFile(unitPath, `[Unit]\nDescription=Isolated synthetic restart regression\n[Service]\nType=simple\nExecStartPre=/usr/bin/test ! -f ${root}/fail-start\nExecStart=/usr/bin/flock --no-fork -n ${root}/publisher.flock ${process.execPath} ${self} --fixture-worker ${root}\nKillMode=mixed\nSendSIGKILL=no\nTimeoutStopSec=5s\nRestart=no\nUMask=0077\n`, { flag: 'wx', mode: 0o644 });
    await run('/usr/bin/systemctl', ['daemon-reload']); await control(['start']);
    for (let i = 0; i < 80; i++) { try { await lstat(join(root, 'endpoint')); break; } catch { await delay(50); } }
    const invoke = mode => run('/bin/sh', ['-c', 'exec 9<>"$1/shared.flock"; /usr/bin/flock -n 9 || exit 75; exec "$2" "$3" --fixture-coordinator "$1" "$4" "$5"', 'fixture', root, process.execPath, self, service, mode], { timeout: 60000, maxBuffer: 65536 });
    if (failedStart) {
      await writeFile(join(root, 'fail-start'), 'synthetic'); await assert.rejects(invoke('normal'));
      assert.equal(JSON.parse(await readFile(join(root, 'maintenance/journal.json'))).phase, 'starting');
      await unlink(join(root, 'fail-start')); await invoke('recover');
    } else await invoke('normal');
    assert.equal((await store.dashboard()).settings.publicSubmissionsEnabled, true);
    const journal = JSON.parse(await readFile(join(root, 'maintenance/journal.json'))); assert.equal(journal.phase, 'complete'); assert.equal(journal.startAttempts, failedStart ? 2 : 1);
    assert.equal((await readFile(join(root, 'start-attempts'), 'utf8')).trim().split('\n').length, failedStart ? 2 : 1);
    assert.equal((await store.get(job.id)).result.globalId, 'never-replay');
  });
}
