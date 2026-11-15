import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMonitorServer, createGcsStorage, createMetadataTokenProvider, boundedRequest } from '../scripts/infrastructure/cloud-backup-monitor/server.mjs';

const NOW = '2026-11-12T06:00:00.000Z';
const BASE = '2026-11-12T05:53:58.279Z';
const BUCKET = 'hsr-worker-backups-282550645630';
const PROJECT = 'hsr-currency-war-worker';
const HOUR = 3600000;
const clock = () => new Date(NOW);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const response = (value, status = 200) => ({ status, body: Buffer.from(JSON.stringify(value)) });
const stem = at => `hsr-state/hsr-state-${at.replace(/[:.]/g, '-')}`;

function pair(at) {
  const archive = Buffer.from(JSON.stringify({ format: 'hsr-worker-backup/v1',
    encryptedKey: Buffer.alloc(384, 1).toString('base64'), iv: Buffer.alloc(12, 2).toString('base64'),
    tag: Buffer.alloc(16, 3).toString('base64'), ciphertext: Buffer.from('SYNTHETIC CIPHERTEXT NEVER LOG').toString('base64') }));
  const receipt = { format: 'hsr-worker-backup/v1', createdAt: at, bytes: archive.length,
    sha256: digest(archive), recipient: 'a'.repeat(64) };
  return { archive, receipt, archiveName: stem(at) + '.enc.json', receiptName: stem(at) + '.receipt.json' };
}

function fixture({ at = BASE, event = true, status = 'success' } = {}) {
  const objects = new Map(), calls = [], logs = [], p = pair(at);
  let generation = 0;
  const put = (name, body, held = false) => objects.set(name, { name, generation: String(++generation),
    size: String(body.length), temporaryHold: held, body });
  put(p.archiveName, p.archive, at === BASE);
  put(p.receiptName, Buffer.from(JSON.stringify(p.receipt)), at === BASE);
  put('monitor/credit/2026-11-12T05-53-58-279Z-33333333-3333-4333-8333-333333333333.json',
    Buffer.from(JSON.stringify({ format: 'hsr-azure-student-credit-monitor/v1', report: {
      checkedAt: BASE, balanceState: 'known', remainingUsd: 90, severity: 'info', alertCodes: [] }, diagnostics: [] })));
  if (event) {
    const runId = '11111111-1111-4111-8111-111111111111';
    const value = { version: 1, runId, at, result: status,
      stage: status === 'success' ? 'complete' : 'delivery', mode: 'scheduled',
      perDest: { azure: { status, transportVerified: status === 'success', restoreVerified: false },
        gcs: { status: 'success', transportVerified: true, restoreVerified: false } },
      snapshot: { runStatus: status, workerHealth: 'confirmed', admission: true,
        journal: { phase: 'complete', originalAdmission: true } }, restoreVerified: false };
    put(`monitor/events/${at.replace(/[:.]/g, '-')}-${runId}.json`, Buffer.from(JSON.stringify(value)));
  }
  const env = { HSR_RETENTION_BASELINE_JSON: JSON.stringify({ ...p.receipt,
    archiveName: p.archiveName, verification: 'external-gcm-restore/v1', restoreVerifiedAt: at }) };
  const request = async (url, options = {}) => {
    const u = new URL(url);
    calls.push({ url: u, ...options });
    if (u.hostname === 'metadata.google.internal') {
      assert.equal(options.headers['Metadata-Flavor'], 'Google');
      return response({ access_token: 'SYNTHETIC_TOKEN', token_type: 'Bearer', expires_in: 3599 });
    }
    assert.equal(options.headers.authorization, 'Bearer SYNTHETIC_TOKEN');
    if (u.hostname === 'monitoring.googleapis.com') return response({});
    assert.equal(u.hostname, 'storage.googleapis.com');
    const root = `/storage/v1/b/${BUCKET}/o`;
    if (u.pathname === root) {
      const items = [...objects.values()].filter(o => o.name.startsWith(u.searchParams.get('prefix')))
        .map(({ body, ...metadata }) => metadata);
      return response({ kind: 'storage#objects', items });
    }
    const name = decodeURIComponent(u.pathname.slice(root.length + 1));
    const obj = objects.get(name);
    if (!obj) return response({}, 404);
    assert.equal(u.searchParams.get('ifGenerationMatch'), obj.generation);
    if (options.method === 'DELETE') {
      assert.equal(obj.temporaryHold, false);
      objects.delete(name);
      return { status: 204, body: Buffer.alloc(0) };
    }
    assert.equal(u.searchParams.get('generation'), obj.generation);
    if (u.searchParams.get('alt') !== 'media') {
      const { body, ...metadata } = obj;
      return response(metadata);
    }
    return { status: 200, body: Buffer.from(obj.body) };
  };
  return { p, objects, calls, logs, put, env, request };
}

async function serve(t, f, extra = {}) {
  const server = createMonitorServer({ env: f.env, request: f.request, now: clock,
    log: line => f.logs.push(JSON.parse(line)), ...extra });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('health returns no configuration and never asks metadata, storage or Monitoring', async t => {
  const f = fixture();
  const url = await serve(t, f);
  const res = await fetch(url + '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 0);
});

test('only POST /check can start work and no request body controls retention', async t => {
  const f = fixture(), url = await serve(t, f);
  for (const [method, path, expected] of [['GET', '/check', 405], ['POST', '/health', 405],
    ['POST', '/check?apply=true', 404], ['POST', '/other', 404], ['HEAD', '/health', 405]]) {
    assert.equal((await fetch(url + path, { method })).status, expected);
  }
  assert.equal(f.calls.length, 0);
  const res = await fetch(url + '/check', { method: 'POST', body: '{"apply":true}' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).retention.mode, 'dry-run');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
});

test('fresh canonical pair, real status event and dry-run produce one global INT64 heartbeat', async t => {
  const f = fixture(), url = await serve(t, f);
  const res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.state, 'healthy');
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.retention.mode, 'dry-run');
  assert.equal(result.retention.status, 'ready');
  const metrics = f.calls.filter(c => c.url.hostname === 'monitoring.googleapis.com');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].method, 'POST');
  assert.equal(metrics[0].url.href, `https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries`);
  assert.deepEqual(JSON.parse(metrics[0].body), { timeSeries: [{
    metric: { type: 'custom.googleapis.com/hsr/backup_watchdog_heartbeat' },
    resource: { type: 'global', labels: { project_id: PROJECT } },
    metricKind: 'GAUGE', valueType: 'INT64',
    points: [{ interval: { endTime: NOW }, value: { int64Value: '1794463200' } }],
  }] });
  assert.equal(f.logs.filter(l => l.event === 'hsr_backup_watchdog_heartbeat').length, 1);
  assert.equal(f.logs.find(l => l.event === 'hsr_backup_watchdog_heartbeat').checkedAt, NOW);
  assert.equal(f.logs.some(l => l.event === 'hsr_backup_alert'), false);
});

test('Azure failure alerts safely and still emits heartbeat after a completed check', async t => {
  const f = fixture({ status: 'failure' }), url = await serve(t, f);
  const res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state, 'alert');
  assert.ok(body.alerts.some(a => a.code === 'backup_failed' && a.destination === 'azure'));
  assert.ok(f.logs.some(l => l.event === 'hsr_backup_alert' && l.severity === 'ERROR'));
  assert.equal(f.logs.filter(l => l.event === 'hsr_backup_watchdog_heartbeat').length, 1);
});

test('held baseline may establish freshness before the first status event', async t => {
  const f = fixture({ event: false }), url = await serve(t, f);
  const res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state, 'healthy');
});

test('missing credit evidence alerts without suppressing a completed backup heartbeat', async t => {
  const f = fixture();
  for (const name of f.objects.keys()) if (name.startsWith('monitor/credit/')) f.objects.delete(name);
  const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).alerts.some(a => a.code === 'CREDIT_MONITOR_MISSING'));
  assert.equal(f.logs.filter(l => l.event === 'hsr_backup_watchdog_heartbeat').length, 1);
});

test('unknown credit balance and stale report alert with safe fixed codes', async t => {
  const f = fixture();
  const credit = [...f.objects.keys()].find(k => k.startsWith('monitor/credit/'));
  f.put(credit, Buffer.from(JSON.stringify({ format: 'hsr-azure-student-credit-monitor/v1', report: {
    checkedAt: '2026-11-11T04:00:00.000Z', balanceState: 'unknown', remainingUsd: null,
    alertCodes: ['CREDIT_RUNWAY_UNAVAILABLE', 'SECRET_ARBITRARY_PAYLOAD'], diagnostics: 'SECRET_DIAGNOSTIC' } })));
  const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.ok(value.alerts.some(a => a.code === 'CREDIT_BALANCE_UNAVAILABLE'));
  assert.ok(value.alerts.some(a => a.code === 'CREDIT_MONITOR_STALE'));
  assert.equal((JSON.stringify(value) + JSON.stringify(f.logs)).includes('SECRET_'), false);
});

test('a pair at 26 hours is overdue even with fresh provider status', async t => {
  const f = fixture(), url = await serve(t, f, { now: () => new Date('2026-11-13T07:53:58.279Z') });
  const res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.equal(value.state, 'alert');
  assert.ok(value.alerts.some(a => a.code === 'backup_overdue'));
});

test('missing complete pair and malformed newest event cannot report healthy', async t => {
  const f = fixture();
  f.objects.delete(f.p.receiptName);
  const event = [...f.objects.keys()].find(k => k.startsWith('monitor/events/'));
  f.put(event, Buffer.from('{"privateKey":"SECRET_VALUE"}'));
  const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state, 'alert');
  assert.equal(JSON.stringify(f.logs).includes('SECRET_VALUE'), false);
});

test('Monitoring denial returns 500 without a healthy heartbeat or upstream secrets', async t => {
  const f = fixture(), request = f.request;
  const url = await serve(t, f, { request: async (u, o) => new URL(u).hostname === 'monitoring.googleapis.com'
    ? response({ error: 'SECRET_UPSTREAM_PAYLOAD' }, 403) : request(u, o) });
  const res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.equal(f.logs.filter(l => l.event === 'hsr_backup_watchdog_heartbeat').length, 0);
  assert.ok(f.logs.some(l => l.event === 'hsr_backup_alert' && l.severity === 'ERROR' && l.code === 'heartbeat_write_failed'));
  assert.equal((body + JSON.stringify(f.logs)).includes('SECRET_UPSTREAM_PAYLOAD'), false);
});

test('storage or metadata failure is 500 and never advances the success heartbeat', async t => {
  for (const host of ['metadata.google.internal', 'storage.googleapis.com']) {
    const f = fixture(), request = f.request;
    const url = await serve(t, f, { request: async (u, o) => {
      if (new URL(u).hostname === host) throw new Error('SECRET_TOKEN_AND_CIPHERTEXT');
      return request(u, o);
    } });
    const res = await fetch(url + '/check', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.equal(f.calls.some(c => c.url.hostname === 'monitoring.googleapis.com'), false);
    assert.equal(f.logs.some(l => l.event === 'hsr_backup_watchdog_heartbeat'), false);
    assert.equal((await res.text() + JSON.stringify(f.logs)).includes('SECRET_TOKEN_AND_CIPHERTEXT'), false);
  }
});

test('HTTP result and logs exclude archive bytes, receipt identity, credentials and configuration', async t => {
  const f = fixture(), url = await serve(t, f);
  const body = await (await fetch(url + '/check', { method: 'POST' })).text();
  const visible = body + JSON.stringify(f.logs);
  for (const privateValue of ['SYNTHETIC_TOKEN', f.p.archive.toString(), 'encryptedKey', 'ciphertext',
    f.p.receipt.recipient, f.p.receipt.sha256, BUCKET, 'HSR_RETENTION_BASELINE_JSON']) {
    assert.equal(visible.includes(privateValue), false, privateValue);
  }
});

test('retention dry-run keeps old objects; only the literal env true allows generation-bound pruning', async t => {
  for (const setting of [undefined, 'false', 'TRUE', '1', 'true']) {
    const f = fixture(), old = pair('2026-11-01T05:00:00.000Z');
    f.put(old.archiveName, old.archive); f.put(old.receiptName, Buffer.from(JSON.stringify(old.receipt)));
    if (setting !== undefined) f.env.HSR_RETENTION_APPLY = setting;
    const url = await serve(t, f);
    const res = await fetch(url + '/check', { method: 'POST' });
    assert.equal(res.status, 200);
    const value = await res.json();
    assert.equal(value.retention.mode, setting === 'true' ? 'apply' : 'dry-run');
    assert.equal(f.objects.has(old.archiveName), setting !== 'true');
    assert.equal(f.objects.has(f.p.archiveName), true);
    assert.equal(f.objects.has(f.p.receiptName), true);
  }
});

test('orphan or malformed inventory blocks retention and preserves all objects', async t => {
  const f = fixture(), old = pair('2026-11-01T05:00:00.000Z');
  f.env.HSR_RETENTION_APPLY = 'true';
  f.put(old.archiveName, old.archive);
  const url = await serve(t, f);
  const res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).retention.status, 'blocked');
  assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
  assert.ok(f.objects.has(old.archiveName));
});

test('held old candidates are never deleted or released by apply', async t => {
  const f = fixture(), old = pair('2026-11-01T05:00:00.000Z');
  f.env.HSR_RETENTION_APPLY = 'true';
  f.put(old.archiveName, old.archive, true);
  f.put(old.receiptName, Buffer.from(JSON.stringify(old.receipt)), true);
  const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).retention.status, 'blocked');
  assert.equal(f.calls.some(c => c.method === 'DELETE' || c.method === 'PATCH' || c.method === 'PUT'), false);
  assert.ok(f.objects.has(old.archiveName));
});

test('checksum failure cannot be hidden by a successful latest event', async t => {
  const f = fixture();
  f.put(f.p.archiveName, Buffer.from('{"ciphertext":"SECRET_BAD_ARCHIVE"}'), true);
  const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state, 'alert');
  assert.ok(f.logs.some(l => l.code === 'backup_pair_invalid'));
  assert.equal(JSON.stringify(f.logs).includes('SECRET_BAD_ARCHIVE'), false);
});

test('a later failed event supersedes a previous successful event in listing order', async t => {
  const f = fixture();
  const firstEvent = [...f.objects.values()].find(o => o.name.startsWith('monitor/events/'));
  const newer = JSON.parse(firstEvent.body);
  newer.at = '2026-11-12T05:59:00.000Z';
  newer.runId = '22222222-2222-4222-8222-222222222222';
  newer.result = 'failure'; newer.stage = 'delivery';
  newer.perDest.gcs = { status: 'failure', transportVerified: false, restoreVerified: false };
  f.put(`monitor/events/2026-11-12T05-59-00-000Z-${newer.runId}.json`, Buffer.from(JSON.stringify(newer)));
  const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).alerts.some(a => a.code === 'backup_failed' && a.destination === 'gcs'));
});

test('concurrent checks cannot overlap retention or heartbeat writes', async t => {
  const f = fixture(), request = f.request;
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  let arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const url = await serve(t, f, { request: async (u, o) => {
    if (new URL(u).hostname === 'storage.googleapis.com') { arrived(); await gate; }
    return request(u, o);
  } });
  const first = fetch(url + '/check', { method: 'POST' });
  await waiting;
  const second = await fetch(url + '/check', { method: 'POST' });
  assert.equal(second.status, 409);
  unblock();
  assert.equal((await first).status, 200);
  assert.equal(f.logs.filter(l => l.event === 'hsr_backup_watchdog_heartbeat').length, 1);
});

test('missing or substituted baseline attestation cannot authorise deletion', async t => {
  for (const value of [undefined, '{}', '{bad', JSON.stringify({ ...fixture().p.receipt,
    archiveName: stem('2026-11-01T05:00:00.000Z') + '.enc.json',
    verification: 'external-gcm-restore/v1', restoreVerifiedAt: BASE })]) {
    const f = fixture();
    f.env.HSR_RETENTION_APPLY = 'true'; f.env.HSR_RETENTION_BASELINE_JSON = value;
    const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).retention.status, 'blocked');
    assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
  }
});

test('GCS adapter follows bounded pagination and maps generation without losing integer precision', async () => {
  const calls = [];
  const storage = createGcsStorage({ getToken: async () => 'token', request: async (u, o) => {
    const url = new URL(u); calls.push({ url, ...o });
    assert.equal(url.searchParams.get('prefix'), 'hsr-state/');
    return url.searchParams.has('pageToken') ? response({ items: [{ name: stem(BASE) + '.receipt.json', size: '12', generation: '9007199254740994' }] })
      : response({ items: [{ name: stem(BASE) + '.enc.json', size: '34', generation: '9007199254740993' }], nextPageToken: 'opaque/token' });
  } });
  const result = await storage.list({ prefix: 'hsr-state/', limit: 10 });
  assert.equal(result.complete, true);
  assert.equal(result.objects.length, 2);
  assert.equal(result.objects[0].version.generation, '9007199254740993');
  assert.equal(calls[1].url.searchParams.get('pageToken'), 'opaque/token');
});

test('GCS adapter rejects unsafe names, prefixes, missing versions and pinned deletes before authentication', async () => {
  let calls = 0;
  const storage = createGcsStorage({ getToken: async () => { calls++; return 'token'; }, request: async () => { calls++; } });
  for (const operation of [() => storage.list({ prefix: '', limit: 1 }),
    () => storage.get({ name: 'keys/private.pem', version: { generation: '1' }, maxBytes: 4096 }),
    () => storage.get({ name: stem(BASE) + '.enc.json', version: {}, maxBytes: 4096 }),
    () => storage.delete({ name: stem(BASE) + '.enc.json', version: { generation: '1' } }),
    () => storage.delete({ name: stem(BASE) + '.receipt.json', version: { generation: '1' } }),
    () => storage.delete({ name: 'monitor/events/2026-11-12.json', version: { generation: '1' } })]) {
    await assert.rejects(operation);
  }
  assert.equal(calls, 0);
});

test('GCS get pins both generation and precondition and delete never retries a 412', async () => {
  const calls = [], name = stem('2026-11-01T05:00:00.000Z') + '.enc.json';
  const storage = createGcsStorage({ getToken: async () => 'token', request: async (u, o) => {
    calls.push({ url: new URL(u), ...o });
    if (o.method === 'DELETE') return response({ secret: 'never log' }, 412);
    if (new URL(u).searchParams.get('alt') !== 'media') return response({ name, generation: '22', temporaryHold: false });
    return { status: 200, body: Buffer.from('data') };
  } });
  assert.deepEqual(await storage.get({ name, version: { generation: '22' }, maxBytes: 4 }),
    { body: Buffer.from('data'), version: { generation: '22' } });
  assert.equal(calls[0].url.searchParams.get('generation'), '22');
  assert.equal(calls[0].url.searchParams.get('ifGenerationMatch'), '22');
  await assert.rejects(() => storage.delete({ name, version: { generation: '22' } }));
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(calls[1].url.searchParams.get('ifGenerationMatch'), '22');
});

test('metadata token cache expires before credential expiry and rejects malformed credentials', async () => {
  let time = 0, calls = 0;
  const getToken = createMetadataTokenProvider({ now: () => time, request: async () => {
    calls++; return response({ access_token: `token${calls}`, token_type: 'Bearer', expires_in: 120 });
  } });
  assert.equal(await getToken(), 'token1');
  time = 59000; assert.equal(await getToken(), 'token1');
  time = 61000; assert.equal(await getToken(), 'token2');
  const invalid = createMetadataTokenProvider({ request: async () => response({ access_token: 'bad\r\nheader', expires_in: 3600, token_type: 'Bearer' }) });
  await assert.rejects(invalid);
});

test('native transport refuses redirects, oversized bodies and stalled responses', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end(''); }
    else if (req.url === '/large') res.end('12345');
    else res.writeHead(200);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await boundedRequest(base + '/redirect', { maxBytes: 4 })).status, 302);
  await assert.rejects(() => boundedRequest(base + '/large', { maxBytes: 4 }));
  await assert.rejects(() => boundedRequest(base + '/stall', { timeoutMs: 30, maxBytes: 4 }));
});

test('minimal Docker file layout starts the real executable without repository dependencies', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'hsr-monitor-layout-'));
  const app = join(temp, 'cloud-backup-monitor');
  await mkdir(app);
  for (const helper of ['backup-watchdog.mjs', 'backup-retention.mjs']) {
    await copyFile(new URL(`../scripts/infrastructure/${helper}`, import.meta.url), join(temp, helper));
  }
  for (const file of ['server.mjs', 'package.json']) {
    await copyFile(new URL(`../scripts/infrastructure/cloud-backup-monitor/${file}`, import.meta.url), join(app, file));
  }
  const portProbe = createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const child = spawn(process.execPath, [join(app, 'server.mjs')], { cwd: app,
    env: { PORT: String(port), SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(temp, { recursive: true, force: true });
  });
  let res;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { res = await fetch(`http://127.0.0.1:${port}/health`); break; }
    catch { if (child.exitCode !== null) assert.fail(output); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(res?.status, 200, output);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(output, '');
});

function gcpFixture({ at = '2026-11-11T19:05:00.000Z', eventAt = at, mode = 'scheduled',
  result = 'success', azureStatus = 'skipped', gcsStatus = result, eventSource = 'gcp' } = {}) {
  const f = fixture({ at });
  const gcpStem = 'gcp-production/' + stem(at);
  const archiveName = gcpStem + '.enc.json';
  const receiptName = gcpStem + '.receipt.json';
  const gcpPair = pair(at);
  f.put(archiveName, gcpPair.archive, true);
  f.put(receiptName, Buffer.from(JSON.stringify(gcpPair.receipt)), true);
  const runId = '22222222-2222-4222-8222-222222222222';
  const value = {
    version: 1,
    runId,
    source: eventSource,
    at: eventAt,
    result,
    stage: result === 'success' ? 'complete' : 'delivery',
    mode,
    perDest: {
      azure: { status: azureStatus, transportVerified: azureStatus === 'success', restoreVerified: false },
      gcs: { status: gcsStatus, transportVerified: gcsStatus === 'success', restoreVerified: false },
    },
    snapshot: {
      runStatus: result,
      workerHealth: 'confirmed',
      admission: true,
      journal: { phase: 'complete', originalAdmission: true },
    },
    restoreVerified: false,
  };
  f.put(`gcp-production/monitor/events/${eventAt.replace(/[:.]/g, '-')}-${runId}.json`, Buffer.from(JSON.stringify(value)));
  f.env = {
    ...f.env,
    HSR_ACTIVE_BACKUP_SOURCE: 'gcp',
    HSR_GCP_RETENTION_BASELINE_JSON: JSON.stringify({
      ...gcpPair.receipt,
      archiveName,
      verification: 'external-gcm-restore/v1',
      restoreVerifiedAt: at,
    }),
  };
  return { f, archiveName };
}

test('HSR_ACTIVE_BACKUP_SOURCE=gcp rejects fresh Azure-only objects and status events', async (t) => {
  const f = fixture({ at: NOW });
  const base = await serve(t, f, { env: { ...f.env, HSR_ACTIVE_BACKUP_SOURCE: 'gcp' } });
  const res = await fetch(`${base}/check`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state, 'alert');
  assert.ok(body.alerts.some((a) => a.code === 'snapshot_missing'));
  assert.ok(body.alerts.some((a) => a.code === 'status_event_missing'));
});

test('HSR_ACTIVE_BACKUP_SOURCE=gcp handles Option 1B skipped azure, skipped gcs, missing/expired credit, healthy pair, overdue, failure, and invalid source', async (t) => {
  {
    const { f } = gcpFixture({ azureStatus: 'skipped', result: 'success' });
    f.objects.delete('monitor/credit/status.json');
    const base = await serve(t, f);
    const res = await fetch(`${base}/check`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'healthy');
    assert.deepEqual(body.alerts, []);
    assert.equal(body.retention.status, 'ready');
  }
  {
    const { f } = gcpFixture({ azureStatus: 'skipped', result: 'success' });
    f.put('monitor/credit/status.json', Buffer.from(JSON.stringify({ updatedAt: '2026-10-01T00:00:00.000Z', estimatedRemainingUsd: 0 })));
    const base = await serve(t, f);
    const res = await fetch(`${base}/check`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'healthy');
    assert.deepEqual(body.alerts, []);
  }
  {
    const { f } = gcpFixture({ azureStatus: 'skipped', gcsStatus: 'skipped' });
    const base = await serve(t, f);
    const res = await fetch(`${base}/check`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'alert');
    assert.ok(body.alerts.some((a) => a.code === 'destination_unverified' && a.destination === 'gcs'));
  }
  {
    const { f } = gcpFixture({ at: '2026-11-11T04:00:00.000Z' });
    const base = await serve(t, f);
    const res = await fetch(`${base}/check`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'alert');
    assert.ok(body.alerts.some((a) => a.code === 'backup_overdue'));
  }
  {
    const { f } = gcpFixture({ result: 'failure', azureStatus: 'failure' });
    const base = await serve(t, f);
    const res = await fetch(`${base}/check`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'alert');
    assert.ok(body.alerts.some((a) => a.code === 'backup_failed'));
  }
  {
    const f = fixture({ at: NOW });
    const base = await serve(t, f, { env: { ...f.env, HSR_ACTIVE_BACKUP_SOURCE: 'invalid' } });
    const res = await fetch(`${base}/check`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'alert');
    assert.ok(body.alerts.some((a) => a.code === 'active_source_invalid'));
  }
});

const HEALTH_METRIC = 'custom.googleapis.com/hsr/gcp_backup_unhealthy';
const metricSeries = f => f.calls.filter(c => c.url.hostname === 'monitoring.googleapis.com')
  .flatMap(c => JSON.parse(c.body).timeSeries);
// Mirrors the fields available to the fallback ERROR log-alert. INFO heartbeat
// logs must never satisfy either diagnostic event filter.
const gcpErrors = f => f.logs.filter(l => l.severity === 'ERROR' && l.source === 'gcp'
  && ['hsr_backup_alert', 'hsr_gcp_backup_monitor_error'].includes(l.event));
function assertGcpMetric(f, value) {
  const health = metricSeries(f).filter(s => s.metric.type === HEALTH_METRIC);
  assert.equal(health.length, 1);
  assert.deepEqual(health[0], {
    metric: { type: HEALTH_METRIC },
    resource: { type: 'global', labels: { project_id: PROJECT } },
    metricKind: 'GAUGE', valueType: 'INT64',
    points: [{ interval: { endTime: f.logs.at(-1).checkedAt }, value: { int64Value: String(value) } }],
  });
}

test('GCP schedule uses the latest matured 19 UTC slot, including exact grace and day boundaries', async t => {
  for (const c of [
    { now: '2026-11-12T18:59:59.999Z', at: '2026-11-11T19:05:00.000Z', missed: false },
    { now: '2026-11-12T19:00:00.000Z', at: '2026-11-11T19:05:00.000Z', missed: false },
    { now: '2026-11-12T20:59:59.999Z', at: '2026-11-11T19:05:00.000Z', missed: false },
    { now: '2026-11-12T21:00:00.000Z', at: '2026-11-11T19:05:00.000Z', missed: true },
    { now: '2026-11-12T21:30:00.000Z', at: '2026-11-12T18:59:59.999Z', missed: true },
    { now: '2026-11-12T21:30:00.000Z', at: '2026-11-12T21:00:00.001Z', missed: false },
    { now: '2026-11-12T21:00:00.000Z', at: '2026-11-12T19:05:00.000Z', missed: false },
    { now: '2026-11-12T21:00:00.000Z', at: '2026-11-12T20:59:00.000Z', eventAt: '2026-11-12T21:00:00.000Z', missed: false },
    { now: '2026-11-12T21:30:00.000Z', at: '2026-11-12T20:59:00.000Z', eventAt: '2026-11-12T21:00:00.001Z', missed: false },
    { now: '2026-11-12T21:00:00.000Z', at: '2026-11-12T19:05:00.000Z', mode: 'resend', missed: true },
    { now: '2026-12-01T00:00:00.000Z', at: '2026-11-30T19:05:00.000Z', missed: false },
    // A scheduled catch-up may repair the currently due slot during the next grace.
    { now: '2026-11-12T20:00:00.000Z', at: '2026-11-12T19:05:00.000Z', missed: false },
    // A previous-slot manual service run stays fresh but cannot cover the next due slot.
    { now: '2026-11-12T21:00:00.000Z', at: '2026-11-11T23:30:00.000Z', missed: true },
    // A new event alone cannot recover without a snapshot created in this due slot.
    { now: '2026-11-12T22:05:00.000Z', at: '2026-11-12T18:59:59.999Z', eventAt: '2026-11-12T22:00:00.000Z', missed: true },
    { now: '2026-11-12T22:05:00.000Z', at: '2026-11-12T22:01:00.000Z', eventAt: '2026-11-12T22:00:00.000Z', missed: true },
    { now: '2026-11-12T22:05:00.000Z', at: '2026-11-12T22:00:00.000Z', eventAt: '2026-11-12T22:06:00.000Z', missed: true },
    { now: '2026-11-12T22:05:00.000Z', at: '2026-11-12T22:00:00.000Z', mode: 'resend', missed: true },
    { now: '2026-11-12T22:05:00.000Z', at: '2026-11-12T19:00:00.000Z', eventAt: '2026-11-12T22:00:00.000Z', missed: false },
  ]) {
    await t.test(JSON.stringify(c), async t => {
      const { f } = gcpFixture(c);
      const url = await serve(t, f, { now: () => new Date(c.now) });
      const res = await fetch(url + '/check', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.alerts.some(a => a.code === 'schedule_missed'), c.missed);
      assert.equal(body.state, c.missed ? 'alert' : 'healthy');
      assertGcpMetric(f, c.missed ? 1 : 0);
      if (!c.missed) assert.deepEqual(gcpErrors(f), []);
    });
  }
});

test('successful scheduled catch-up clears current missing health without rewriting historical evidence', async t => {
  const { f } = gcpFixture({ at: '2026-11-11T23:30:00.000Z' });
  const originalObjects = new Map([...f.objects].map(([name, o]) => [name, { ...o, body: Buffer.from(o.body) }]));
  let current = new Date('2026-11-12T21:05:00.000Z');
  const url = await serve(t, f, { now: () => current });
  const missed = await (await fetch(url + '/check', { method: 'POST' })).json();
  assert.equal(missed.state, 'alert');
  assert.ok(missed.alerts.some(a => a.code === 'schedule_missed'));
  const history = JSON.stringify(f.logs);
  const beforeRepair = f.logs.length;
  // Simulate a new production-service run: new snapshot plus successful event,
  // both after the deadline. The external restored baseline remains unchanged.
  const { f: repaired } = gcpFixture({ at: '2026-11-12T22:00:00.000Z', eventAt: '2026-11-12T22:01:00.000Z' });
  for (const o of repaired.objects.values()) if (o.name.startsWith('gcp-production/')) f.put(o.name, o.body, o.temporaryHold);
  current = new Date('2026-11-12T22:05:00.000Z');
  const recovered = await (await fetch(url + '/check', { method: 'POST' })).json();
  assert.equal(recovered.state, 'healthy');
  assert.deepEqual(recovered.alerts, []);
  assert.equal(recovered.retention.status, 'ready');
  assert.ok(f.logs.slice(beforeRepair).every(l => l.severity !== 'ERROR'));
  assert.equal(JSON.stringify(f.logs.slice(0, beforeRepair)), history);
  for (const [name, value] of originalObjects) assert.deepEqual(f.objects.get(name), value);
  assert.deepEqual(metricSeries(f).filter(s => s.metric.type === HEALTH_METRIC)
    .map(s => s.points[0].value.int64Value), ['1', '0']);
  assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
});

test('GCP finds scheduled evidence behind a newer off-schedule backup and retains 26h freshness', async t => {
  const { f } = gcpFixture();
  const { f: manual } = gcpFixture({ at: NOW, mode: 'resend' });
  for (const o of manual.objects.values()) if (o.name.startsWith('gcp-production/')) f.put(o.name, o.body, o.temporaryHold);
  const url = await serve(t, f);
  assert.equal((await (await fetch(url + '/check', { method: 'POST' })).json()).state, 'healthy');
  assertGcpMetric(f, 0);
  const stale = gcpFixture({ at: '2026-11-11T04:00:00.000Z' }).f;
  const staleUrl = await serve(t, stale);
  const body = await (await fetch(staleUrl + '/check', { method: 'POST' })).json();
  assert.ok(body.alerts.some(a => a.code === 'backup_overdue'));
  assertGcpMetric(stale, 1);
});

test('GCP emits aggregate 0/1 health alongside heartbeat and safe reason diagnostics for synthetic failures', async t => {
  for (const kind of ['healthy', 'upload_missing', 'receipt_missing', 'corrupt', 'source_mismatch', 'failed']) {
    await t.test(kind, async t => {
      const { f, archiveName } = gcpFixture({ result: kind === 'failed' ? 'failure' : 'success',
        eventSource: kind === 'source_mismatch' ? 'azure' : 'gcp' });
      if (kind === 'upload_missing') f.objects.delete(archiveName);
      if (kind === 'receipt_missing') f.objects.delete(archiveName.replace('.enc.json', '.receipt.json'));
      if (kind === 'corrupt') f.put(archiveName, Buffer.from('SECRET_CORRUPTION'), true);
      const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.state, kind === 'healthy' ? 'healthy' : 'alert');
      assertGcpMetric(f, kind === 'healthy' ? 0 : 1);
      assert.equal(metricSeries(f).filter(s => s.metric.type.endsWith('/backup_watchdog_heartbeat')).length, 1);
      assert.equal(f.calls.filter(c => c.url.hostname === 'monitoring.googleapis.com').length, 1);
      if (kind === 'healthy') {
        assert.deepEqual(gcpErrors(f), []);
        assert.equal(f.logs.some(l => l.event === 'hsr_gcp_backup_monitor_error' || l.severity === 'ERROR'), false);
      } else {
        assert.ok(gcpErrors(f).some(l => typeof l.code === 'string'));
      }
      assert.equal(JSON.stringify(f.logs).includes('SECRET_'), false);
    });
  }
});

test('GCP recovery evidence is explicit and missing/invalid external baseline always blocks apply', async t => {
  for (const kind of ['missing', 'json', 'shape', 'sha', 'timestamp', 'future', 'source', 'verification']) {
    await t.test(kind, async t => {
      const { f } = gcpFixture();
      const pin = JSON.parse(f.env.HSR_GCP_RETENTION_BASELINE_JSON);
      if (kind === 'sha') pin.sha256 = 'b'.repeat(64);
      if (kind === 'timestamp') pin.restoreVerifiedAt = '2026-02-30T00:00:00.000Z';
      if (kind === 'future') pin.restoreVerifiedAt = '2026-11-13T00:00:00.000Z';
      if (kind === 'source') pin.archiveName = pin.archiveName.replace('gcp-production/', '');
      if (kind === 'verification') pin.verification = 'transport-only';
      f.env.HSR_GCP_RETENTION_BASELINE_JSON = kind === 'missing' ? undefined
        : kind === 'json' ? '{bad' : kind === 'shape' ? '{}' : JSON.stringify(pin);
      f.env.HSR_GCP_RETENTION_APPLY = 'true';
      const old = pair('2026-11-01T05:00:00.000Z');
      f.put('gcp-production/' + old.archiveName, old.archive);
      f.put('gcp-production/' + old.receiptName, Buffer.from(JSON.stringify(old.receipt)));
      const url = await serve(t, f), res = await fetch(url + '/check', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.retention.status, 'blocked');
      const code = `recovery_evidence_${kind === 'missing' ? 'missing' : 'invalid'}`;
      assert.ok(body.alerts.some(a => a.code === code));
      assert.ok(gcpErrors(f).some(l => l.event === 'hsr_backup_alert' && l.code === code));
      assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
      assertGcpMetric(f, 1);
    });
  }
});

test('recovery-evidence ERROR diagnostics keep the current source and survive a failed metric channel', async t => {
  for (const source of ['azure', 'gcp']) for (const kind of ['missing', 'invalid']) for (const metricFails of [false, true]) {
    await t.test(`${source}: ${kind}, metricFails=${metricFails}`, async t => {
      const f = source === 'gcp' ? gcpFixture().f : fixture();
      const setting = source === 'gcp' ? 'HSR_GCP_RETENTION_BASELINE_JSON' : 'HSR_RETENTION_BASELINE_JSON';
      f.env[setting] = kind === 'missing' ? undefined : '{invalid';
      const url = await serve(t, f, { request: async (u, o) => metricFails && new URL(u).hostname === 'monitoring.googleapis.com'
        ? response({}, 403) : f.request(u, o) });
      const res = await fetch(url + '/check', { method: 'POST' });
      assert.equal(res.status, metricFails ? 500 : 200);
      const diagnostic = f.logs.find(l => l.code === `recovery_evidence_${kind}`);
      assert.deepEqual(diagnostic, { severity: 'ERROR', event: 'hsr_backup_alert', source,
        checkedAt: NOW, code: `recovery_evidence_${kind}` });
      const fallback = f.logs.filter(l => l.event === 'hsr_gcp_backup_monitor_error');
      assert.deepEqual(fallback, source === 'gcp' && metricFails ? [{ severity: 'ERROR', source,
        checkedAt: NOW, code: 'heartbeat_write_failed', event: 'hsr_gcp_backup_monitor_error' }] : []);
      if (metricFails) assert.equal(f.logs.some(l => l.event === 'hsr_backup_watchdog_heartbeat'), false);
      assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
    });
  }
});

test('transient metadata, inventory and media GET recover on attempt three without ERROR logs', async t => {
  for (const endpoint of ['metadata', 'inventory', 'media']) for (const failure of ['transport', '503']) {
    await t.test(`${endpoint}: ${failure}`, async t => {
      const { f } = gcpFixture();
      let attempts = 0, recovered = false;
      const url = await serve(t, f, { request: async (u, o) => {
        const target = new URL(u);
        const matches = endpoint === 'metadata' ? target.hostname === 'metadata.google.internal'
          : target.hostname === 'storage.googleapis.com' && (endpoint === 'media'
            ? target.searchParams.get('alt') === 'media' : target.searchParams.get('prefix') === 'gcp-production/hsr-state/');
        if (matches && !recovered) {
          attempts++;
          if (attempts < 3) {
            if (failure === 'transport') throw new Error('SECRET_TRANSIENT_TRANSPORT');
            return response({ private: 'SECRET_UPSTREAM' }, 503);
          }
          recovered = true;
        }
        return f.request(u, o);
      } });
      const res = await fetch(url + '/check', { method: 'POST' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).state, 'healthy');
      assert.equal(attempts, 3);
      assertGcpMetric(f, 0);
      assert.deepEqual(gcpErrors(f), []);
      assert.equal(f.logs.some(l => l.severity === 'ERROR'), false);
    });
  }
});

test('persistent GET failure uses exactly one notification path and reports monitor liveness when possible', async t => {
  for (const host of ['metadata.google.internal', 'storage.googleapis.com']) for (const failure of ['403', '503', 'transport']) {
    await t.test(`${host}: ${failure}`, async t => {
      const { f } = gcpFixture();
      let attempts = 0;
      const url = await serve(t, f, { request: async (u, o) => {
        if (new URL(u).hostname === host) {
          attempts++;
          if (failure === 'transport') throw new Error('SECRET_PERSISTENT_TRANSPORT');
          return response({ error: 'SECRET_PERMISSION' }, Number(failure));
        }
        return f.request(u, o);
      } });
      const res = await fetch(url + '/check', { method: 'POST' });
      assert.equal(res.status, 500);
      assert.equal(attempts, failure === '403' ? 1 : 3);
      const metricAvailable = host === 'storage.googleapis.com';
      assert.equal(f.logs.some(l => l.event === 'hsr_gcp_backup_monitor_error' && l.severity === 'ERROR' && l.source === 'gcp'), !metricAvailable);
      assert.equal(metricSeries(f).some(s => s.metric.type.endsWith('/backup_watchdog_heartbeat')), metricAvailable);
      if (host === 'storage.googleapis.com') assertGcpMetric(f, 1);
      else assert.equal(metricSeries(f).length, 0);
      assert.equal((await res.text() + JSON.stringify(f.logs)).includes('SECRET_'), false);
    });
  }
});

test('GCP Monitoring write denial emits explicit fallback event without retrying POST', async t => {
  const { f } = gcpFixture();
  let attempts = 0;
  const url = await serve(t, f, { request: async (u, o) => {
    if (new URL(u).hostname === 'monitoring.googleapis.com') { attempts++; return response({}, 403); }
    return f.request(u, o);
  } });
  assert.equal((await fetch(url + '/check', { method: 'POST' })).status, 500);
  assert.equal(attempts, 1);
  assert.ok(gcpErrors(f).some(l => l.event === 'hsr_gcp_backup_monitor_error' && l.code === 'heartbeat_write_failed'));
  assert.equal(f.logs.some(l => l.event === 'hsr_backup_watchdog_heartbeat'), false);
});

test('persistent GET failure inside retention is a monitoring error and never replays the prune', async t => {
  const { f } = gcpFixture();
  f.env.HSR_GCP_RETENTION_APPLY = 'true';
  let lists = 0;
  const url = await serve(t, f, { request: async (u, o) => {
    if (new URL(u).searchParams.get('prefix') === 'gcp-production/hsr-state/' && ++lists > 1) return response({}, 503);
    return f.request(u, o);
  } });
  assert.equal((await fetch(url + '/check', { method: 'POST' })).status, 500);
  assert.equal(lists, 4); // collect + one retention GET with three attempts
  assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
  assertGcpMetric(f, 1);
  assert.equal(gcpErrors(f).some(l => l.event === 'hsr_gcp_backup_monitor_error'), false);
  assertGcpMetric(f, 1);
  assert.equal(metricSeries(f).some(s => s.metric.type.endsWith('/backup_watchdog_heartbeat')), true);
});

test('DELETE transient responses and ambiguous transport never retry or replay a complete prune', async t => {
  for (const failure of ['503', 'transport']) {
    const { f, archiveName } = gcpFixture();
    const old = pair('2026-11-01T05:00:00.000Z');
    f.put('gcp-production/' + old.archiveName, old.archive);
    f.put('gcp-production/' + old.receiptName, Buffer.from(JSON.stringify(old.receipt)));
    f.env.HSR_GCP_RETENTION_APPLY = 'true';
    let deletes = 0;
    const url = await serve(t, f, { request: async (u, o) => {
      if (o.method === 'DELETE') {
        deletes++;
        if (failure === 'transport') { await f.request(u, o); throw new Error('SECRET_AMBIGUOUS_DELETE'); }
        return response({}, 503);
      }
      return f.request(u, o);
    } });
    const res = await fetch(url + '/check', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).retention.status, 'blocked');
    assert.equal(deletes, 1);
    assert.equal(f.calls.filter(c => c.url.searchParams.get('prefix') === 'gcp-production/hsr-state/').length, 2);
    assert.ok(f.objects.has(archiveName));
    assert.ok(f.objects.has(archiveName.replace('.enc.json', '.receipt.json')));
  }
});

test('GCS retry respects a shared check deadline before authentication or further attempts', async () => {
  const controller = new AbortController();
  let tokens = 0, calls = 0;
  const storage = createGcsStorage({ signal: controller.signal,
    getToken: async () => { tokens++; return 'token'; }, request: async () => {
      calls++;
      controller.abort();
      throw new Error('synthetic transport interruption');
    } });
  await assert.rejects(() => storage.list({ prefix: 'hsr-state/', limit: 10 }));
  assert.equal(calls, 1);
  await assert.rejects(() => storage.list({ prefix: 'hsr-state/', limit: 10 }));
  assert.equal(calls, 1);
  assert.equal(tokens, 1);
});

test('GCS retries the current page only and preserves generation pins on every media GET attempt', async () => {
  let first = 0, second = 0, media = 0;
  const name = stem(BASE) + '.enc.json';
  const storage = createGcsStorage({ getToken: async () => 'token', request: async (u, o) => {
    assert.equal(o.method, 'GET');
    const url = new URL(u);
    if (url.searchParams.get('alt') === 'media') {
      media++;
      assert.equal(url.searchParams.get('generation'), '9007199254740993');
      assert.equal(url.searchParams.get('ifGenerationMatch'), '9007199254740993');
      assert.equal(o.maxBytes, 4);
      assert.equal(o.timeoutMs, 20000);
      return media < 3 ? response({}, 429) : { status: 200, body: Buffer.from('data') };
    }
    if (url.searchParams.has('pageToken')) {
      second++;
      assert.equal(url.searchParams.get('pageToken'), 'opaque/page');
      return second < 3 ? response({}, 502) : response({ items: [] });
    }
    first++;
    return response({ items: [{ name, size: '4', generation: '9007199254740993' }], nextPageToken: 'opaque/page' });
  } });
  assert.equal((await storage.list({ prefix: 'hsr-state/', limit: 10 })).objects.length, 1);
  assert.equal(first, 1);
  assert.equal(second, 3);
  await storage.get({ name, version: { generation: '9007199254740993' }, maxBytes: 4 });
  assert.equal(media, 3);
});

test('GCP bounds schedule history reads and fails closed if the due slot has too many events', async t => {
  const { f } = gcpFixture();
  const original = [...f.objects.values()].find(o => o.name.startsWith('gcp-production/monitor/events/'));
  for (let i = 0; i < 32; i++) {
    const event = { ...JSON.parse(original.body), runId: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}` };
    f.put(`gcp-production/monitor/events/${event.at.replace(/[:.]/g, '-')}-${event.runId}.json`, Buffer.from(JSON.stringify(event)));
  }
  const url = await serve(t, f), body = await (await fetch(url + '/check', { method: 'POST' })).json();
  assert.equal(body.state, 'alert');
  assert.ok(body.alerts.some(a => a.code === 'schedule_evidence_incomplete'));
  assert.ok(body.alerts.some(a => a.code === 'schedule_missed'));
  assert.equal(f.calls.filter(c => c.url.searchParams.get('alt') === 'media'
    && decodeURIComponent(c.url.pathname).includes('monitor/events/')).length, 1);
  assertGcpMetric(f, 1);
});

test('healthy GCP checks repeatedly update one health series without matching ERROR alert filters', async t => {
  const { f } = gcpFixture();
  let current = new Date(NOW);
  const url = await serve(t, f, { now: () => current });
  for (let i = 0; i < 3; i++) {
    assert.equal((await (await fetch(url + '/check', { method: 'POST' })).json()).state, 'healthy');
    current = new Date(current.getTime() + HOUR);
  }
  const health = metricSeries(f).filter(s => s.metric.type === HEALTH_METRIC);
  assert.equal(health.length, 3);
  assert.equal(new Set(health.map(s => JSON.stringify({ metric: s.metric, resource: s.resource }))).size, 1);
  assert.ok(health.every(s => s.points[0].value.int64Value === '0'));
  assert.deepEqual(gcpErrors(f), []);
});

test('transient DELETE preflight GET recovers without replaying retention or retrying DELETE', async t => {
  const { f } = gcpFixture();
  const old = pair('2026-11-01T05:00:00.000Z');
  f.put('gcp-production/' + old.archiveName, old.archive);
  f.put('gcp-production/' + old.receiptName, Buffer.from(JSON.stringify(old.receipt)));
  f.env.HSR_GCP_RETENTION_APPLY = 'true';
  let metadataAttempts = 0, deletes = 0;
  const url = await serve(t, f, { request: async (u, o) => {
    const target = new URL(u);
    if (o.method === 'DELETE') deletes++;
    if (target.hostname === 'storage.googleapis.com' && o.method === 'GET'
        && !target.searchParams.has('alt') && decodeURIComponent(target.pathname).endsWith(old.archiveName)) {
      metadataAttempts++;
      if (metadataAttempts < 3) return response({}, 503);
    }
    return f.request(u, o);
  } });
  const body = await (await fetch(url + '/check', { method: 'POST' })).json();
  assert.equal(body.state, 'healthy');
  assert.equal(body.retention.status, 'applied');
  assert.equal(body.retention.deletedObjects, 2);
  assert.equal(metadataAttempts, 3);
  assert.equal(deletes, 2); // one per distinct object, with no replay
  assert.equal(f.calls.filter(c => c.url.searchParams.get('prefix') === 'gcp-production/hsr-state/').length, 2);
  assert.deepEqual(gcpErrors(f), []);
  assertGcpMetric(f, 0);
});

test('oversized native GET bodies and malformed metadata credentials are not transient retry candidates', async t => {
  const server = createServer((req, res) => res.end('12345')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  let attempts = 0;
  const storage = createGcsStorage({ getToken: async () => 'token', request: async (u, o) => {
    attempts++;
    return boundedRequest(`http://127.0.0.1:${server.address().port}`, o);
  } });
  await assert.rejects(() => storage.get({ name: stem(BASE) + '.enc.json', version: { generation: '1' }, maxBytes: 4 }));
  assert.equal(attempts, 1);
  let tokenAttempts = 0;
  const getToken = createMetadataTokenProvider({ request: async () => {
    tokenAttempts++;
    return response({ access_token: 'bad\r\nheader', expires_in: 3600, token_type: 'Bearer' });
  } });
  await assert.rejects(getToken);
  assert.equal(tokenAttempts, 1);
});
