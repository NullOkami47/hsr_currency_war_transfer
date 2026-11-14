import https from 'node:https';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 86400000;
const FORMAT = 'hsr-azure-student-credit-monitor/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORTALS = new Set(['azure-students-portal', 'azure-sponsorship-portal']);
const exec = promisify(execFile);
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function timestamp(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s)) return NaN;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === s.slice(0, 19) ? parsed : NaN;
}
const iso = n => new Date(n).toISOString();
function clock(value) {
  const n = timestamp(value);
  if (!Number.isFinite(n)) throw new Error('Valid UTC clock required');
  return n;
}
function subscription(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Valid subscription UUID required');
  return value.toLowerCase();
}
function trustedBalance(b, id, now) {
  if (!b || b.subscriptionId?.toLowerCase?.() !== id || !PORTALS.has(b.source) || b.currency !== 'USD' || !finite(b.remaining)) return null;
  const asOf = timestamp(b.asOf), observed = timestamp(b.observedAt), expiry = b.expiresAt === undefined ? null : timestamp(b.expiresAt);
  if (!Number.isFinite(asOf) || !Number.isFinite(observed) || asOf > observed || observed > now || (expiry !== null && !Number.isFinite(expiry))) return null;
  return { amount: b.remaining, asOf, observed, expiry, source: b.source, period: typeof b.creditPeriod === 'string' ? b.creditPeriod : null };
}
function validCosts(c, id, now) {
  if (!c || c.subscriptionId?.toLowerCase?.() !== id || c.source !== 'azure-cost-management' || c.currency !== 'USD') return null;
  const from = timestamp(c.from), to = timestamp(c.to), collected = timestamp(c.collectedAt);
  if (![from, to, collected].every(Number.isFinite) || from % DAY || to % DAY || to > collected || collected > now || now - collected > DAY || now - to > 3 * DAY || to - from !== 7 * DAY || !Array.isArray(c.days) || c.days.length !== 7) return null;
  const days = [...c.days].sort((a, b) => String(a?.date).localeCompare(String(b?.date)));
  for (let i = 0; i < days.length; i++) {
    if (days[i]?.date !== iso(from + i * DAY).slice(0, 10) || !finite(days[i]?.amount)) return null;
  }
  const total = days.reduce((sum, d) => sum + d.amount, 0);
  if (!Number.isFinite(total)) return null;
  return { from, to, days, mean: total / 7 };
}

// Pure evaluator. Costs are subscription-wide proxies, never proof of credit deductions.
export function evaluateCredit({ subscriptionId, now = new Date().toISOString(), balance, previousBalance, costs } = {}) {
  const id = subscription(subscriptionId), time = clock(now), b = trustedBalance(balance, id, time), c = validCosts(costs, id, time);
  const warnings = [];
  const result = { checkedAt: iso(time), action: 'notify-only', severity: 'ok', balanceState: 'unknown', remainingUsd: null, balanceAsOf: null, estimatedRemainingUsd: null, estimateAsOf: null, dailyBurnUsd: null, burnRateBasis: null, runwayDays: null, warnings };
  const warn = code => { if (!warnings.includes(code)) warnings.push(code); };
  if (!b) warn(balance == null ? 'balance-missing' : 'balance-invalid-or-non-usd');
  else {
    result.balanceAsOf = iso(b.asOf);
    result.balanceState = time - b.asOf <= DAY && time - b.observed <= DAY ? 'known' : 'stale';
    if (result.balanceState === 'known') result.remainingUsd = b.amount;
    else warn('balance-stale');
    if (b.expiry === null) warn('expiry-unknown');
  }
  if (c) { result.dailyBurnUsd = c.mean > 0 ? c.mean : null; result.burnRateBasis = c.mean > 0 ? 'subscription-cost-proxy' : null; }
  else warn('cost-data-unknown');
  const previous = trustedBalance(previousBalance, id, time);
  if (b && previous && b.period && b.period === previous.period && b.source === previous.source && b.expiry === previous.expiry && time - b.asOf <= DAY && b.asOf - previous.asOf >= DAY && b.asOf - previous.asOf <= 30 * DAY && previous.amount > b.amount) {
    const rate = (previous.amount - b.amount) / ((b.asOf - previous.asOf) / DAY);
    if (Number.isFinite(rate) && rate > (result.dailyBurnUsd ?? 0)) { result.dailyBurnUsd = rate; result.burnRateBasis = 'trusted-balance-delta'; }
  }
  let amount = b?.amount ?? null, amountAsOf = b?.asOf ?? null, prefix = result.balanceState === 'stale' ? 'last-trusted-' : '';
  if (b && result.balanceState === 'stale' && c && b.asOf % DAY === 0 && b.asOf >= c.from && b.asOf < c.to && time - b.asOf <= 7 * DAY) {
    const delta = c.days.filter(d => Date.parse(d.date + 'T00:00:00Z') >= b.asOf).reduce((sum, d) => sum + d.amount, 0);
    amount = Math.max(0, b.amount - delta); amountAsOf = c.to; prefix = 'estimated-';
    result.estimatedRemainingUsd = amount; result.estimateAsOf = iso(c.to);
    if (amount === 0) warn('estimated-exhaustion');
  }
  let critical = false;
  if (amount !== null) {
    if (amount <= 20) warn(prefix + 'balance-usd-20');
    if (amount <= 10) { warn(prefix + 'balance-usd-10'); critical = true; }
    // A stale, non-projectable amount does not establish today's runway.
    if ((result.balanceState === 'known' || result.estimatedRemainingUsd !== null) && result.dailyBurnUsd !== null) result.runwayDays = Math.max(0, amount / result.dailyBurnUsd - (time - amountAsOf) / DAY);
  }
  if (b?.expiry !== null && b?.expiry !== undefined) {
    const untilExpiry = Math.max(0, (b.expiry - time) / DAY);
    result.runwayDays = Math.min(result.runwayDays ?? Infinity, untilExpiry);
    if (untilExpiry === 0) { warn('credit-expired'); critical = true; }
  }
  if (result.runwayDays === null) warn('runway-unknown');
  else if (result.runwayDays <= 5) { warn('runway-days-5'); critical = true; }
  // Missing expiry alone is informational; missing balance/rate/data is actionable.
  result.severity = critical ? 'critical' : warnings.some(w => w !== 'expiry-unknown') ? 'warning' : 'ok';
  result.thresholdsActive = { authoritativeUsd: result.balanceState === 'known', estimatedUsd: result.estimatedRemainingUsd !== null, runway: result.runwayDays !== null };
  result.alertCodes = [];
  if (result.balanceState !== 'known') result.alertCodes.push('CREDIT_BALANCE_UNAVAILABLE');
  if (result.balanceState === 'stale') result.alertCodes.push('CREDIT_BALANCE_STALE');
  if (result.runwayDays === null) result.alertCodes.push('CREDIT_RUNWAY_UNAVAILABLE');
  const mapped = { 'balance-usd-20': 'CREDIT_USD_20', 'balance-usd-10': 'CREDIT_USD_10', 'runway-days-5': 'CREDIT_RUNWAY_5_DAYS', 'credit-expired': 'CREDIT_EXPIRED', 'estimated-balance-usd-20': 'CREDIT_ESTIMATED_USD_20', 'estimated-balance-usd-10': 'CREDIT_ESTIMATED_USD_10', 'estimated-exhaustion': 'CREDIT_ESTIMATED_EXHAUSTION' };
  for (const warning of warnings) if (mapped[warning]) result.alertCodes.push(mapped[warning]);
  return result;
}

export function normaliseCosts(body, { subscriptionId, collectedAt, from, to }) {
  const p = body?.properties;
  if (!p || p.nextLink || !Array.isArray(p.columns) || !Array.isArray(p.rows) || p.rows.length === 0 || p.rows.length > 400) return null;
  const index = name => p.columns.findIndex(c => c?.name === name);
  const ci = index('Cost'), di = index('UsageDate'), ui = index('Currency');
  if ([ci, di, ui].some(i => i < 0) || new Set(p.columns.map(c => c?.name)).size !== p.columns.length) return null;
  const days = [];
  for (const row of p.rows) {
    if (!Array.isArray(row) || row[ui] !== 'USD' || !finite(row[ci]) || !Number.isInteger(row[di])) return null;
    const s = String(row[di]), date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    const parsed = Date.parse(date + 'T00:00:00Z');
    if (s.length !== 8 || !Number.isFinite(parsed) || iso(parsed).slice(0, 10) !== date) return null;
    days.push({ date, amount: row[ci] });
  }
  const c = { subscriptionId, source: 'azure-cost-management', collectedAt, from, to, currency: 'USD', days: days.sort((a, b) => a.date.localeCompare(b.date)) };
  return validCosts(c, subscription(subscriptionId), clock(collectedAt)) ? c : null;
}

function endpointMethod(path) {
  const id = '[0-9a-fA-F-]{36}', account = '[A-Za-z0-9_.:-]{1,256}';
  if (new RegExp(`^/subscriptions/${id}\\?api-version=2022-12-01$`).test(path)
    || path === '/providers/Microsoft.Education/grants?api-version=2021-12-01-preview'
    || new RegExp(`^/subscriptions/${id}/providers/Microsoft\\.Consumption/balances\\?api-version=2024-08-01$`).test(path)
    || path === '/providers/Microsoft.Billing/billingAccounts?api-version=2024-04-01'
    || new RegExp(`^/providers/Microsoft\\.Billing/billingAccounts/${account}/providers/Microsoft\\.Consumption/balances\\?api-version=2024-08-01$`).test(path)) return 'GET';
  if (new RegExp(`^/subscriptions/${id}/providers/Microsoft\\.CostManagement/query\\?api-version=2025-03-01$`).test(path)) return 'POST';
  throw new Error('Read-only ARM endpoint required');
}
export function boundedJsonRequest(path, { token, method = 'GET', body, timeoutMs = 10000, maxBytes = 1048576 } = {}) {
  return new Promise((resolveRequest, reject) => {
    if (endpointMethod(path) !== method || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 || typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) throw new Error('Invalid bounded request');
    const data = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const req = https.request('https://management.azure.com' + path, { method, signal: controller.signal, agent: false, headers: { Authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { clearTimeout(timer); reject(new Error('Response limit')); req.destroy(); } else chunks.push(chunk); });
      res.on('end', () => {
        clearTimeout(timer);
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Preserve HTTP status even for non-JSON 404s. */ }
        resolveRequest({ status: res.statusCode, body: parsed });
      });
      res.on('error', () => { clearTimeout(timer); reject(new Error('Response error')); });
      res.on('aborted', () => { clearTimeout(timer); reject(new Error('Response aborted')); });
    });
    req.on('error', () => { clearTimeout(timer); reject(new Error('Transport error')); });
    req.end(data);
  });
}

export async function collectCredit({ subscriptionId, now = new Date().toISOString(), balance, previousBalance, request, timeoutMs = 10000 } = {}) {
  const id = subscription(subscriptionId), time = clock(now);
  if (typeof request !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Bounded request required');
  const diagnostics = []; let calls = 0;
  async function read(endpoint, path, method = 'GET', body) {
    if (++calls > 6 || endpointMethod(path) !== method) throw new Error('Request budget exceeded');
    let timer;
    try {
      const response = await Promise.race([request(path, { method, body, timeoutMs }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs); })]);
      const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      const apiCode = response?.body?.error?.code;
      const code = typeof apiCode === 'string' && /^(?:[A-Za-z][A-Za-z0-9_.-]{0,63}|\d{3})$/.test(apiCode) ? apiCode : null;
      diagnostics.push({ endpoint, status, code });
      return status === 200 ? response.body : null;
    } catch { diagnostics.push({ endpoint, status: null, code: 'transport-error' }); return null; }
    finally { clearTimeout(timer); }
  }
  const metadata = await read('subscription', `/subscriptions/${id}?api-version=2022-12-01`);
  let costs = null;
  if (metadata?.subscriptionId?.toLowerCase?.() === id && metadata.state === 'Enabled' && /^AzureForStudents_/i.test(metadata.subscriptionPolicies?.quotaId ?? '')) {
    // Discovery only: none of these generic grant/EA billing responses is a Students remaining balance.
    const grants = await read('education-grants', '/providers/Microsoft.Education/grants?api-version=2021-12-01-preview');
    if (grants) diagnostics.push({ endpoint: 'education-grant-schema', status: 200, code: 'no-remaining-balance-field' });
    await read('subscription-balances', `/subscriptions/${id}/providers/Microsoft.Consumption/balances?api-version=2024-08-01`);
    const accounts = await read('billing-accounts', '/providers/Microsoft.Billing/billingAccounts?api-version=2024-04-01');
    const first = accounts?.value?.[0];
    if (Array.isArray(accounts?.value) && !accounts.nextLink && accounts.value.length === 1 && typeof first?.name === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(first.name)) {
      await read('billing-account-balances', `/providers/Microsoft.Billing/billingAccounts/${first.name}/providers/Microsoft.Consumption/balances?api-version=2024-08-01`);
    } else diagnostics.push({ endpoint: 'billing-account-balances', status: null, code: 'ambiguous-or-unavailable-scope' });
    const to = Math.floor(time / DAY) * DAY - DAY, from = to - 7 * DAY;
    const response = await read('subscription-costs', `/subscriptions/${id}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`, 'POST', { type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: iso(from), to: iso(to - 1) }, dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } } });
    costs = normaliseCosts(response, { subscriptionId: id, collectedAt: iso(time), from: iso(from), to: iso(to) });
    if (!costs) diagnostics.push({ endpoint: 'subscription-cost-schema', status: null, code: 'incomplete-or-non-usd-costs' });
  } else diagnostics.push({ endpoint: 'subscription-scope', status: null, code: 'students-scope-unverified' });
  return { format: FORMAT, report: evaluateCredit({ subscriptionId: id, now, balance, previousBalance, costs }), diagnostics };
}

export function managedIdentityToken() {
  const url = 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com%2F';
  return new Promise((resolveToken, reject) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    const fail = () => { clearTimeout(timer); reject(new Error('Managed identity unavailable')); };
    const req = http.request(url, { method: 'GET', headers: { Metadata: 'true' }, agent: false, signal: controller.signal }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 65536) { fail(); req.destroy(); } else chunks.push(chunk); });
      res.on('error', fail); res.on('aborted', fail);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || typeof body.access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(body.access_token) || body.token_type !== 'Bearer' || body.resource !== 'https://management.azure.com/' || !Number.isFinite(Number(body.expires_on)) || Number(body.expires_on) * 1000 <= Date.now()) throw new Error();
          resolveToken(body.access_token);
        } catch { fail(); }
      });
    });
    req.on('error', fail);
    req.end();
  });
}

export async function readJsonFile(path) {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || (await lstat(path)).isSymbolicLink()) throw new Error();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 262144) throw new Error();
      const bytes = Buffer.alloc(262145); let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 262144) throw new Error();
      return JSON.parse(bytes.subarray(0, size).toString('utf8'));
    } finally { await file.close(); }
  } catch { throw new Error('Invalid bounded JSON input'); }
}

async function azureRequest(subscriptionId, python) {
  let command = 'az', prefix = [];
  if (python !== undefined || process.platform === 'win32') {
    if (python === undefined) {
      const located = await exec('where.exe', ['az.cmd'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true });
      python = resolve(dirname(located.stdout.trim().split(/\r?\n/)[0]), '..', 'python.exe');
    }
    if (!isAbsolute(python)) throw new Error('Absolute Azure CLI Python path required');
    command = python; prefix = ['-IBm', 'azure.cli'];
  }
  const response = await exec(command, [...prefix, 'account', 'get-access-token', '--subscription', subscriptionId, '--resource', 'https://management.azure.com/', '--only-show-errors', '-o', 'json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true });
  const token = JSON.parse(response.stdout).accessToken;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) throw new Error('Invalid Azure CLI token');
  return (path, options) => boundedJsonRequest(path, { ...options, token });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Azure Students credit monitor (notify-only)\ncollect --subscription UUID [--auth cli|managed-identity] [--balance-file ABSOLUTE_JSON] [--previous-balance-file ABSOLUTE_JSON] [--azure-cli-python ABSOLUTE_EXE]\nevaluate --input ABSOLUTE_JSON\nExit: 0 healthy, 1 warning/critical/unknown, 2 invalid input. No scheduling or cloud mutations.'); return;
  }
  const command = args.shift(), flags = {};
  const allowed = command === 'evaluate' ? ['--input'] : command === 'collect' ? ['--subscription', '--balance-file', '--previous-balance-file', '--azure-cli-python', '--auth'] : [];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || flags[args[i]] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    flags[args[i]] = args[i + 1];
  }
  let result;
  if (command === 'evaluate' && flags['--input']) result = { format: FORMAT, report: evaluateCredit(await readJsonFile(flags['--input'])), diagnostics: [] };
  else if (command === 'collect') {
    const id = subscription(flags['--subscription']), now = new Date().toISOString();
    const auth = flags['--auth'] ?? 'cli';
    if (!['cli', 'managed-identity'].includes(auth) || (auth === 'managed-identity' && flags['--azure-cli-python'])) throw new Error('Invalid auth mode');
    const balance = flags['--balance-file'] ? await readJsonFile(flags['--balance-file']) : undefined;
    const previousBalance = flags['--previous-balance-file'] ? await readJsonFile(flags['--previous-balance-file']) : undefined;
    try {
      let request;
      if (auth === 'managed-identity') { const token = await managedIdentityToken(); request = (path, options) => boundedJsonRequest(path, { ...options, token }); }
      else request = await azureRequest(id, flags['--azure-cli-python']);
      result = await collectCredit({ subscriptionId: id, now, balance, previousBalance, request });
    } catch { result = { format: FORMAT, report: evaluateCredit({ subscriptionId: id, now, balance, previousBalance }), diagnostics: [{ endpoint: auth, status: null, code: 'identity-or-auth-unavailable' }] }; }
  } else throw new Error('Invalid command');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.report.severity === 'ok' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('credit-monitor: invalid input or execution failure (details suppressed)'); process.exitCode = 2; });
}
