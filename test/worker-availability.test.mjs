import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { parseCredentials, assertPrivateMetadata } from '../scripts/infrastructure/worker-availability/credentials.mjs';
import { readWorkerHealth, readSystemd, createProbe } from '../scripts/infrastructure/worker-availability/probe.mjs';
import { startAvailability } from '../scripts/infrastructure/worker-availability/server.mjs';
import { buildMonitoringPayloads, buildUptimeCheckConfig, buildAlertPolicy } from '../scripts/infrastructure/worker-availability/payloads.mjs';

const PASSWORD = 'synthetic-probe-password-000000000000';
const credentialText = () => ({ username: 'uptime-probe\n', password: `${PASSWORD}\n` });

test('credentials accept only dedicated Basic credentials and reject malformed or additional configuration', () => {
  assert.deepEqual(parseCredentials(credentialText()), { username: 'uptime-probe', password: PASSWORD });
  for (const change of [{ workerToken: PASSWORD }, { worker: 'unneeded' }, { username: 'bad:user' }, { password: 'short' }, { username: 'uptime-probe\nextra' }]) {
    assert.throws(() => parseCredentials({ ...credentialText(), ...change }), /Invalid availability credentials/);
  }
});

test('credential permissions fail closed for links, non-private modes, foreign owners and oversized files', () => {
  const meta = { isFile: () => true, uid: 123, mode: 0o100400, size: 40, nlink: 1 };
  assert.doesNotThrow(() => assertPrivateMetadata(meta, { uid: 123, maxBytes: 100 }));
  assert.doesNotThrow(() => assertPrivateMetadata({ ...meta, uid: 0 }, { uid: 123, maxBytes: 100 }));
  for (const change of [{ mode: 0o100644 }, { mode: 0o100640 }, { uid: 456 }, { nlink: 2 },
    { size: 101 }, { size: 0 }, { isFile: () => false }]) {
    assert.throws(() => assertPrivateMetadata({ ...meta, ...change }, { uid: 123, maxBytes: 100 }), /Invalid availability credentials/);
  }
});

const unit = (overrides = {}) => Object.entries({ Id: 'hsr-worker-production.service', LoadState: 'loaded',
  ActiveState: 'active', SubState: 'running', MainPID: '123', Result: 'success',
  ControlGroup: '/system.slice/hsr-worker-production.service',
  ExecMainStartTimestampMonotonic: '1000000', NRestarts: '0', ...overrides }).map(([k, v]) => `${k}=${v}`).join('\n');

async function serve(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

test('native loopback health sends no credentials, requires 200 exact JSON and bounds body/time without redirects', async t => {
  let kind = 'ok', calls = 0;
  const { port } = await serve(t, (req, res) => {
    calls++;
    assert.equal(req.url, '/health');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', kind === 'html' ? 'text/html' : 'application/json');
    if (kind === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end(); }
    else if (kind === 'stall') { res.writeHead(200); res.flushHeaders(); res.write('{'); }
    else if (kind === 'large') res.end('x'.repeat(4097));
    else if (kind === 'bad') res.end('{');
    else if (kind === 'extra') res.end('{"status":"ok","admin":"secret"}');
    else if (kind === 'duplicate') res.end('{"status":"unavailable","status":"ok"}');
    else if (kind === 'wrong') res.end('{"status":"degraded"}');
    else { res.statusCode = kind === 'created' ? 201 : 200; res.end('{"status":"ok"}'); }
  });
  assert.equal(await readWorkerHealth({ port }), true);
  for (kind of ['html', 'redirect', 'stall', 'large', 'bad', 'extra', 'duplicate', 'wrong', 'created']) {
    assert.equal(await readWorkerHealth({ port, timeoutMs: 80 }), false, kind);
  }
  assert.equal(calls, 10);
  assert.equal(await readWorkerHealth({ port: 1, timeoutMs: 80 }), false);
});

test('systemd/process sensor rejects reused PID, missing or mismatched cgroup, dead/stopped process and denied proc reads', async () => {
  const stat = '123 (node worker) S ' + Array(18).fill('0').join(' ') + ' 100 0';
  for (const kind of ['pid', 'cgroup', 'zombie', 'stopped', 'reused', 'denied', 'oversized']) {
    let statReads = 0;
    await assert.rejects(readSystemd({ execute: async () => ({ stdout: unit(), stderr: '' }), readProc: async path => {
      if (kind === 'denied') throw new Error('EACCES synthetic private diagnostic');
      if (kind === 'oversized') return 'x'.repeat(16385);
      if (path.endsWith('/stat')) {
        statReads++;
        if (kind === 'reused' && statReads > 1) return stat.replace(' 100 0', ' 200 0');
        if (kind === 'zombie') return stat.replace(') S ', ') Z ');
        return stat;
      }
      if (path.endsWith('/status')) return kind === 'pid' ? 'Pid:\t456\nState:\tS (sleeping)\n'
        : kind === 'stopped' ? 'Pid:\t123\nState:\tT (stopped)\n' : 'Pid:\t123\nState:\tS (sleeping)\n';
      return kind === 'cgroup' ? '0::/system.slice/another.service\n' : '0::/system.slice/hsr-worker-production.service\n';
    } }), /^Error: Availability sensor failed$/, kind);
  }
});

test('systemd sensor executes only fixed read-only show without shell or worker credentials in environment', async () => {
  const result = await readSystemd({ readProc: async (path) => {
    assert.ok(['/proc/123/stat', '/proc/123/status', '/proc/123/cgroup'].includes(path));
    return path.endsWith('/stat') ? '123 (node worker) S ' + Array(18).fill('0').join(' ') + ' 100 0'
      : path.endsWith('/status') ? 'Name:\tnode\nState:\tS (sleeping)\nPid:\t123\n'
        : '0::/system.slice/hsr-worker-production.service\n';
  }, execute: async (command, args, options) => {
    assert.equal(command, '/usr/bin/systemctl');
    assert.deepEqual(args, ['--system', 'show', '--no-pager', '--no-ask-password',
      '--property=Id,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStartTimestampMonotonic,NRestarts,ControlGroup', 'hsr-worker-production.service']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 1500);
    assert.equal(options.maxBuffer, 4096);
    assert.equal(JSON.stringify(options).includes(PASSWORD), false);
    return { stdout: unit(), stderr: '' };
  } });
  assert.equal(result, unit());
  await assert.rejects(readSystemd({ execute: async () => { throw new Error(PASSWORD); } }), /^Error: Availability sensor failed$/);
});

test('healthy backup cannot mask worker/process failure and backup failure cannot affect a healthy worker', async () => {
  // Deliberately no backup dependency enters the probe, in either direction.
  let systemd = unit(), health = true, time = 2000;
  const probe = createProbe({ readUnit: async () => systemd, readHealth: async () => health, nowUs: () => BigInt(time) * 1000n });
  assert.equal(await probe.check(), true);
  for (const override of [{ ActiveState: 'failed' }, { SubState: 'dead' }, { MainPID: '0' },
    { Result: 'exit-code' }, { LoadState: 'not-found' }, { MainPID: 'invalid' }, { ExecMainStartTimestampMonotonic: '0' }]) {
    time += 5001; systemd = unit(override);
    assert.equal(await probe.check(), false, JSON.stringify(override));
  }
  time += 5001; systemd = unit(); health = false;
  assert.equal(await probe.check(), false);
  time += 5001; health = true;
  assert.equal(await probe.check(), true);
  time += 5001; systemd = unit() + '\nActiveState=active';
  assert.equal(await probe.check(), false);
});

test('three starts in ten minutes fail even with healthy HTTP; old starts expire and automatic bursts count', async () => {
  let time = 2000, start = 1000000, restarts = 0;
  const probe = createProbe({ readUnit: async () => unit({ ExecMainStartTimestampMonotonic: String(start), NRestarts: String(restarts) }),
    readHealth: async () => true, nowUs: () => BigInt(time) * 1000n });
  assert.equal(await probe.check(), true);
  time = 8000; start = 7000000;
  assert.equal(await probe.check(), true);
  time = 14000; start = 13000000;
  assert.equal(await probe.check(), false);
  time = 602000;
  assert.equal(await probe.check(), true);
  time = 608000; start = 607000000; restarts = 3;
  assert.equal(await probe.check(), false);
});

test('cache coalesces simultaneous sensor probes and caches failures for only five seconds', async () => {
  let time = 2000, calls = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const probe = createProbe({ readUnit: async () => { calls++; await barrier; return unit(); },
    readHealth: async () => false, nowUs: () => BigInt(time) * 1000n });
  const pending = Array.from({ length: 30 }, () => probe.check());
  release();
  assert.deepEqual(await Promise.all(pending), Array(30).fill(false));
  assert.equal(calls, 1);
  time = 6999; assert.equal(await probe.check(), false); assert.equal(calls, 1);
  time = 7000; assert.equal(await probe.check(), false); assert.equal(calls, 2);
});

const credentials = { username: 'uptime-probe', password: PASSWORD };
const authorization = `Basic ${Buffer.from(`uptime-probe:${PASSWORD}`).toString('base64')}`;
async function availability(t, options = {}) {
  const server = await startAvailability({ credentials, port: 0, readUnit: async () => unit(),
    readHealth: async () => true, nowUs: () => 2000000n, ...options });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
function requestRaw(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      let body = ''; res.on('data', b => { body += b; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

test('HTTP exposes only an authenticated exact GET and fixed JSON with no status/admin details', async t => {
  const { url, server } = await availability(t);
  assert.equal(server.address().address, '127.0.0.1');
  const good = await fetch(url + '/_hsr/availability', { headers: { authorization } });
  assert.equal(good.status, 200);
  assert.equal(await good.text(), '{"status":"ok"}');
  assert.equal(good.headers.get('cache-control'), 'no-store');
  const denied = [undefined, `Bearer ${PASSWORD}`, authorization + ', ' + authorization,
    authorization + '=', `Basic ${Buffer.from(`uptime-probe:${PASSWORD}:extra`).toString('base64')}`, 'Basic !!!'];
  for (const auth of denied) {
    const res = await fetch(url + '/_hsr/availability', { headers: auth ? { authorization: auth } : {} });
    assert.equal(res.status, 503);
    assert.equal(await res.text(), '{"status":"unavailable"}');
  }
  const repeated = await requestRaw(url + '/_hsr/availability', { Authorization: [authorization, authorization] });
  assert.deepEqual(repeated, { status: 503, body: '{"status":"unavailable"}' });
  for (const [path, method] of [['/', 'GET'], ['/health', 'GET'], ['/_hsr/availability?x=1', 'GET'],
    ['/_hsr/availability/', 'GET'], ['/_hsr/availability', 'POST'], ['/_hsr/availability', 'HEAD'],
    ['/_hsr/availability', 'OPTIONS']]) {
    const res = await fetch(url + path, { method, headers: { authorization } });
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.equal(await res.text(), method === 'HEAD' ? '' : '{"status":"unavailable"}');
  }
});

test('HTTP fails closed on probe exception, request bodies and bounded global request budget', async t => {
  const unhealthy = await availability(t, { readHealth: async () => { throw new Error(PASSWORD); } });
  let res = await fetch(unhealthy.url + '/_hsr/availability', { headers: { authorization } });
  assert.equal(res.status, 503); assert.equal(await res.text(), '{"status":"unavailable"}');
  const { url } = await availability(t);
  const body = await requestRaw(url + '/_hsr/availability', { Authorization: authorization, 'Content-Length': '1' });
  assert.equal(body.status, 503);
  const statuses = [];
  for (let i = 0; i < 28; i++) statuses.push((await fetch(url + '/_hsr/availability', { headers: { authorization } })).status);
  assert.ok(statuses.includes(200));
  assert.ok(statuses.slice(-5).every(status => status === 503));
});

test('HTTP bounds concurrent waiters while one shared refresh is pending', async t => {
  let time = 2000, calls = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { url } = await availability(t, { nowUs: () => BigInt(time) * 1000n,
    readHealth: async () => { if (++calls > 1) await barrier; return true; } });
  time = 8000;
  const requests = Array.from({ length: 12 }, () => fetch(url + '/_hsr/availability', { headers: { authorization } }));
  try {
    const first = await Promise.race(requests);
    assert.equal(first.status, 503);
  } finally { release(); }
  const responses = await Promise.all(requests);
  assert.equal(responses.filter(res => res.status === 200).length, 8);
  assert.equal(calls, 2);
});

const monitoringInput = { projectId: 'hsr-currency-war-worker', checkId: 'hsr-availability-assigned-id',
  notificationChannel: 'projects/hsr-currency-war-worker/notificationChannels/13378772448236455951',
  username: 'uptime-probe', password: PASSWORD };

test('Google native uptime payload pins HTTPS, strict SSL, exact whole JSON, dedicated Basic and three regions', () => {
  const config = buildUptimeCheckConfig({ projectId: monitoringInput.projectId, username: monitoringInput.username, password: monitoringInput.password });
  assert.deepEqual(config.monitoredResource, { type: 'uptime_url', labels: {
    project_id: 'hsr-currency-war-worker', host: 'worker.35-223-56-40.sslip.io' } });
  assert.equal(config.name, undefined); // Assigned by Google after a separately authorised create.
  assert.equal(config.period, '60s'); assert.equal(config.timeout, '10s');
  assert.deepEqual(config.selectedRegions, ['USA_IOWA', 'EUROPE', 'ASIA_PACIFIC']);
  assert.deepEqual(config.httpCheck, { requestMethod: 'GET', useSsl: true, validateSsl: true,
    path: '/_hsr/availability', port: 443, maskHeaders: true,
    authInfo: { username: 'uptime-probe', password: PASSWORD }, acceptedResponseStatusCodes: [{ statusValue: 200 }] });
  assert.deepEqual(config.contentMatchers, [{ matcher: 'MATCHES_REGEX', content: '\\A\\{"status":"ok"\\}\\z' }]);
  // RE2's absolute anchors are translated only for these synthetic examples.
  const match = new RegExp(config.contentMatchers[0].content.replace('\\A', '^').replace('\\z', '(?![\\s\\S])'));
  assert.equal(match.test('{"status":"ok"}'), true);
  for (const bad of ['{"status":"unavailable"}', '{"status":"okay"}', '{"status":"ok","admin":true}',
    'prefix{"status":"ok"}', '{"status":"ok"}\n', '<html>ok</html>']) assert.equal(match.test(bad), false, bad);
  assert.equal(config.logCheckFailures, false);
});

test('alert payload is one resource/check aggregate with sustained >=2 failed locations, open/closed only and no renotify', () => {
  const { alertPolicy: policy, projectId } = buildMonitoringPayloads(monitoringInput);
  assert.equal(projectId, 'hsr-currency-war-worker');
  assert.equal(policy.conditions.length, 1); assert.equal(policy.combiner, 'OR');
  const condition = policy.conditions[0].conditionThreshold;
  assert.equal(condition.duration, '180s'); assert.equal(condition.comparison, 'COMPARISON_GT');
  assert.equal(condition.thresholdValue, 1); assert.deepEqual(condition.trigger, { count: 1 });
  assert.equal(condition.evaluationMissingData, 'EVALUATION_MISSING_DATA_NO_OP');
  assert.deepEqual(condition.aggregations, [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_NEXT_OLDER',
    crossSeriesReducer: 'REDUCE_COUNT_FALSE', groupByFields: ['resource.label.project_id', 'resource.label.host', 'metric.label.check_id'] }]);
  assert.equal(condition.filter, 'metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id="hsr-availability-assigned-id" AND resource.label.project_id="hsr-currency-war-worker" AND resource.label.host="worker.35-223-56-40.sslip.io"');
  assert.deepEqual(policy.alertStrategy, { notificationPrompts: ['OPENED', 'CLOSED'], autoClose: '604800s' });
  assert.deepEqual(policy.notificationChannels, [monitoringInput.notificationChannel]);
  assert.equal(JSON.stringify(policy).includes(PASSWORD), false);
  assert.equal(JSON.stringify(policy).includes('notificationRateLimit'), false);
  assert.equal(JSON.stringify(policy).includes('renotifyInterval'), false);
});

test('payload builder rejects project/channel/filter injection and supports a bare notification channel ID', () => {
  for (const change of [{ projectId: 'another-project' }, { notificationChannel: 'projects/other/notificationChannels/1' },
    { checkId: 'bad" OR metric.type="other' }, { notificationChannel: '' }, { password: 'short' }]) {
    assert.throws(() => buildMonitoringPayloads({ ...monitoringInput, ...change }), /^Error: Invalid monitoring payload input$/);
  }
  assert.deepEqual(buildAlertPolicy({ projectId: monitoringInput.projectId, checkId: monitoringInput.checkId,
    notificationChannel: '13378772448236455951' }).notificationChannels,
    [monitoringInput.notificationChannel]);
  assert.throws(() => buildMonitoringPayloads({ ...monitoringInput, workerToken: PASSWORD }), /^Error: Invalid monitoring payload input$/);
});

test('synthetic aligned observations illustrate sustained-window and incident dedup semantics, not cloud delivery', () => {
  const { alertPolicy: policy } = buildMonitoringPayloads(monitoringInput), threshold = policy.conditions[0].conditionThreshold;
  const duration = parseInt(threshold.duration) * 1000;
  // This tiny test-only model consumes the actual config; it is not a second
  // alert engine shipped to the VM and does not emulate Google ingestion.
  let since, opened = false;
  const notifications = [];
  const observe = (at, checkers) => {
    const failing = checkers.filter(passed => passed === false).length > threshold.thresholdValue;
    if (!failing) {
      since = undefined;
      if (opened) { opened = false; notifications.push('CLOSED'); }
    } else {
      since ??= at;
      if (!opened && at - since >= duration) { opened = true; notifications.push('OPENED'); }
    }
  };
  for (const at of [0, 60000, 120000, 180000]) observe(at, [false, true, true]);
  assert.deepEqual(notifications, []);
  observe(240000, [false, false, true]); observe(300000, [false, false, true]);
  observe(360000, [true, true, true]);
  assert.deepEqual(notifications, []); // A brief outage resets the window.
  for (const at of [420000, 480000, 540000]) observe(at, [false, false, true]);
  assert.deepEqual(notifications, []);
  observe(600000, [false, false, true]);
  for (const at of [660000, 720000, 780000]) observe(at, [false, false, false]);
  assert.deepEqual(notifications, ['OPENED']);
  observe(840000, [true, true, true]);
  assert.deepEqual(notifications, ['OPENED', 'CLOSED']);
});

test('optional current official discovery schema accepts payload property names, types and enums', {
  skip: !process.env.HSR_MONITORING_DISCOVERY,
}, async () => {
  const discovery = JSON.parse(await readFile(process.env.HSR_MONITORING_DISCOVERY, 'utf8'));
  function validate(value, schema, at) {
    if (schema.$ref) return validate(value, discovery.schemas[schema.$ref], at);
    if (schema.enum) assert.ok(schema.enum.includes(value), `${at} enum`);
    if (schema.type === 'object') {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), at);
      for (const [key, item] of Object.entries(value)) {
        const entry = schema.properties?.[key] ?? schema.additionalProperties;
        assert.ok(entry, `${at}.${key} exists in discovery`);
        validate(item, entry, `${at}.${key}`);
      }
    } else if (schema.type === 'array') { assert.ok(Array.isArray(value), at); value.forEach(item => validate(item, schema.items, at)); }
    else if (['number', 'integer'].includes(schema.type)) assert.equal(typeof value, 'number', at);
    else if (schema.type) assert.equal(typeof value, schema.type, at);
  }
  const payload = buildMonitoringPayloads(monitoringInput);
  validate(payload.uptimeCheckConfig, discovery.schemas.UptimeCheckConfig, 'UptimeCheckConfig');
  validate(payload.alertPolicy, discovery.schemas.AlertPolicy, 'AlertPolicy');
  assert.deepEqual(discovery.schemas.JsonPathMatcher.properties.jsonMatcher.enum,
    ['JSON_PATH_MATCHER_OPTION_UNSPECIFIED', 'EXACT_MATCH', 'REGEX_MATCH']);
});
