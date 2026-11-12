import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedRequest, managedIdentityToken as storageIdentity } from './azure-blob-backup.mjs';
import { boundedJsonRequest, collectCredit, evaluateCredit, managedIdentityToken as managementIdentity } from './azure-student-credit-monitor.mjs';

// Same deployed WIF resource as gcs-backup.mjs at a71b614. No caller-controlled
// destinations, credential files, raw JSON input or arbitrary file upload API.
const BUCKET = 'hsr-worker-backups-282550645630';
const AUDIENCE = '//iam.googleapis.com/projects/282550645630/locations/global/workloadIdentityPools/hsr-azure-backup/providers/azure-vm';
const STS = 'https://sts.googleapis.com/v1/token';
const TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const FORMAT = 'hsr-azure-student-credit-monitor/v1';
const RUN_DIRECTORY = '/run/hsr-credit-export';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const warnings = new Set(['balance-missing', 'balance-invalid-or-non-usd', 'balance-stale', 'expiry-unknown', 'cost-data-unknown', 'balance-usd-20', 'balance-usd-10', 'last-trusted-balance-usd-20', 'last-trusted-balance-usd-10', 'estimated-balance-usd-20', 'estimated-balance-usd-10', 'estimated-exhaustion', 'credit-expired', 'runway-unknown', 'runway-days-5']);
const alerts = new Set(['CREDIT_BALANCE_UNAVAILABLE', 'CREDIT_BALANCE_STALE', 'CREDIT_RUNWAY_UNAVAILABLE', 'CREDIT_USD_20', 'CREDIT_USD_10', 'CREDIT_RUNWAY_5_DAYS', 'CREDIT_EXPIRED', 'CREDIT_ESTIMATED_USD_20', 'CREDIT_ESTIMATED_USD_10', 'CREDIT_ESTIMATED_EXHAUSTION']);
const endpoints = new Set(['subscription', 'subscription-scope', 'education-grants', 'education-grant-schema', 'subscription-balances', 'billing-accounts', 'billing-account-balances', 'subscription-costs', 'subscription-cost-schema', 'managed-identity']);
const diagnosticCodes = new Set(['transport-error', 'identity-or-auth-unavailable', 'no-remaining-balance-field', 'ambiguous-or-unavailable-scope', 'incomplete-or-non-usd-costs', 'students-scope-unverified', 'AuthorizationFailed', 'AuthenticationFailed', 'InvalidAuthenticationToken', 'InvalidScope', 'NotFound', 'ResourceNotFound', 'SubscriptionNotFound', 'TooManyRequests', 'Forbidden', 'BadRequest']);
const errorCodes = new Set(['CREDIT_EXPORT_CONFIG', 'CREDIT_EXPORT_LOCAL', 'CREDIT_EXPORT_SCHEMA', 'CREDIT_EXPORT_AUTH', 'CREDIT_EXPORT_TRANSPORT', 'CREDIT_EXPORT_UPLOAD', 'CREDIT_EXPORT_CHECKSUM', 'CREDIT_EXPORT_DEADLINE']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const amount = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function list(value, allow) {
  if (!Array.isArray(value) || value.length > 24 || value.some(v => !allow.has(v)) || new Set(value).size !== value.length) throw error('CREDIT_EXPORT_SCHEMA');
  return [...value];
}

function creditBytes(evidence, checkedAt) {
  const r = evidence?.report, active = r?.thresholdsActive;
  if (evidence?.format !== FORMAT || !r || !utc(r.checkedAt) || r.checkedAt !== checkedAt || r.action !== 'notify-only' || !['ok', 'warning', 'critical'].includes(r.severity) || !['known', 'unknown', 'stale'].includes(r.balanceState)) throw error('CREDIT_EXPORT_SCHEMA');
  const report = { checkedAt, action: 'notify-only', severity: r.severity, balanceState: r.balanceState };
  for (const key of ['remainingUsd', 'estimatedRemainingUsd', 'dailyBurnUsd', 'runwayDays']) {
    if (!amount(r[key])) throw error('CREDIT_EXPORT_SCHEMA');
    report[key] = r[key];
  }
  for (const key of ['balanceAsOf', 'estimateAsOf']) {
    if (r[key] !== null && (!utc(r[key]) || r[key] > checkedAt)) throw error('CREDIT_EXPORT_SCHEMA');
    report[key] = r[key];
  }
  if (![null, 'subscription-cost-proxy', 'trusted-balance-delta'].includes(r.burnRateBasis)) throw error('CREDIT_EXPORT_SCHEMA');
  report.burnRateBasis = r.burnRateBasis;
  report.warnings = list(r.warnings, warnings);
  report.alertCodes = list(r.alertCodes, alerts);
  report.thresholdsActive = {};
  for (const key of ['authoritativeUsd', 'estimatedUsd', 'runway']) {
    if (typeof active?.[key] !== 'boolean') throw error('CREDIT_EXPORT_SCHEMA');
    report.thresholdsActive[key] = active[key];
  }
  const known = r.balanceState === 'known';
  if (active.authoritativeUsd !== known || (r.remainingUsd !== null) !== known || active.estimatedUsd !== (r.estimatedRemainingUsd !== null) || active.runway !== (r.runwayDays !== null) || (!known && (!report.alertCodes.includes('CREDIT_BALANCE_UNAVAILABLE') || r.severity === 'ok')) || (!known && report.alertCodes.some(c => ['CREDIT_USD_20', 'CREDIT_USD_10'].includes(c)))) throw error('CREDIT_EXPORT_SCHEMA');
  if (!Array.isArray(evidence.diagnostics) || evidence.diagnostics.length > 16) throw error('CREDIT_EXPORT_SCHEMA');
  const diagnostics = evidence.diagnostics.map(d => {
    if (!endpoints.has(d?.endpoint) || !(d.status === null || (Number.isInteger(d.status) && d.status >= 100 && d.status <= 599)) || !(d.code === null || typeof d.code === 'string')) throw error('CREDIT_EXPORT_SCHEMA');
    const code = d.code === null ? null : diagnosticCodes.has(d.code) || /^[1-5]\d\d$/.test(d.code) ? d.code : 'unclassified-api-error';
    return { endpoint: d.endpoint, status: d.status, code };
  });
  const bytes = Buffer.from(JSON.stringify({ format: FORMAT, report, diagnostics }) + '\n');
  if (bytes.length > 16384) throw error('CREDIT_EXPORT_SCHEMA');
  return { bytes, report };
}

function deadline(timeoutMs) {
  const end = performance.now() + timeoutMs;
  function remaining() {
    const left = Math.ceil(end - performance.now());
    if (left <= 0) throw error('CREDIT_EXPORT_DEADLINE');
    return left;
  }
  return { remaining, async wait(operation, limit = 10000) {
    const ms = Math.min(remaining(), limit); let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => operation(ms)), new Promise((_, reject) => { timer = setTimeout(() => reject(error('CREDIT_EXPORT_DEADLINE')), ms); })]);
      remaining(); return result;
    } finally { clearTimeout(timer); }
  } };
}
async function protectedDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw error('CREDIT_EXPORT_LOCAL');
}
async function save(directory, name, bytes) {
  const temp = join(directory, `.${name}-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    await rename(temp, join(directory, name));
  } finally { await file?.close(); await unlink(temp).catch(() => {}); }
}
function validToken(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw error('CREDIT_EXPORT_AUTH');
  return token;
}

// Produces its own collection. There is deliberately no artifact/source-file input.
// Dependencies are injectable to test the actual orchestration without cloud calls.
export async function exportCreditEvidence({ subscriptionId, stateDirectory = RUN_DIRECTORY, now = new Date().toISOString(), runId = randomUUID(), timeoutMs = 90000, getManagementToken = managementIdentity, getStorageToken = storageIdentity, collect = collectCredit, managementRequest = boundedJsonRequest, request = boundedRequest } = {}) {
  const summary = { format: 'hsr-azure-credit-export-status/v1', checkedAt: utc(now) ? now : new Date().toISOString(), phase: 'failed', code: 'CREDIT_EXPORT_CONFIG', exitCode: 2, transportVerified: false, severity: null, alertCodes: [], object: null, sha256: null };
  let ready = false, stage = 'CREDIT_EXPORT_CONFIG';
  try {
    if (typeof subscriptionId !== 'string' || !UUID.test(subscriptionId) || typeof runId !== 'string' || !UUID.test(runId) || !utc(now) || typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || [getManagementToken, getStorageToken, collect, managementRequest, request].some(fn => typeof fn !== 'function')) throw error(stage);
    const clock = deadline(timeoutMs);
    stage = 'CREDIT_EXPORT_LOCAL';
    await clock.wait(() => protectedDirectory(stateDirectory), 5000); ready = true;
    await clock.wait(() => save(stateDirectory, 'status.json', Buffer.from(JSON.stringify({ ...summary, phase: 'collecting', code: 'CREDIT_EXPORT_PENDING' }) + '\n')), 5000);
    let managementToken, evidence;
    try { managementToken = validToken(await clock.wait(() => getManagementToken(), 5000)); }
    catch (e) {
      if (e.code === 'CREDIT_EXPORT_DEADLINE') throw e;
      evidence = { format: FORMAT, report: evaluateCredit({ subscriptionId, now }), diagnostics: [{ endpoint: 'managed-identity', status: null, code: 'identity-or-auth-unavailable' }] };
    }
    if (!evidence) {
      stage = 'CREDIT_EXPORT_SCHEMA';
      evidence = await clock.wait(() => collect({ subscriptionId, now, timeoutMs: Math.min(10000, clock.remaining()), request: (path, options) => clock.wait(ms => managementRequest(path, { ...options, token: managementToken, timeoutMs: ms }), options.timeoutMs) }), clock.remaining());
    }
    stage = 'CREDIT_EXPORT_SCHEMA';
    const { bytes, report } = creditBytes(evidence, now);
    summary.severity = report.severity; summary.alertCodes = report.alertCodes;
    stage = 'CREDIT_EXPORT_LOCAL';
    await clock.wait(() => save(stateDirectory, 'credit.json', bytes), 5000);
    stage = 'CREDIT_EXPORT_AUTH';
    const subject = validToken(await clock.wait(() => getStorageToken(), 5000));
    const form = new URLSearchParams({ audience: AUDIENCE, grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', requested_token_type: TOKEN_TYPE, subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', subject_token: subject, scope: 'https://www.googleapis.com/auth/devstorage.read_write' }).toString();
    async function send(url, options) {
      const response = await clock.wait(ms => request(url, { ...options, timeoutMs: ms }));
      if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599 || !Buffer.isBuffer(response.body) || response.body.length > options.maxBytes) throw error('CREDIT_EXPORT_TRANSPORT');
      return response;
    }
    const exchange = await send(STS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, maxBytes: 65536 });
    if (exchange.status !== 200) throw error(stage);
    let federated;
    try { federated = JSON.parse(exchange.body.toString('utf8')); } catch { throw error(stage); }
    if (federated.token_type !== 'Bearer' || federated.issued_token_type !== TOKEN_TYPE || !Number.isInteger(federated.expires_in) || federated.expires_in < 1 || federated.expires_in > 3600) throw error(stage);
    const token = validToken(federated.access_token), headers = { authorization: `Bearer ${token}` };
    const name = `monitor/credit/${now.replace(/[:.]/g, '-')}-${runId.toLowerCase()}.json`;
    const upload = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
    upload.search = new URLSearchParams({ uploadType: 'media', name, ifGenerationMatch: '0' }).toString();
    stage = 'CREDIT_EXPORT_UPLOAD';
    const uploaded = await send(upload.href, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': String(bytes.length) }, body: bytes, maxBytes: 65536 });
    if (![200, 201, 412].includes(uploaded.status)) throw error(stage);
    stage = 'CREDIT_EXPORT_CHECKSUM';
    const read = await send(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { method: 'GET', headers, maxBytes: 65536 });
    if (read.status !== 200 || read.body.length !== bytes.length || hash(read.body) !== hash(bytes)) throw error(stage);
    Object.assign(summary, { phase: 'complete', code: 'CREDIT_EXPORT_VERIFIED', exitCode: report.severity === 'ok' ? 0 : 1, transportVerified: true, object: name, sha256: hash(bytes) });
    stage = 'CREDIT_EXPORT_LOCAL';
    await clock.wait(() => save(stateDirectory, 'status.json', Buffer.from(JSON.stringify(summary) + '\n')), 5000);
  } catch (e) {
    Object.assign(summary, { phase: 'failed', code: errorCodes.has(e?.code) ? e.code : stage, exitCode: 2, transportVerified: false });
    if (ready) {
      try { await deadline(2000).wait(() => save(stateDirectory, 'status.json', Buffer.from(JSON.stringify(summary) + '\n')), 2000); }
      catch { summary.code = 'CREDIT_EXPORT_LOCAL'; }
    }
  }
  return summary;
}

// Main owns the systemd wrapper (daily 03:15 HKT). No credential/config/source paths.
// Exit 1 still means evidence was verified: credit warnings must not suppress export.
export async function creditExportCli(argv, { platform = process.platform, uid = process.getuid?.(), run = exportCreditEvidence, stdout = value => console.log(value), stderr = value => console.error(value) } = {}) {
  if (argv.length === 1 && argv[0] === '--help') { stdout('Azure credit export: --subscription UUID; Linux root; /run/hsr-credit-export/{credit,status}.json; exit 0 healthy, 1 exported credit warning, 2 export failure.'); return 0; }
  if (platform !== 'linux' || uid !== 0 || argv.length !== 2 || argv[0] !== '--subscription' || !UUID.test(argv[1])) { stderr('CREDIT_EXPORT_CONFIG'); return 2; }
  try {
    const summary = await run({ subscriptionId: argv[1], stateDirectory: RUN_DIRECTORY });
    stdout(JSON.stringify(summary)); return summary.exitCode;
  } catch { stderr('CREDIT_EXPORT_FAILED'); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  creditExportCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { console.error('CREDIT_EXPORT_FAILED'); process.exitCode = 2; });
}
