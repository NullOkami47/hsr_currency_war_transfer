import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateBackupWatchdog } from '../backup-watchdog.mjs';
import { executeBackupRetention } from '../backup-retention.mjs';

const PROJECT = 'hsr-currency-war-worker';
const BUCKET = 'hsr-worker-backups-282550645630';
const PIN = 'hsr-state/hsr-state-2026-11-12T05-53-58-279Z.enc.json';
const PIN_RECEIPT = PIN.replace('.enc.json', '.receipt.json');
const FORMAT = 'hsr-worker-backup/v1';
const ARCHIVE_LIMIT = 64 * 1024 * 1024;
const NAME = /^hsr-state\/hsr-state-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.(enc|receipt)\.json$/;
const EVENT_NAME = /^monitor\/events\/(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/;
const CREDIT_NAME = /^monitor\/credit\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/;
const CREDIT_CODES = new Set(['CREDIT_MONITOR_MISSING', 'CREDIT_MONITOR_STALE', 'CREDIT_MONITOR_INVALID',
  'CREDIT_BALANCE_UNAVAILABLE', 'CREDIT_BALANCE_STALE', 'CREDIT_RUNWAY_UNAVAILABLE', 'CREDIT_USD_20', 'CREDIT_USD_10',
  'CREDIT_RUNWAY_5_DAYS', 'CREDIT_EXPIRED', 'CREDIT_ESTIMATED_USD_20', 'CREDIT_ESTIMATED_USD_10', 'CREDIT_ESTIMATED_EXHAUSTION']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = () => { throw new Error('Cloud monitor operation failed'); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const generation = v => object(v) && Object.keys(v).join() === 'generation'
  && typeof v.generation === 'string' && /^[1-9]\d{0,30}$/.test(v.generation);
const exactKeys = (v, keys) => object(v) && Object.keys(v).sort().join() === keys.split(',').sort().join();

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 && new Date(ms).toISOString() === value ? ms : NaN;
}
function nameTime(value) {
  return value.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
}

// Native clients ignore proxy environment variables, never follow redirects and cap
// both elapsed time (including response bodies) and memory. Upstream bodies are private.
export function boundedRequest(url, { method = 'GET', headers = {}, body, signal,
  timeoutMs = 20000, maxBytes = 65536 } = {}) {
  return new Promise((resolveRequest, reject) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ARCHIVE_LIMIT
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return reject(new Error('Invalid request bounds'));
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return reject(new Error('Invalid request URL'));
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, { method, headers, signal: combined, agent: false }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = new Error('Response limit exceeded');
          reject(error); res.destroy(error); req.destroy(error); return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolveRequest({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Response interrupted')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function createMetadataTokenProvider({ request = boundedRequest, now = Date.now } = {}) {
  let cached, expiresAt = 0, pending;
  return async function getToken() {
    if (cached && now() < expiresAt) return cached;
    if (!pending) pending = (async () => {
      const response = await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' }, timeoutMs: 5000, maxBytes: 32768 });
      if (response.status !== 200) fail();
      const value = parse(response.body);
      if (value.token_type !== 'Bearer' || !Number.isInteger(value.expires_in) || value.expires_in < 61 || value.expires_in > 3600
          || typeof value.access_token !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,16384}={0,2}$/.test(value.access_token)) fail();
      cached = value.access_token;
      expiresAt = now() + (value.expires_in - 60) * 1000;
      return cached;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

export function createGcsStorage({ request = boundedRequest, getToken = createMetadataTokenProvider({ request }), now = () => new Date() } = {}) {
  async function call(url, { maxBytes = 65536, ...options } = {}) {
    const response = await request(url, { ...options, headers: { authorization: `Bearer ${await getToken()}` },
      timeoutMs: 20000, maxBytes });
    if (!Number.isInteger(response?.status) || !Buffer.isBuffer(response.body) || response.body.length > maxBytes) fail();
    return response;
  }
  function target(name, version) {
    if (typeof name !== 'string' || (!NAME.test(name) && !EVENT_NAME.test(name) && !CREDIT_NAME.test(name)) || !generation(version)) fail();
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`);
    url.searchParams.set('generation', version.generation);
    url.searchParams.set('ifGenerationMatch', version.generation);
    return url;
  }
  return {
    async list({ prefix, limit, signal } = {}) {
      if (!['hsr-state/', 'monitor/events/', 'monitor/credit/'].includes(prefix) || !Number.isSafeInteger(limit) || limit < 1 || limit > 4096) fail();
      const objects = [], seen = new Set(), tokens = new Set(); let pageToken;
      do {
        const url = new URL(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`);
        url.search = new URLSearchParams({ prefix, maxResults: String(Math.min(1000, limit - objects.length)),
          fields: 'items(name,generation,size,temporaryHold,eventBasedHold,retentionExpirationTime),nextPageToken',
          ...(pageToken ? { pageToken } : {}) }).toString();
        const response = await call(url.href, { signal, maxBytes: 2 * 1024 * 1024 });
        if (response.status !== 200) fail();
        const page = parse(response.body);
        if (!object(page) || (page.items !== undefined && !Array.isArray(page.items))) fail();
        for (const item of page.items ?? []) {
          if (!object(item) || typeof item.name !== 'string' || !item.name.startsWith(prefix)
              || item.name.length > 1024 || seen.has(item.name) || !generation({ generation: item.generation })
              || typeof item.size !== 'string' || !/^\d{1,16}$/.test(item.size) || !Number.isSafeInteger(Number(item.size))) fail();
          seen.add(item.name);
          objects.push({ name: item.name, bytes: Number(item.size), version: { generation: item.generation },
            temporaryHold: item.temporaryHold === true, eventBasedHold: item.eventBasedHold === true });
          if (objects.length > limit) fail();
        }
        pageToken = page.nextPageToken;
        if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken.length || pageToken.length > 8192 || tokens.has(pageToken))) fail();
        if (pageToken) tokens.add(pageToken);
        if (pageToken && objects.length >= limit) return { objects, complete: false };
        if (tokens.size > 32) fail();
      } while (pageToken);
      return { objects, complete: true };
    },
    async get({ name, version, maxBytes, signal } = {}) {
      const url = target(name, version);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > (name.endsWith('.enc.json') ? ARCHIVE_LIMIT : 65536)) fail();
      url.searchParams.set('alt', 'media');
      const response = await call(url.href, { signal, maxBytes });
      if (response.status !== 200) fail();
      return { body: response.body, version: { generation: version.generation } };
    },
    async delete({ name, version, signal } = {}) {
      // No event, bucket, account, nested path, key, held baseline, or young object deletion.
      if (!NAME.test(name) || name === PIN || name === PIN_RECEIPT) fail();
      const created = timestamp(nameTime(NAME.exec(name)[1]));
      if (!Number.isFinite(created) || now().getTime() - created <= 7 * 86400000) fail();
      const url = target(name, version);
      const metadataResponse = await call(url.href, { signal, maxBytes: 16384 });
      if (metadataResponse.status !== 200) fail();
      const metadata = parse(metadataResponse.body);
      if (!object(metadata) || metadata.name !== name || metadata.generation !== version.generation
          || metadata.temporaryHold === true || metadata.eventBasedHold === true
          || (metadata.retentionExpirationTime !== undefined
            && (!Number.isFinite(timestamp(metadata.retentionExpirationTime)) || timestamp(metadata.retentionExpirationTime) > now().getTime()))) fail();
      // No retry after an ambiguous DELETE response or a generation conflict.
      const response = await call(url.href, { method: 'DELETE', signal, maxBytes: 16384 });
      if (response.status !== 204) fail();
      return { deleted: true };
    },
  };
}

function baselineFromEnvironment(env) {
  try {
    const text = env.HSR_RETENTION_BASELINE_JSON;
    if (typeof text !== 'string' || text.length > 4096) return null;
    const pin = JSON.parse(text);
    if (!exactKeys(pin, 'format,createdAt,sha256,bytes,recipient,archiveName,verification,restoreVerifiedAt')
        || pin.archiveName !== PIN || pin.verification !== 'external-gcm-restore/v1') return null;
    return pin;
  } catch { return null; }
}

function pairIdentity(archive, receiptBytes, name, now) {
  try {
    const receipt = parse(receiptBytes), envelope = parse(archive);
    if (!exactKeys(receipt, 'format,createdAt,sha256,bytes,recipient') || receipt.format !== FORMAT
        || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !/^[a-f0-9]{64}$/.test(receipt.recipient)
        || receipt.bytes !== archive.length || receipt.sha256 !== sha256(archive)
        || !Number.isFinite(timestamp(receipt.createdAt)) || timestamp(receipt.createdAt) > now.getTime()
        || name !== `hsr-state/hsr-state-${receipt.createdAt.replace(/[:.]/g, '-')}.enc.json`
        || !exactKeys(envelope, 'format,encryptedKey,iv,tag,ciphertext') || envelope.format !== FORMAT) return null;
    for (const [key, min, max] of [['encryptedKey', 384, 2048], ['iv', 12, 12], ['tag', 16, 16], ['ciphertext', 1, ARCHIVE_LIMIT]]) {
      const value = envelope[key];
      if (typeof value !== 'string' || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) return null;
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length < min || bytes.length > max || bytes.toString('base64') !== value) return null;
    }
    return { createdAt: receipt.createdAt, sha256: receipt.sha256, transportVerified: true, archiveName: name };
  } catch { return null; }
}

async function collect(storage, now, signal) {
  const inventory = await storage.list({ prefix: 'hsr-state/', limit: 257, signal });
  const alerts = [];
  if (!inventory.complete || inventory.objects.length > 256) alerts.push({ code: 'backup_inventory_incomplete' });
  const map = new Map(inventory.objects.map(item => [item.name, item]));
  const candidates = inventory.objects.filter(item => NAME.test(item.name) && item.name.endsWith('.enc.json')
    && map.has(item.name.replace('.enc.json', '.receipt.json'))).sort((a, b) => b.name.localeCompare(a.name));
  let latestPair = null;
  if (candidates.length) {
    const archive = candidates[0], receipt = map.get(archive.name.replace('.enc.json', '.receipt.json'));
    if (archive.bytes < 1 || archive.bytes > ARCHIVE_LIMIT || receipt.bytes < 1 || receipt.bytes > 4096) alerts.push({ code: 'backup_pair_invalid' });
    else {
      const encrypted = await storage.get({ ...archive, maxBytes: ARCHIVE_LIMIT, signal });
      const identity = await storage.get({ ...receipt, maxBytes: 4096, signal });
      latestPair = pairIdentity(encrypted.body, identity.body, archive.name, now);
      if (latestPair) latestPair.temporaryHold = archive.temporaryHold && receipt.temporaryHold;
      else alerts.push({ code: 'backup_pair_invalid' });
    }
  }
  const events = await storage.list({ prefix: 'monitor/events/', limit: 4096, signal });
  if (!events.complete) alerts.push({ code: 'status_inventory_incomplete' });
  const eventObjects = events.objects.filter(item => EVENT_NAME.test(item.name)).sort((a, b) => b.name.localeCompare(a.name));
  let statusEvent = null;
  if (eventObjects.length) {
    const newest = eventObjects[0];
    if (newest.bytes < 1 || newest.bytes > 16384) alerts.push({ code: 'status_event_invalid' });
    else {
      const result = await storage.get({ ...newest, maxBytes: 16384, signal });
      try {
        const value = parse(result.body), match = EVENT_NAME.exec(newest.name);
        if (!object(value) || value.at !== nameTime(match[1]) || value.runId !== match[2]) throw new Error();
        statusEvent = value;
      } catch { alerts.push({ code: 'status_event_invalid' }); }
    }
  }
  return { latestPair, statusEvent, alerts };
}

async function writeHeartbeat(request, getToken, checkedAt, signal) {
  const body = JSON.stringify({ timeSeries: [{ metric: { type: 'custom.googleapis.com/hsr/backup_watchdog_heartbeat' },
    resource: { type: 'global', labels: { project_id: PROJECT } }, metricKind: 'GAUGE', valueType: 'INT64',
    points: [{ interval: { endTime: checkedAt }, value: { int64Value: String(Math.floor(Date.parse(checkedAt) / 1000)) } }] }] });
  const response = await request(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries`,
    { method: 'POST', headers: { authorization: `Bearer ${await getToken()}`, 'content-type': 'application/json' },
      body, timeoutMs: 10000, maxBytes: 65536, signal });
  if (response.status !== 200) fail();
}

async function creditAlerts(storage, now, signal) {
  const inventory = await storage.list({ prefix: 'monitor/credit/', limit: 4096, signal });
  const alerts = [];
  const add = code => { if (!alerts.some(a => a.code === code)) alerts.push({ code }); };
  if (!inventory.complete) add('CREDIT_MONITOR_INVALID');
  const newest = inventory.objects.filter(o => CREDIT_NAME.test(o.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
  if (!newest) { add('CREDIT_MONITOR_MISSING'); return alerts; }
  if (newest.bytes < 1 || newest.bytes > 65536) { add('CREDIT_MONITOR_INVALID'); return alerts; }
  const bytes = await storage.get({ ...newest, maxBytes: 65536, signal });
  try {
    const artifact = parse(bytes.body), report = artifact?.report;
    const checked = timestamp(report?.checkedAt);
    if (artifact?.format !== 'hsr-azure-student-credit-monitor/v1' || !object(report)
        || !Number.isFinite(checked) || checked > now.getTime()
        || !['known', 'unknown', 'stale'].includes(report.balanceState) || !Array.isArray(report.alertCodes)
        || (report.balanceState === 'known' && (typeof report.remainingUsd !== 'number' || !Number.isFinite(report.remainingUsd) || report.remainingUsd < 0))) {
      add('CREDIT_MONITOR_INVALID'); return alerts;
    }
    if (now.getTime() - checked >= 26 * 3600000) add('CREDIT_MONITOR_STALE');
    if (report.balanceState !== 'known') add('CREDIT_BALANCE_UNAVAILABLE');
    for (const code of report.alertCodes) if (CREDIT_CODES.has(code)) add(code);
  } catch { add('CREDIT_MONITOR_INVALID'); }
  return alerts;
}

function safeAlerts(alerts) {
  return alerts.map(a => ({ code: typeof a.code === 'string' && (/^[a-z][a-z0-9_]{0,63}$/.test(a.code) || CREDIT_CODES.has(a.code)) ? a.code : 'invalid_observation',
    ...(['azure', 'gcs'].includes(a.destination) ? { destination: a.destination } : {}) }));
}

function evaluateCloudObservations({ now, latestPair, statusEvent, baseline }) {
  // Reuse the helper's snapshot validation only. Its local journal/spool and
  // independent Azure observations are unavailable here and are never fabricated.
  const snapshotAlerts = evaluateBackupWatchdog({ now, snapshot: latestPair }).alerts
    .filter(a => ['invalid_clock', 'snapshot_missing', 'snapshot_invalid', 'snapshot_overdue'].includes(a.code));
  const alerts = snapshotAlerts.map(a => ({ code: a.code === 'snapshot_overdue' ? 'backup_overdue' : a.code }));
  const add = (code, destination) => alerts.push({ code, ...(destination ? { destination } : {}) });
  const age = latestPair ? now.getTime() - timestamp(latestPair.createdAt) : NaN;
  if (age === 26 * 3600000) add('backup_overdue');
  if (statusEvent === null) {
    // Only the held first canonical pair can bootstrap an as-yet unreported run.
    if (!latestPair || latestPair.archiveName !== PIN || latestPair.temporaryHold !== true
        || baseline?.archiveName !== PIN || baseline.sha256 !== latestPair.sha256
        || baseline.createdAt !== latestPair.createdAt || age < 0 || age >= 26 * 3600000) add('status_event_missing');
    return { alerts };
  }
  const event = statusEvent;
  const at = timestamp(event.at);
  if (!object(event) || event.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.runId)
      || !Number.isFinite(at) || at > now.getTime() || !['success', 'failure'].includes(event.result)
      || !['coordinator', 'validation', 'delivery', 'complete'].includes(event.stage)
      || !['scheduled', 'resend'].includes(event.mode) || event.restoreVerified !== false
      || !exactKeys(event.perDest, 'azure,gcs')) {
    add('status_event_invalid'); return { alerts };
  }
  if (now.getTime() - at >= 26 * 3600000) add('status_event_overdue');
  if (event.result === 'failure') add('backup_failed');
  if (event.result === 'success' && event.stage !== 'complete') add('status_event_invalid');
  for (const destination of ['azure', 'gcs']) {
    const state = event.perDest[destination];
    if (!exactKeys(state, 'status,transportVerified,restoreVerified')
        || !['success', 'failure', 'skipped'].includes(state.status)
        || state.transportVerified !== (state.status === 'success') || state.restoreVerified !== false) add('status_event_invalid', destination);
    else if (state.status === 'failure') add('backup_failed', destination);
    else if (state.status === 'skipped') add('destination_unverified', destination);
  }
  const snapshot = event.snapshot;
  if (!object(snapshot) || snapshot.runStatus !== event.result || snapshot.workerHealth !== 'confirmed'
      || typeof snapshot.admission !== 'boolean' || !object(snapshot.journal)
      || snapshot.journal.phase !== 'complete' || typeof snapshot.journal.originalAdmission !== 'boolean') add('worker_state_unverified');
  return { alerts };
}

// Cloud Run IAM enforces authenticated invokers before requests reach this service.
// Never treat Scheduler headers or a caller-supplied request body as authentication.
export function createMonitorServer({ env = process.env, request = boundedRequest, now = () => new Date(),
  log = line => console.log(line) } = {}) {
  const apply = env.HSR_RETENTION_APPLY === 'true', pinnedBaseline = baselineFromEnvironment(env);
  const getToken = createMetadataTokenProvider({ request, now: () => now().getTime() });
  let checking = false;
  const emit = value => log(JSON.stringify(value));
  const reply = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value) + '\n');
  };
  return http.createServer(async (req, res) => {
    req.resume();
    if (req.url === '/health' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (!['/health', '/check'].includes(req.url)) return reply(res, 404, { ok: false });
    if (req.url !== '/check' || req.method !== 'POST') {
      res.setHeader('allow', req.url === '/check' ? 'POST' : 'GET');
      return reply(res, 405, { ok: false });
    }
    if (checking) return reply(res, 409, { ok: false, error: 'check_in_progress' });
    checking = true;
    let checkedAt, stage = 'check_failed';
    try {
      const started = now(); checkedAt = started.toISOString();
      const deadline = AbortSignal.timeout(110000);
      const checkRequest = (url, options = {}) => request(url, { ...options,
        signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline });
      const storage = createGcsStorage({ request: checkRequest, getToken, now });
      const observations = await collect(storage, started, deadline);
      const credit = await creditAlerts(storage, started, deadline);
      const evaluated = evaluateCloudObservations({ now: started, latestPair: observations.latestPair,
        statusEvent: observations.statusEvent, baseline: pinnedBaseline });
      const retention = await executeBackupRetention({ storage, now, pinnedBaseline, apply });
      const alerts = safeAlerts([...observations.alerts, ...evaluated.alerts, ...credit,
        ...(['blocked', 'partial'].includes(retention.status) ? [{ code: 'retention_blocked' }] : [])]);
      checkedAt = now().toISOString();
      for (const alert of alerts) emit({ severity: 'ERROR', event: 'hsr_backup_alert', checkedAt, ...alert });
      stage = 'heartbeat_write_failed';
      await writeHeartbeat(checkRequest, getToken, checkedAt, deadline);
      emit({ severity: 'INFO', event: 'hsr_backup_watchdog_heartbeat', checkedAt });
      reply(res, 200, { ok: true, checkedAt, state: alerts.length ? 'alert' : 'healthy', alerts,
        retention: { mode: retention.mode, status: retention.status,
          candidatePairs: retention.candidates.length, deletedObjects: retention.deleted.length } });
    } catch {
      emit({ severity: 'ERROR', event: 'hsr_backup_alert', ...(checkedAt ? { checkedAt } : {}), code: stage });
      reply(res, 500, { ok: false, ...(checkedAt ? { checkedAt } : {}), error: 'check_failed' });
    } finally { checking = false; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listen port');
  const server = createMonitorServer();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(port, '0.0.0.0');
  process.once('SIGTERM', () => { server.close(); server.closeIdleConnections(); });
}
