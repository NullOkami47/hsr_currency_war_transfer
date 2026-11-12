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
