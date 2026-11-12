import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { evaluateCredit } from '../scripts/infrastructure/azure-student-credit-monitor.mjs';
import * as exporter from '../scripts/infrastructure/azure-credit-export.mjs';

const subscriptionId = '11111111-1111-4111-8111-111111111111';
const now = '2026-11-12T19:15:00.000Z';
const runId = '22222222-2222-4222-8222-222222222222';
const bucket = 'hsr-worker-backups-282550645630';
const audience = '//iam.googleapis.com/projects/282550645630/locations/global/workloadIdentityPools/hsr-azure-backup/providers/azure-vm';
const object = `monitor/credit/2026-11-12T19-15-00-000Z-${runId}.json`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const unknown = () => ({ format: 'hsr-azure-student-credit-monitor/v1', report: evaluateCredit({ subscriptionId, now }), diagnostics: [{ endpoint: 'subscription-balances', status: 404, code: null }] });
const reply = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
const tokenReply = () => reply({ access_token: 'synthetic-google-secret', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', expires_in: 3600 });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'credit-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDirectory: join(root, 'state') };
}
function fakeStore({ intercept } = {}) {
  const calls = [], objects = new Map();
  const request = async (url, options) => {
    calls.push({ url, ...options });
    const override = await intercept?.(url, options);
    if (override) return override;
    const u = new URL(url);
    if (u.hostname === 'sts.googleapis.com') return tokenReply();
    assert.equal(u.hostname, 'storage.googleapis.com');
    assert.equal(options.headers.authorization, 'Bearer synthetic-google-secret');
    if (options.method === 'POST') {
      assert.equal(u.pathname, `/upload/storage/v1/b/${bucket}/o`);
      assert.equal(u.searchParams.get('uploadType'), 'media');
      assert.equal(u.searchParams.get('ifGenerationMatch'), '0');
      const name = u.searchParams.get('name');
      if (objects.has(name)) return { status: 412, body: Buffer.alloc(0) };
      objects.set(name, Buffer.from(options.body));
      return reply({});
    }
    assert.equal(options.method, 'GET');
    assert.equal(u.searchParams.get('alt'), 'media');
    const name = decodeURIComponent(u.pathname.slice(`/storage/v1/b/${bucket}/o/`.length));
    return { status: objects.has(name) ? 200 : 404, body: objects.get(name) ?? Buffer.alloc(0) };
  };
  return { calls, objects, request };
}
const options = f => ({ ...f, subscriptionId, now, runId, getManagementToken: async () => 'synthetic-management-secret', getStorageToken: async () => 'synthetic-storage-secret', collect: async () => unknown() });

test('a missing 404 balance is saved and exported through pinned STS despite warning exit 1', async t => {
  const f = await setup(t), store = fakeStore();
  const result = await exporter.exportCreditEvidence({ ...options(f), request: store.request });
  assert.equal(result.exitCode, 1);
  assert.equal(result.transportVerified, true);
  assert.equal(result.object, object);
  assert.ok(result.alertCodes.includes('CREDIT_BALANCE_UNAVAILABLE'));
  const bytes = store.objects.get(object), local = await readFile(join(f.stateDirectory, 'credit.json'));
  assert.deepEqual(bytes, local);
  const artifact = JSON.parse(bytes);
  assert.equal(artifact.report.balanceState, 'unknown');
  assert.equal(artifact.report.remainingUsd, null);
  assert.equal(artifact.report.thresholdsActive.authoritativeUsd, false);
  assert.deepEqual(artifact.diagnostics, [{ endpoint: 'subscription-balances', status: 404, code: null }]);
  assert.equal(result.sha256, sha(bytes));
  const status = JSON.parse(await readFile(join(f.stateDirectory, 'status.json')));
  assert.equal(status.transportVerified, true);
  assert.equal(status.phase, 'complete');
  assert.deepEqual(status, result);
  const form = new URLSearchParams(store.calls[0].body);
  assert.equal(store.calls[0].url, 'https://sts.googleapis.com/v1/token');
  assert.equal(form.get('audience'), audience);
  assert.equal(form.get('subject_token'), 'synthetic-storage-secret');
  assert.equal(form.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:jwt');
  assert.equal(form.get('requested_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(form.get('scope'), 'https://www.googleapis.com/auth/devstorage.read_write');
  assert.equal(store.calls[0].headers.authorization, undefined);
  assert.deepEqual(store.calls.map(c => c.method), ['POST', 'POST', 'GET']);
  assert.ok(store.calls.every(c => c.timeoutMs > 0 && c.timeoutMs <= 10000));
  assert.doesNotMatch(JSON.stringify(result) + bytes + JSON.stringify(status), /synthetic-.*secret|11111111|access_token/);
});

test('real collector receives the management token while only storage token reaches STS', async t => {
  const f = await setup(t), store = fakeStore(), managementCalls = [];
  const result = await exporter.exportCreditEvidence({ ...options(f), collect: undefined, request: store.request, managementRequest: async (path, args) => {
    managementCalls.push({ path, ...args });
    assert.equal(args.token, 'synthetic-management-secret');
    return { status: 404, body: { error: { code: '404', message: 'synthetic-private-error' } } };
  } });
  assert.equal(result.transportVerified, true);
  assert.equal(managementCalls.length, 1);
  const body = JSON.parse(store.objects.get(object));
  assert.ok(body.report.alertCodes.includes('CREDIT_BALANCE_UNAVAILABLE'));
  assert.equal(body.diagnostics[0].status, 404);
  assert.doesNotMatch(store.objects.get(object).toString(), /private|secret/);
});

test('critical credit is exported with exit 1 and healthy credit with exit 0', async t => {
  for (const [remaining, wantExit] of [[10, 1], [100, 0]]) {
    const f = await setup(t), store = fakeStore();
    const balance = { subscriptionId, source: 'azure-students-portal', currency: 'USD', remaining, asOf: now, observedAt: now, expiresAt: '2026-12-01T00:00:00Z' };
    const artifact = unknown();
    artifact.report = evaluateCredit({ subscriptionId, now, balance, costs: { subscriptionId, source: 'azure-cost-management', collectedAt: now, from: '2026-11-04T00:00:00.000Z', to: '2026-11-11T00:00:00.000Z', currency: 'USD', days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${String(i + 4).padStart(2, '0')}`, amount: 2 })) } });
    const result = await exporter.exportCreditEvidence({ ...options(f), collect: async () => artifact, request: store.request });
    assert.equal(result.exitCode, wantExit);
    assert.equal(result.transportVerified, true);
    assert.equal(store.objects.size, 1);
  }
});

test('management authentication failure still exports unavailable evidence using independent storage MI', async t => {
  const f = await setup(t), store = fakeStore();
  const result = await exporter.exportCreditEvidence({ ...options(f), getManagementToken: async () => { throw new Error('synthetic-secret'); }, request: store.request });
  assert.equal(result.exitCode, 1);
  assert.equal(result.transportVerified, true);
  const artifact = JSON.parse(store.objects.get(object));
  assert.ok(artifact.report.alertCodes.includes('CREDIT_BALANCE_UNAVAILABLE'));
  assert.ok(artifact.diagnostics.some(d => d.code === 'identity-or-auth-unavailable'));
  assert.doesNotMatch(JSON.stringify(result) + store.objects.get(object), /synthetic-secret/);
});

test('only allowlisted fields, warnings and diagnostic codes can enter the credit artifact', async t => {
  const f = await setup(t), store = fakeStore(), artifact = unknown();
  artifact.privateKey = 'PRIVATE-SECRET';
  artifact.report.token = 'TOKEN-SECRET';
  artifact.report.thresholdsActive.credentials = 'CREDENTIALS-SECRET';
  artifact.diagnostics[0].message = 'MESSAGE-SECRET';
  artifact.diagnostics.push({ endpoint: 'subscription-costs', status: 403, code: 'SENSITIVE-API-CODE' });
  const result = await exporter.exportCreditEvidence({ ...options(f), collect: async () => artifact, request: store.request });
  assert.equal(result.transportVerified, true);
  const saved = store.objects.get(object).toString();
  assert.doesNotMatch(saved, /SECRET|SENSITIVE/);
  assert.equal(JSON.parse(saved).diagnostics[1].code, 'unclassified-api-error');
});

test('foreign formats, inconsistent unknown thresholds and arbitrary payloads fail before storage identity or upload', async t => {
  for (const mutate of [a => { a.format = 'hsr-worker-backup/v1'; }, a => { a.report.remainingUsd = 0; }, a => { a.report.alertCodes = []; }, a => { a.report.thresholdsActive.authoritativeUsd = true; }, a => { a.report.warnings = ['SECRET-DATA']; }, a => { a.report.checkedAt = '2026-02-30T00:00:00.000Z'; }]) {
    const f = await setup(t), store = fakeStore(), artifact = unknown(); let storageCalls = 0;
    mutate(artifact);
    const result = await exporter.exportCreditEvidence({ ...options(f), collect: async () => artifact, getStorageToken: async () => { storageCalls++; return 'synthetic'; }, request: store.request });
    assert.equal(result.exitCode, 2);
    assert.equal(result.transportVerified, false);
    assert.equal(storageCalls, 0);
    assert.equal(store.calls.length, 0);
    assert.equal(result.code, 'CREDIT_EXPORT_SCHEMA');
  }
});

test('storage MI and STS auth failures preserve sanitized local evidence and never upload', async t => {
  for (const failure of ['storage-mi', 'sts-denied', 'bad-sts', 'expired-sts']) {
    const f = await setup(t), store = fakeStore({ intercept: url => {
      if (url !== 'https://sts.googleapis.com/v1/token') return;
      if (failure === 'sts-denied') return { status: 403, body: Buffer.from('SECRET-ERROR') };
      if (failure === 'bad-sts') return reply({ ...JSON.parse(tokenReply().body), access_token: 'bad\nSECRET' });
      if (failure === 'expired-sts') return reply({ ...JSON.parse(tokenReply().body), expires_in: 0 });
    } });
    const result = await exporter.exportCreditEvidence({ ...options(f), getStorageToken: async () => { if (failure === 'storage-mi') throw new Error('SECRET-ERROR'); return 'synthetic-storage-secret'; }, request: store.request });
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'CREDIT_EXPORT_AUTH');
    assert.equal(result.transportVerified, false);
    assert.equal(store.objects.size, 0);
    assert.ok(JSON.parse(await readFile(join(f.stateDirectory, 'credit.json'))).report.alertCodes.includes('CREDIT_BALANCE_UNAVAILABLE'));
    assert.doesNotMatch(JSON.stringify(result) + await readFile(join(f.stateDirectory, 'status.json')), /SECRET|synthetic-/);
  }
});

test('immutable collisions succeed only on exact readback; corruption and forbidden write responses fail', async t => {
  for (const mode of ['same-412', 'different-412', 'corrupt', 'redirect', 'upload-403']) {
    const f = await setup(t), store = fakeStore({ intercept: (url, o) => {
      if (new URL(url).hostname !== 'storage.googleapis.com') return;
      if (o.method === 'POST' && mode.endsWith('412')) { store.objects.set(object, mode === 'same-412' ? Buffer.from(o.body) : Buffer.from('different')); return { status: 412, body: Buffer.alloc(0) }; }
      if (o.method === 'POST' && mode === 'redirect') return { status: 302, body: Buffer.alloc(0) };
      if (o.method === 'POST' && mode === 'upload-403') return { status: 403, body: Buffer.from('SECRET') };
      if (o.method === 'GET' && mode === 'corrupt') return { status: 200, body: Buffer.from('corrupt') };
    } });
    const result = await exporter.exportCreditEvidence({ ...options(f), request: store.request });
    assert.equal(result.transportVerified, mode === 'same-412');
    assert.equal(result.exitCode, mode === 'same-412' ? 1 : 2);
    assert.ok(store.calls.every(c => !['PUT', 'PATCH', 'DELETE'].includes(c.method)));
    assert.ok(store.calls.length <= 3);
  }
});

test('absolute deadline bounds hung identity, collector and upload without retries', async t => {
  for (const stage of ['management', 'collector', 'storage', 'sts', 'upload']) {
    const f = await setup(t), store = fakeStore(), args = { ...options(f), timeoutMs: 30, request: store.request };
    const hang = () => new Promise(() => {});
    if (stage === 'management') args.getManagementToken = hang;
    if (stage === 'collector') args.collect = hang;
    if (stage === 'storage') args.getStorageToken = hang;
    if (stage === 'sts' || stage === 'upload') args.request = (url, o) => url.includes(stage === 'sts' ? 'sts.googleapis.com' : '/upload/') ? hang() : store.request(url, o);
    const start = performance.now(), result = await exporter.exportCreditEvidence(args);
    assert.ok(performance.now() - start < 2000);
    assert.equal(result.exitCode, 2);
    assert.equal(result.code, 'CREDIT_EXPORT_DEADLINE');
    assert.equal(result.transportVerified, false);
  }
});

test('invalid subscription, paths, UUID and unsafe state directory fail before authentication', async t => {
  for (const patch of [{ subscriptionId: 'bad' }, { runId: 'bad/secret' }, { stateDirectory: 'relative' }, { timeoutMs: 0 }, { now: '2026-02-30T00:00:00.000Z' }]) {
    const f = await setup(t); let calls = 0;
    const result = await exporter.exportCreditEvidence({ ...options(f), ...patch, getManagementToken: async () => { calls++; return 'token'; } });
    assert.equal(result.exitCode, 2);
    assert.equal(calls, 0);
  }
  const f = await setup(t);
  await writeFile(f.stateDirectory, 'existing-file');
  const result = await exporter.exportCreditEvidence(options(f));
  assert.equal(result.exitCode, 2);
  assert.equal(await readFile(f.stateDirectory, 'utf8'), 'existing-file');
});

test('state symlink is refused without writing outside its directory', async t => {
  const f = await setup(t);
  try { await symlink(f.root, f.stateDirectory, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') { t.skip('OS denies synthetic symlink creation'); return; } throw e; }
  const result = await exporter.exportCreditEvidence(options(f));
  assert.equal(result.exitCode, 2);
  await assert.rejects(readFile(join(f.root, 'credit.json')));
  await assert.rejects(readFile(join(f.root, 'status.json')));
});

test('default imported MI and HTTP methods use separate fixed resources with no CLI or credential files', async t => {
  const f = await setup(t), calls = []; let saved;
  const native = (url, args, callback) => {
    const parsed = new URL(String(url)), req = new EventEmitter();
    req.destroy = () => {};
    req.end = bytes => {
      calls.push({ url: parsed, ...args, body: bytes });
      let response;
      if (parsed.hostname === '169.254.169.254') {
        assert.equal(args.headers.Metadata, 'true');
        const resource = parsed.searchParams.get('resource');
        assert.ok(['https://management.azure.com/', 'https://storage.azure.com/'].includes(resource));
        response = reply({ access_token: resource.includes('management') ? 'native-management-secret' : 'native-storage-secret', token_type: 'Bearer', resource, expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
      } else if (parsed.hostname === 'management.azure.com') {
        assert.equal(args.headers.Authorization, 'Bearer native-management-secret');
        response = { status: 404, body: Buffer.from('{"error":{"code":"404","message":"native-private-secret"}}') };
      } else if (parsed.hostname === 'sts.googleapis.com') {
        assert.equal(new URLSearchParams(bytes.toString()).get('subject_token'), 'native-storage-secret');
        response = tokenReply();
      } else {
        assert.equal(parsed.hostname, 'storage.googleapis.com');
        if (args.method === 'POST') { saved = Buffer.from(bytes); response = reply({}); }
        else response = { status: 200, body: saved };
      }
      const stream = Readable.from([response.body]); stream.statusCode = response.status;
      callback(stream);
    };
    return req;
  };
  t.mock.method(http, 'request', native);
  t.mock.method(https, 'request', native);
  const result = await exporter.exportCreditEvidence({ ...f, subscriptionId, now, runId });
  assert.equal(result.transportVerified, true);
  assert.equal(result.exitCode, 1);
  assert.ok(result.alertCodes.includes('CREDIT_BALANCE_UNAVAILABLE'));
  assert.equal(calls.filter(c => c.url.hostname === '169.254.169.254').length, 2);
  assert.ok(calls.every(c => c.agent === false));
  assert.doesNotMatch(saved.toString() + JSON.stringify(result), /native-.*secret|access_token/);
});

test('oversized and malformed remote responses never claim verified delivery or retry', async t => {
  for (const endpoint of ['sts', 'upload', 'read']) {
    const f = await setup(t), store = fakeStore({ intercept: (url, o) => {
      if ((endpoint === 'sts' && url.includes('sts.googleapis.com')) || (endpoint === 'upload' && url.includes('/upload/')) || (endpoint === 'read' && o.method === 'GET')) return { status: 200, body: Buffer.alloc(65537) };
    } });
    const result = await exporter.exportCreditEvidence({ ...options(f), request: store.request });
    assert.equal(result.exitCode, 2);
    assert.equal(result.transportVerified, false);
    assert.equal(result.code, 'CREDIT_EXPORT_TRANSPORT');
    assert.ok(store.calls.length <= 3);
  }
});

test('CLI requires Linux root, accepts only subscription, writes fixed run paths and emits safe summary', async () => {
  const output = [], error = []; let invoked = 0;
  const run = async args => { invoked++; assert.equal(args.stateDirectory, '/run/hsr-credit-export'); assert.equal(args.subscriptionId, subscriptionId); return { exitCode: 1, transportVerified: true, alertCodes: ['CREDIT_BALANCE_UNAVAILABLE'] }; };
  const io = { stdout: s => output.push(s), stderr: s => error.push(s), run };
  assert.equal(await exporter.creditExportCli(['--subscription', subscriptionId], { ...io, platform: 'linux', uid: 0 }), 1);
  assert.equal(invoked, 1);
  assert.match(output[0], /CREDIT_BALANCE_UNAVAILABLE/);
  for (const args of [['--subscription', subscriptionId, '--file', 'SECRET'], ['--subscription', subscriptionId, '--subscription', subscriptionId], ['--help', 'SECRET']]) {
    assert.equal(await exporter.creditExportCli(args, { ...io, platform: 'linux', uid: 0 }), 2);
  }
  for (const platform of ['win32', 'linux']) assert.equal(await exporter.creditExportCli(['--subscription', subscriptionId], { ...io, platform, uid: 1000 }), 2);
  assert.equal(invoked, 1);
  assert.doesNotMatch(error.join(''), /SECRET/);
  assert.equal(await exporter.creditExportCli(['--help'], { ...io, platform: 'win32' }), 0);
});
