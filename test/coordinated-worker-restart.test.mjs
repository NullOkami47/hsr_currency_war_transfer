import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, unlink, lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { JsonWorkerJobStore, TransferJobQueue, createWorkerHandler } from '../src/worker.mjs';
import { JsonTransferStore } from '../src/store.mjs';
import { coordinatedRestart, parseRestartArguments } from '../scripts/infrastructure/coordinated-worker-restart.mjs';
import { createRestartJournal, stateProof, assertPreserved, readRestartState } from '../scripts/infrastructure/restart-control-state.mjs';
import { assertServicePolicy, assertProcessEvidence, verifySharedLock, assertRestartLocks, waitForAuthenticatedHealth, assertUnitContract } from '../scripts/infrastructure/restart-linux.mjs';

// Disk, stores, queue, HTTP authentication and durable journal are real. Only the
// systemd boundary is synthetic; it never calls a real service or cloud API.
const now = Date.parse('2026-11-15T12:00:00Z');
const token = 'synthetic-maintenance-token-123456789';
async function fixture(t, enabled = true) {
  const root = await mkdtemp(join(process.platform === 'win32' ? 'D:/CodexWork/' : tmpdir(), 'hsr-restart-test-'));
  t.after(async () => {
    const actual = await realpath(root); const parent = resolve(process.platform === 'win32' ? 'D:/CodexWork/' : tmpdir());
    assert.ok(actual.startsWith(parent + (process.platform === 'win32' ? '\\' : '/') + 'hsr-restart-test-'));
    assert.equal((await lstat(actual)).isSymbolicLink(), false); await rm(actual, { recursive: true });
  });
  const paths = { jobs: join(root, 'jobs.json'), transfers: join(root, 'transfers.json'), security: join(root, 'jobs.json.security.json') };
  const directory = join(root, 'maintenance'); await mkdir(directory, { mode: 0o700 });
  const backupDirectory = join(root, 'backup'); await mkdir(backupDirectory, { mode: 0o700 });
  await writeFile(join(backupDirectory, 'journal.json'), JSON.stringify({ version: 1, service: 'synthetic.service', originalAdmission: true, phase: 'complete', runId: 'backup-run', updatedAt: new Date(now).toISOString() }), { mode: 0o600 });
  await writeFile(paths.transfers, JSON.stringify({ version: 1, transfers: { a: { globalId: 'mapping-preserved', verificationPending: false } } }), { mode: 0o600 });
  await writeFile(paths.security, JSON.stringify({ version: 1, requests: { submit: { count: 2, resetAt: now + 60000, clients: { privateClient: 2 } } }, sessions: { ['s'.repeat(32)]: now + 3600000 } }), { mode: 0o600 });
  const store = new JsonWorkerJobStore(paths.jobs, { now: () => new Date(now) }); await store.initialise({ publicSubmissionsEnabled: enabled });
  const transfers = new JsonTransferStore(paths.transfers);
  let replay = 0;
  let queue = new TransferJobQueue({ store, transferFn: async () => { replay++; return { status: 'created' }; }, now: () => new Date(now) });
  const server = createServer(createWorkerHandler({ queue, store, token })); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', body) {
    const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error('Authenticated request failed'); return response.json();
  }
  let running = true, starts = 0, stops = 0, held = false, admissionMutations = 0, admissionHook = async () => {};
  let identity = 'original-publisher'; let sleepHook = async () => {}; let startHook = async () => {}; let healthHook = async () => {};
  const journal = createRestartJournal({ directory, service: 'synthetic.service' });
  const ops = {
    journal,
    acquire: async () => { if (held) throw new Error('Shared backup lock collision'); held = true; }, release: async () => { held = false; },
    checkBackup: () => journal.checkBackup(backupDirectory),
    contract: async () => 'pinned-unchanged-service-preflight',
    observe: async () => ({ running, identity }),
    assertRunning: async expected => { if (!running || (expected && expected.identity !== identity)) throw new Error('Ambiguous publisher identity'); return { running, identity }; },
    dashboard: () => request('/admin'),
    setAdmission: async value => {
      const j = JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8'));
      assert.equal(typeof j.originalAdmission, 'boolean', 'original policy durable before mutation');
      admissionMutations++; await request('/admin', 'PUT', { publicSubmissionsEnabled: value }); await admissionHook(value);
    },
    state: () => readRestartState(paths),
    stop: async () => { stops++; running = false; },
    assertStopped: async () => { if (running) throw new Error('Publisher still live'); },
    preflight: async () => { const state = await readRestartState(paths); stateProof(state, now); },
    start: async () => { starts++; await startHook(); if (running) throw new Error('Duplicate publisher'); running = true; identity = 'new-publisher'; queue = new TransferJobQueue({ store, transferFn: async () => { replay++; }, now: () => new Date(now) }); await queue.start(); },
    health: async () => { await healthHook(); assert.deepEqual(await request('/health'), { status: 'ok' }); await request('/admin'); },
    sleep: () => sleepHook(), now: () => now,
  };
  return { root, paths, directory, backupDirectory, store, transfers, ops, request,
    run: args => coordinatedRestart({ operations: ops, authorised: true, maxPolls: 3, ...args }),
    counts: () => ({ starts, stops, replay, admissionMutations }),
    record: async () => JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')),
    setSleep: hook => { sleepHook = hook; }, setStart: hook => { startHook = hook; }, setHealth: hook => { healthHook = hook; },
    setAdmissionHook: hook => { admissionHook = hook; },
    collide: () => { held = true; },
  };
}

for (const enabled of [true, false]) test(`restart preserves original admission=${enabled}, jobs, mappings and security without replay`, async t => {
  const f = await fixture(t, enabled);
  const { job } = await f.store.createOrGetActive('a'.repeat(24)); await f.store.update(job.id, { status: 'completed', result: { globalId: 'retained' } });
  const security = await readFile(f.paths.security, 'utf8'); const mappings = await readFile(f.paths.transfers, 'utf8');
  const result = await f.run();
  assert.equal(result.phase, 'complete'); assert.equal((await f.request('/admin')).settings.publicSubmissionsEnabled, enabled);
  assert.equal(await readFile(f.paths.security, 'utf8'), security); assert.equal(await readFile(f.paths.transfers, 'utf8'), mappings);
  assert.deepEqual(f.counts(), { starts: 1, stops: 1, replay: 0, admissionMutations: 2 });
  const j = await f.record(); assert.equal(j.originalAdmission, enabled); assert.equal(j.startAttempts, 1);
  const serialised = JSON.stringify(j); for (const secret of [token, 'privateClient', 'mapping-preserved', job.id]) assert.ok(!serialised.includes(secret));
});

test('active job drains to terminal durable state before the single stop and start', async t => {
  const f = await fixture(t); const { job } = await f.store.createOrGetActive('b'.repeat(24));
  f.setSleep(async () => { assert.equal(f.counts().stops, 0); await f.store.update(job.id, { status: 'completed' }); });
  await f.run(); assert.equal(f.counts().starts, 1); assert.equal(f.counts().replay, 0);
});
test('bounded busy drain safely restores original admission without a stop', async t => {
  const f = await fixture(t); await f.store.createOrGetActive('b'.repeat(24));
  await assert.rejects(f.run(), /drain/i); assert.equal(f.counts().stops, 0); assert.equal((await f.request('/admin')).settings.publicSubmissionsEnabled, true);
  assert.equal((await f.record()).outcome, 'aborted_before_stop'); assert.equal((await f.record()).phase, 'complete');
});
test('lying dashboard cannot hide durable running jobs or pending transfer markers', async t => {
  for (const kind of ['job', 'pending']) {
    const f = await fixture(t); if (kind === 'job') await f.store.createOrGetActive('c'.repeat(24));
    else await f.transfers.set('a', { verificationPending: true, globalId: 'published-but-uncertain' });
    const real = f.ops.dashboard; f.ops.dashboard = async () => { const d = await real(); d.stats.queued = 0; d.stats.running = 0; return d; };
    await assert.rejects(f.run(), /active|pending|dashboard/i); assert.equal(f.counts().stops, 0); assert.equal(f.counts().starts, 0);
  }
});
test('shutdown crash never starts or automatically reopens and explicit recovery refuses live owner', async t => {
  const f = await fixture(t); f.ops.stop = async () => { throw new Error('shutdown crash'); };
  await assert.rejects(f.run(), /shutdown crash/); await assert.rejects(f.run({ recover: true }), /live|stopp|reconcil/i);
  assert.equal(f.counts().starts, 0); assert.equal((await f.request('/admin')).settings.publicSubmissionsEnabled, false);
});
test('live and stale transfer/Chrome lock files all fail closed, including terminated-owner stale case', async t => {
  for (const name of ['transfers.json.lock', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', '.readonly-owner', '.readonly-session-lock']) {
    const f = await fixture(t); const lock = join(f.root, name);
    const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); assert.equal(ended.status, 0);
    await writeFile(lock, ended.stdout);
    f.ops.assertStopped = () => assertRestartLocks([lock]);
    await assert.rejects(f.run(), /lock/); await assert.rejects(f.run({ recover: true }), /lock/);
    assert.equal(f.counts().starts, 0); assert.equal(await readFile(lock, 'utf8'), ended.stdout);
    await writeFile(lock, String(process.pid)); await assert.rejects(assertRestartLocks([lock]), /lock/);
  }
});
test('known stopped checkpoint can recover once; changed state cannot', async t => {
  const f = await fixture(t); const preflight = f.ops.preflight; f.ops.preflight = async () => { throw new Error('preflight unavailable'); };
  await assert.rejects(f.run(), /preflight/); assert.equal((await f.record()).phase, 'stopped');
  f.ops.preflight = preflight; await f.run({ recover: true }); assert.equal(f.counts().starts, 1);
  const g = await fixture(t); g.ops.preflight = async () => { throw new Error('preflight unavailable'); }; await assert.rejects(g.run());
  await g.transfers.set('a', { globalId: 'changed' }); await assert.rejects(g.run({ recover: true }), /changed|preserv/i); assert.equal(g.counts().starts, 0);
});
test('definitely ended startup permits one new explicitly authorised recovery attempt', async t => {
  const f = await fixture(t); f.setStart(async () => { throw new Error('startup failure'); });
  await assert.rejects(f.run(), /startup/); assert.equal(f.counts().starts, 1); assert.equal((await f.record()).phase, 'starting');
  f.setStart(async () => {}); await f.run({ recover: true }); assert.equal(f.counts().starts, 2); assert.equal((await f.record()).startAttempts, 2);
});
test('failed-start terminal proof survives a failed recovery preflight for the next explicit recovery', async t => {
  const f = await fixture(t); f.setStart(async () => { throw new Error('startup failure'); }); await assert.rejects(f.run(), /startup/);
  const stopped = f.ops.assertStopped;
  f.ops.assertStopped = async (original, options) => { assert.equal(options.allowFailedStart, true, 'failed/failed requires retained terminal evidence'); await stopped(original); };
  const preflight = f.ops.preflight; f.ops.preflight = async () => { throw new Error('temporary preflight failure'); };
  await assert.rejects(f.run({ recover: true }), /preflight/); assert.equal((await f.record()).phase, 'stopped'); assert.equal(f.counts().starts, 1);
  f.ops.preflight = preflight; f.setStart(async () => {}); await f.run({ recover: true });
  assert.equal((await f.record()).phase, 'complete'); assert.equal(f.counts().starts, 2);
});
test('read-only authenticated readiness tolerates initial ECONNREFUSED with one start only', async t => {
  const f = await fixture(t); let requests = 0, pauses = 0;
  f.ops.health = () => waitForAuthenticatedHealth({
    request: async path => { requests++; if (requests <= 2) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); return f.request(path); },
    sleep: async () => { pauses++; },
  });
  await f.run(); assert.equal(requests, 4); assert.equal(pauses, 2); assert.equal(f.counts().starts, 1);
});
test('authenticated readiness is bounded and never changes admission or repeats start on exhaustion', async t => {
  const f = await fixture(t); let requests = 0, pauses = 0;
  f.ops.health = () => waitForAuthenticatedHealth({ request: async () => { requests++; throw new Error('ECONNREFUSED'); }, maxAttempts: 3, sleep: async () => { pauses++; } });
  await assert.rejects(f.run(), /readiness/); assert.equal(requests, 3); assert.equal(pauses, 2);
  assert.equal(f.counts().starts, 1); assert.equal(f.counts().admissionMutations, 1); assert.equal((await f.record()).phase, 'started');
});
test('explicit recovery never retries startup while the first outcome or processes are ambiguous', async t => {
  const f = await fixture(t); f.setStart(async () => { throw new Error('start timeout'); }); await assert.rejects(f.run());
  f.ops.assertStopped = async () => { throw new Error('Ambiguous outstanding start job or Chrome owner'); };
  await assert.rejects(f.run({ recover: true }), /Ambiguous/); assert.equal(f.counts().starts, 1);
});
test('pre-stop abort never overwrites changed policy, uncertain admission, or controller interruption', async t => {
  for (const failure of ['policy', 'admission', 'interruption', 'health']) {
    const f = await fixture(t); await f.store.createOrGetActive('d'.repeat(24)); let aborted = false;
    f.setSleep(async () => {
      if (failure === 'policy') await f.store.updateSettings({ dailyAccountQuota: 99 });
      if (failure === 'admission') await f.store.updateSettings({ publicSubmissionsEnabled: true });
      if (failure === 'interruption') aborted = true;
    });
    if (failure === 'health') f.setHealth(async () => { throw new Error('unhealthy'); });
    await assert.rejects(f.run({ shouldAbort: () => aborted }));
    assert.equal(f.counts().admissionMutations, 1); assert.notEqual((await f.record()).phase, 'complete');
  }
});
test('drain failure abort preserves original false admission too', async t => {
  const f = await fixture(t, false); await f.store.createOrGetActive('e'.repeat(24)); await assert.rejects(f.run(), /drain/i);
  assert.equal((await f.request('/admin')).settings.publicSubmissionsEnabled, false); assert.equal((await f.record()).phase, 'complete');
});
test('owner can explicitly recover an interrupted drain by restoring original admission without stopping', async t => {
  const f = await fixture(t); await f.store.createOrGetActive('f'.repeat(24)); let interrupt = false;
  f.setSleep(async () => { interrupt = true; }); await assert.rejects(f.run({ shouldAbort: () => interrupt }), /interrupted/);
  assert.equal((await f.request('/admin')).settings.publicSubmissionsEnabled, false);
  await f.run({ recover: true }); assert.equal((await f.request('/admin')).settings.publicSubmissionsEnabled, true);
  assert.equal((await f.record()).outcome, 'recovered_before_stop'); assert.equal(f.counts().stops, 0); assert.equal(f.counts().starts, 0);
});
test('health failure after known start recovers same publisher without a second start', async t => {
  const f = await fixture(t); f.setHealth(async () => { throw new Error('health unavailable'); });
  await assert.rejects(f.run(), /health/); assert.equal((await f.record()).phase, 'started');
  f.setHealth(async () => {}); await f.run({ recover: true }); assert.equal(f.counts().starts, 1);
});
test('reopen checkpoint is durable and accepted jobs after admission restore do not strand recovery', async t => {
  const f = await fixture(t); let accepted;
  f.setAdmissionHook(async enabled => {
    if (!enabled) return;
    const record = await f.record(); assert.equal(record.phase, 'restoring'); assert.equal(record.verified.admission, false); assert.equal(record.verified.active, 0);
    accepted = await f.store.createOrGetActive('9'.repeat(24));
  });
  await f.run(); assert.equal((await f.record()).phase, 'complete'); assert.equal((await f.store.get(accepted.job.id)).status, 'queued');
  assert.equal(f.counts().starts, 1); assert.equal(f.counts().stops, 1); assert.equal(f.counts().replay, 0);
});
test('explicit recovery completes interrupted restoring after new jobs arrive without stop or replay', async t => {
  const f = await fixture(t); let crash = true;
  f.setAdmissionHook(async enabled => {
    if (!enabled || !crash) return; crash = false; await f.store.createOrGetActive('8'.repeat(24)); throw new Error('controller lost acknowledgement after open');
  });
  await assert.rejects(f.run(), /acknowledgement/); assert.equal((await f.record()).phase, 'restoring');
  const count = f.counts(); await f.run({ recover: true }); assert.equal((await f.record()).phase, 'complete');
  assert.equal(f.counts().starts, count.starts); assert.equal(f.counts().stops, count.stops); assert.equal(f.counts().admissionMutations, count.admissionMutations); assert.equal(f.counts().replay, 0);
});
test('original false restoring recovery refuses changed durable state and pending verification', async t => {
  for (const drift of ['pending', 'security']) {
    const f = await fixture(t, false);
    f.setAdmissionHook(async () => { if ((await f.record()).phase === 'restoring') throw new Error('interrupted restoring'); });
    await assert.rejects(f.run(), /interrupted restoring/);
    const counts = f.counts();
    if (drift === 'pending') await f.transfers.set('a', { verificationPending: true });
    else await writeFile(f.paths.security, JSON.stringify({ version: 1, requests: {}, sessions: {} }), { mode: 0o600 });
    await assert.rejects(f.run({ recover: true }), /pending|changed/i);
    assert.equal((await f.record()).phase, 'restoring'); assert.deepEqual(f.counts(), counts);
  }
});
test('original true restoring recovery verifies closed state before any reopen PUT', async t => {
  const f = await fixture(t); const phase = f.ops.journal.phase;
  f.ops.journal.phase = async (...args) => { const record = await phase(...args); if (args[0] === 'restoring') throw new Error('interrupted before reopen'); return record; };
  await assert.rejects(f.run(), /interrupted before reopen/); f.ops.journal.phase = phase;
  await f.transfers.set('a', { verificationPending: true }); const counts = f.counts();
  await assert.rejects(f.run({ recover: true }), /pending/i); assert.deepEqual(f.counts(), counts);
  assert.equal((await f.request('/admin')).settings.publicSubmissionsEnabled, false);
});
test('backup collision and unfinished backup journal block every mutation without falsifying backup status', async t => {
  const f = await fixture(t); f.collide(); await assert.rejects(f.run(), /collision/); assert.equal(f.counts().admissionMutations, 0);
  const g = await fixture(t); const file = join(g.backupDirectory, 'journal.json'); const value = JSON.parse(await readFile(file, 'utf8')); value.phase = 'starting'; await writeFile(file, JSON.stringify(value));
  const before = await readFile(file, 'utf8'); await assert.rejects(g.run(), /backup/i); assert.equal(await readFile(file, 'utf8'), before); assert.equal(g.counts().admissionMutations, 0);
});
test('inspection and absent authority are nondisruptive, including unfinished maintenance journal', async t => {
  const f = await fixture(t); await f.run({ inspect: true, authorised: false }); assert.deepEqual(f.counts(), { starts: 0, stops: 0, replay: 0, admissionMutations: 0 });
  await assert.rejects(readFile(join(f.directory, 'journal.json')), { code: 'ENOENT' });
  await assert.rejects(f.run({ authorised: false }), /authoris/i);
});
test('CLI rejects recovery without explicit authority, unknown flags and duplicate flags', () => {
  assert.deepEqual(parseRestartArguments([]), { inspect: true });
  assert.deepEqual(parseRestartArguments(['--recover', '--authorise-controlled-restart']), { recover: true, authorised: true });
  for (const args of [['--recover'], ['--authorise-controlled-restart', '--authorise-controlled-restart'], ['--inspect', '--recover'], ['--force'], ['--authorise-controlled-restart', '--force']]) assert.throws(() => parseRestartArguments(args));
});
test('tampered journal and changed durable evidence block explicit failed-start recovery', async t => {
  const f = await fixture(t); f.setStart(async () => { throw new Error('startup failure'); }); await assert.rejects(f.run());
  await f.transfers.set('a', { globalId: 'unauthorised-drift' }); await assert.rejects(f.run({ recover: true }), /changed|preserv/); assert.equal(f.counts().starts, 1);
  const g = await fixture(t); await writeFile(join(g.directory, 'journal.json'), '{malformed'); await assert.rejects(g.run()); assert.equal(g.counts().admissionMutations, 0);
});
test('malformed and missing state cannot substitute empty history', async t => {
  const f = await fixture(t); await writeFile(f.paths.jobs, '{}'); await assert.rejects(f.run(), /Invalid durable/); assert.equal(f.counts().admissionMutations, 0);
  const g = await fixture(t); await unlink(g.paths.security); await assert.rejects(g.run(), { code: 'ENOENT' }); assert.equal(g.counts().admissionMutations, 0);
});
test('journal write failure prevents closing and unfinished journal requires explicit recover', async t => {
  const f = await fixture(t); f.ops.journal.begin = async () => { throw new Error('durability failed'); };
  await assert.rejects(f.run(), /durability/); assert.equal(f.counts().admissionMutations, 0);
  const g = await fixture(t); g.ops.stop = async () => { throw new Error('shutdown crash'); }; await assert.rejects(g.run());
  await assert.rejects(g.run(), /unfinished|recover/i); assert.equal(g.counts().admissionMutations, 1);
});
test('journal binds original admission to initial state and requires closed baseline', async t => {
  const f = await fixture(t); const initial = stateProof(await f.ops.state(), now);
  await assert.rejects(f.ops.journal.begin({ contract: 'test', originalProcess: { identity: 'owner' }, initial, originalAdmission: false }), /original admission/i);
  await f.ops.journal.begin({ contract: 'test', originalProcess: { identity: 'owner' }, initial });
  await assert.rejects(f.ops.journal.phase('drained', { baseline: { admission: true } }), /closed baseline/i);
  const file = join(f.directory, 'journal.json'); const record = await f.record(); record.originalAdmission = false;
  await writeFile(file, JSON.stringify(record)); await assert.rejects(f.ops.journal.read(), /original admission/i);
});
test('state proof permits only expired quota removal, rejects quota reset/addition, jobs/security/mapping/settings changes', async t => {
  const f = await fixture(t, false); const raw = await f.ops.state(); raw.jobs.quota = { blockedUntil: 5, events: [{ at: now - 86400001, clientKey: 'expired' }, { at: now, clientKey: 'live' }] };
  const proof = stateProof(raw, now); const expired = structuredClone(raw); expired.jobs.quota.events.shift(); assertPreserved(proof, stateProof(expired, now), now);
  for (const mutate of [s => { s.jobs.quota.events = []; }, s => { s.jobs.quota.blockedUntil = 0; }, s => { s.jobs.quota.events.push({ at: now, clientKey: 'extra' }); }, s => { s.security.sessions = {}; }, s => { s.transfers.transfers = {}; }, s => { s.jobs.settings.dailyAccountQuota++; }, s => { s.jobs.jobs.x = { status: 'completed' }; }]) {
    const bad = structuredClone(raw); mutate(bad); assert.throws(() => assertPreserved(proof, stateProof(bad, now), now), /changed|preserv|quota|job/i);
  }
});
test('reopened admission or service/preflight drift is never overwritten', async t => {
  const f = await fixture(t); f.setHealth(async () => { await f.store.updateSettings({ publicSubmissionsEnabled: true }); });
  await assert.rejects(f.run(), /admission|changed/i); assert.equal((await f.record()).phase, 'started');
  const g = await fixture(t); let reads = 0; g.ops.contract = async () => ++reads === 1 ? 'original' : 'changed';
  await assert.rejects(g.run(), /contract|changed/i); assert.equal(g.counts().starts, 0);
});

test('Linux policy and process checks reject escalation, duplicate publisher and surviving Chrome', () => {
  const policy = { LoadState: 'loaded', KillMode: 'mixed', SendSIGKILL: 'no', KillSignal: '15', RestartKillSignal: '15', NeedDaemonReload: 'no', TimeoutStopUSec: '4min', Restart: 'no', User: 'hsr-worker', Group: 'hsr-worker', WorkingDirectory: '/opt/hsr-transfer-worker-staging',
    ExecStart: '{ path=/usr/bin/flock ; argv[]=/usr/bin/flock --no-fork --nonblock --conflict-exit-code 75 /var/lib/hsr-transfer-worker-staging/login/.production-worker.flock /opt/node-v24.22.3-linux-x64/bin/node /opt/hsr-transfer-worker-staging/scripts/worker-server.mjs ; ignore_errors=no ; }',
    ExecStartPre: '{ path=/opt/node-v24.22.3-linux-x64/bin/node ; argv[]=/opt/node-v24.22.3-linux-x64/bin/node /opt/hsr-transfer-worker-staging/scripts/infrastructure/gcp-production-profile-preflight.mjs /etc/hsr-gcp-production/worker-preflight.json ; ignore_errors=no ; }', ExecStartPost: '', ExecStop: '', ExecStopPost: '' };
  assert.doesNotThrow(() => assertServicePolicy(policy));
  for (const patch of [{ KillMode: 'control-group' }, { SendSIGKILL: 'yes' }, { KillSignal: '9' }, { RestartKillSignal: '9' }, { NeedDaemonReload: 'yes' }, { KillSignal: undefined }, { RestartKillSignal: undefined }, { NeedDaemonReload: undefined }, { TimeoutStopUSec: '90s' }, { Restart: 'always' },
    { ExecStop: '{ path=/bin/kill ; argv[]=/bin/kill -9 $MAINPID ; }' }, { ExecStopPost: '{ path=/bin/rm ; argv[]=/bin/rm -rf /tmp/profile ; }' },
    { ExecStartPost: '{ path=/usr/bin/touch ; argv[]=/usr/bin/touch /tmp/started ; }' },
    { ExecStartPre: policy.ExecStartPre + ' { path=/bin/true ; argv[]=/bin/true ; }' }, { ExecStart: policy.ExecStart + ' { path=/bin/true ; argv[]=/bin/true ; }' }]) assert.throws(() => assertServicePolicy({ ...policy, ...patch }));
  const unit = { ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0', Result: 'success' };
  assert.doesNotThrow(() => assertProcessEvidence({ unit, processes: [], cgroupPids: [], stopped: true }));
  for (const processes of [[{ pid: 42, args: ['/opt/chrome/chrome'] }], [{ pid: 43, args: ['node', '/opt/hsr-transfer-worker-staging/scripts/worker-server.mjs'] }]]) assert.throws(() => assertProcessEvidence({ unit, processes, cgroupPids: [], stopped: true }), /live|process|publisher/i);
  assert.throws(() => assertProcessEvidence({ unit, processes: [], cgroupPids: [99], stopped: true }), /cgroup/i);
  const active = { ActiveState: 'active', SubState: 'running', MainPID: '42', ControlPID: '0' };
  const worker = { pid: 42, args: ['node', '/opt/hsr-transfer-worker-staging/scripts/worker-server.mjs'] };
  assert.doesNotThrow(() => assertProcessEvidence({ unit: active, processes: [worker], cgroupPids: [42], stopped: false }));
  assert.throws(() => assertProcessEvidence({ unit: active, processes: [worker, { ...worker, pid: 43 }], cgroupPids: [42, 43], stopped: false }), /publisher/);
  assert.throws(() => assertProcessEvidence({ unit: { ...unit, ActiveState: 'activating', Job: '123/start' }, processes: [], cgroupPids: [], stopped: true, allowFailedStart: true }), /terminal/);
});
test('raw unit contract rejects unapproved stop or startup policy before trusting the current unit', () => {
  for (const text of ['[Service]\nExecStop=/bin/kill -9 $MAINPID\n', '[Service]\nTimeoutStartSec=1\n', '[Service]\nExecStartPre=/bin/true\n']) assert.throws(() => assertUnitContract(text), /contract changed/);
});

test('real Linux flock rejects missing inherited lock and collides with backup holder', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hsr-restart-flock-')); const file = join(root, 'shared'); await writeFile(file, '', { mode: 0o600 });
  t.after(() => rm(root, { recursive: true }));
  await assert.rejects(verifySharedLock({ path: file, fd: 9 }));
  const module = resolve('scripts/infrastructure/restart-linux.mjs');
  const child = `import {verifySharedLock} from ${JSON.stringify('file://' + module)}; await verifySharedLock({path:process.argv[1],fd:9});`;
  const result = spawnSync('/bin/sh', ['-c', 'exec 9<>"$1"; /usr/bin/flock -n 9; "$2" --input-type=module -e "$3" "$1"; /usr/bin/flock -n -E 75 "$1" /usr/bin/true; test "$?" = 75', 'test', file, process.execPath, child], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
