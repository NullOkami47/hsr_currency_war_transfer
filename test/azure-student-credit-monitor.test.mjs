import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as monitor from '../scripts/infrastructure/azure-student-credit-monitor.mjs';
const { evaluateCredit, normaliseCosts, collectCredit, readJsonFile, boundedJsonRequest } = monitor;

const subscriptionId = '11111111-1111-4111-8111-111111111111';
const now = '2026-11-12T00:00:00.000Z';
const balance = (remaining = 30, extra = {}) => ({ subscriptionId, source: 'azure-students-portal', currency: 'USD', remaining, asOf: now, observedAt: now, creditPeriod: '2026-student-grant', ...extra });
const costs = (extra = {}) => ({ subscriptionId, source: 'azure-cost-management', collectedAt: now, from: '2026-11-04T00:00:00.000Z', to: '2026-11-11T00:00:00.000Z', currency: 'USD', days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${String(i + 4).padStart(2, '0')}`, amount: 2 })), ...extra });
const evaluate = (extra = {}) => evaluateCredit({ subscriptionId, now, balance: balance(), costs: costs(), ...extra });

// These boundary cases catch strict comparisons, missing OR logic and accidental zero defaults.
for (const [remaining, severity, warning] of [[20.01, 'ok', null], [20, 'warning', 'balance-usd-20'], [10, 'critical', 'balance-usd-10'], [0, 'critical', 'balance-usd-10']]) {
  test(`USD ${remaining} produces ${severity} at the inclusive thresholds`, () => {
    const result = evaluate({ balance: balance(remaining) });
    assert.equal(result.severity, severity);
    assert.equal(result.remainingUsd, remaining);
    if (warning) assert.ok(result.warnings.includes(warning));
    assert.equal(result.action, 'notify-only');
  });
}
test('five days of runway warns even when more than USD20 remains', () => {
  const result = evaluate({ balance: balance(50), costs: costs({ days: costs().days.map(d => ({ ...d, amount: 10 })) }) });
  assert.equal(result.runwayDays, 5);
  assert.equal(result.severity, 'critical');
  assert.ok(result.warnings.includes('runway-days-5'));
});
test('missing balance remains unknown despite known costs and never becomes zero', () => {
  const result = evaluate({ balance: null });
  assert.equal(result.balanceState, 'unknown');
  assert.equal(result.remainingUsd, null);
  assert.equal(result.estimatedRemainingUsd, null);
  assert.equal(result.runwayDays, null);
  assert.ok(result.warnings.includes('balance-missing'));
  assert.equal(result.severity, 'warning');
  assert.ok(result.alertCodes.includes('CREDIT_BALANCE_UNAVAILABLE'));
  assert.deepEqual(result.thresholdsActive, { authoritativeUsd: false, estimatedUsd: false, runway: false });
});
test('non-USD and unauthoritative sources cannot drive USD thresholds', () => {
  for (const extra of [{ currency: 'HKD' }, { source: 'gcp-credit' }, { source: 'education-offer-cap' }, { subscriptionId: '22222222-2222-4222-8222-222222222222' }]) {
    const result = evaluate({ balance: balance(0, extra) });
    assert.equal(result.remainingUsd, null);
    assert.equal(result.severity, 'warning');
    assert.equal(result.balanceState, 'unknown');
  }
});
test('invalid balances, dates and future observations cannot manufacture a trusted amount', () => {
  for (const extra of [{ remaining: null }, { remaining: '' }, { remaining: '0' }, { remaining: -1 }, { remaining: Infinity }, { asOf: 'bad' }, { asOf: '2026-02-30T00:00:00Z' }, { asOf: '2026-11-13T00:00:00Z' }, { observedAt: '2026-11-11T00:00:00Z' }, { expiresAt: 'invalid' }]) {
    assert.equal(evaluate({ balance: balance(0, extra) }).balanceState, 'unknown');
  }
  assert.throws(() => evaluateCredit({ subscriptionId, now: 'invalid' }), /clock/i);
});
test('stale balance retains a warning and never masquerades as current', () => {
  const result = evaluate({ balance: balance(30, { asOf: '2026-11-10T12:00:00Z', observedAt: '2026-11-10T12:00:00Z' }) });
  assert.equal(result.balanceState, 'stale');
  assert.equal(result.remainingUsd, null);
  assert.equal(result.estimatedRemainingUsd, null); // Cannot split a daily cost at midday.
  assert.ok(result.warnings.includes('balance-stale'));
});
test('latest trusted snapshot minus complete cost delta yields a labelled estimate', () => {
  const result = evaluate({ balance: balance(12, { asOf: '2026-11-08T00:00:00Z', observedAt: '2026-11-08T00:00:00Z' }) });
  assert.equal(result.remainingUsd, null);
  assert.equal(result.estimatedRemainingUsd, 6); // Three complete USD2 days, not all seven.
  assert.equal(result.estimateAsOf, '2026-11-11T00:00:00.000Z');
  assert.equal(result.runwayDays, 2); // USD6 / 2, minus the uncovered day.
  assert.ok(result.warnings.includes('balance-stale'));
  assert.ok(result.warnings.includes('estimated-balance-usd-10'));
});
test('estimate exhaustion is explicit and cannot set authoritative remaining to zero', () => {
  const result = evaluate({ balance: balance(1, { asOf: '2026-11-08T00:00:00Z', observedAt: '2026-11-08T00:00:00Z' }) });
  assert.equal(result.remainingUsd, null);
  assert.equal(result.estimatedRemainingUsd, 0);
  assert.ok(result.warnings.includes('estimated-exhaustion'));
});
test('a fresh observation cannot refresh an old effective balance', () => {
  assert.equal(evaluate({ balance: balance(30, { asOf: '2026-11-01T00:00:00Z' }) }).balanceState, 'stale');
});
test('expiry bounds runway even without a positive burn rate', () => {
  const result = evaluate({ balance: balance(100, { expiresAt: '2026-11-15T00:00:00Z' }), costs: null });
  assert.equal(result.runwayDays, 3);
  assert.ok(result.warnings.includes('runway-days-5'));
  assert.equal(evaluate({ balance: balance(100, { expiresAt: '2026-11-11T00:00:00Z' }) }).runwayDays, 0);
});
test('zero burn is unknown runway rather than Infinity or proof of unlimited credit', () => {
  const result = evaluate({ costs: costs({ days: costs().days.map(d => ({ ...d, amount: 0 })) }) });
  assert.equal(result.runwayDays, null);
  assert.ok(result.warnings.includes('runway-unknown'));
});
test('two fresh trusted same-period balances can supply a delta burn estimate', () => {
  const result = evaluate({ balance: balance(24), previousBalance: balance(30, { asOf: '2026-11-09T00:00:00Z', observedAt: '2026-11-09T00:00:00Z' }), costs: null });
  assert.equal(result.dailyBurnUsd, 2);
  assert.equal(result.burnRateBasis, 'trusted-balance-delta');
  assert.equal(result.runwayDays, 12);
});
test('renewals, increases, duplicates, wrong scope and non-USD do not supply a balance delta', () => {
  for (const extra of [{ creditPeriod: 'old-grant' }, { remaining: 20 }, { asOf: now }, { currency: 'HKD' }, { subscriptionId: '22222222-2222-4222-8222-222222222222' }]) {
    const result = evaluate({ previousBalance: balance(30, { asOf: '2026-11-09T00:00:00Z', observedAt: '2026-11-09T00:00:00Z', ...extra }), costs: null });
    assert.equal(result.dailyBurnUsd, null);
  }
});
test('cost gaps, duplicate dates, stale collection, mixed currency and refunds invalidate cost-based estimates', () => {
  for (const extra of [{ days: costs().days.slice(1) }, { days: [costs().days[0], ...costs().days.slice(0, 6)] }, { currency: 'HKD' }, { collectedAt: '2026-11-01T00:00:00Z' }, { days: costs().days.map(d => ({ ...d, amount: -1 })) }, { days: costs().days.map(d => ({ ...d, amount: null })) }, { subscriptionId: '22222222-2222-4222-8222-222222222222' }]) {
    const result = evaluate({ costs: costs(extra) });
    assert.equal(result.dailyBurnUsd, null);
    assert.ok(result.warnings.includes('cost-data-unknown'));
  }
});
test('conservative burn uses the larger available rate', () => {
  const result = evaluate({ balance: balance(24), previousBalance: balance(36, { asOf: '2026-11-10T00:00:00Z', observedAt: '2026-11-10T00:00:00Z' }) });
  assert.equal(result.dailyBurnUsd, 6);
  assert.equal(result.runwayDays, 4);
});

const rawCosts = () => ({ properties: { columns: [{ name: 'Currency' }, { name: 'UsageDate' }, { name: 'Cost' }], rows: costs().days.map((d, i) => ['USD', 20261104 + i, 2]), nextLink: null } });
test('official cost response is parsed by column name, preserving subscription and coverage', () => {
  const result = normaliseCosts(rawCosts(), { subscriptionId, collectedAt: now, from: costs().from, to: costs().to });
  assert.deepEqual(result, costs());
});
test('paginated, missing, mixed, malformed and oversized cost results cannot imply complete spend', () => {
  const samples = [
    { properties: { ...rawCosts().properties, nextLink: 'https://evil.invalid/?secret=x' } },
    { properties: { ...rawCosts().properties, rows: [] } },
    { properties: { ...rawCosts().properties, rows: [['HKD', 20261104, 2]] } },
    { properties: { ...rawCosts().properties, rows: [['USD', 20260230, 2]] } },
    { properties: { ...rawCosts().properties, columns: [{ name: 'Cost' }] } },
    { properties: { ...rawCosts().properties, rows: Array(401).fill(['USD', 20261104, 2]) } },
  ];
  for (const body of samples) assert.equal(normaliseCosts(body, { subscriptionId, collectedAt: now, from: costs().from, to: costs().to }), null);
});

function fakeAzure({ fail, malformed, agreement = 'MicrosoftCustomerAgreement' } = {}) {
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, ...options });
    if (fail) return { status: fail, body: { error: { code: 'InvalidScope', message: 'SECRET-TOKEN user@example.invalid' } } };
    if (path.includes('CostManagement/query')) return { status: 200, body: malformed ? {} : rawCosts() };
    if (path.includes('Microsoft.Education/grants')) return { status: 200, body: { value: [{ properties: { offerType: 'Student', offerCap: { currency: 'USD', value: 100 }, allocatedBudget: { currency: 'USD', value: 0 } } }] } };
    if (path.includes('/balances?')) return { status: 404, body: { error: { code: '404', message: 'SECRET-TOKEN' } } };
    if (path.includes('billingAccounts?')) return { status: 200, body: { value: [{ name: 'synthetic-account', properties: { agreementType: agreement } }] } };
    return { status: 200, body: { subscriptionId, state: 'Enabled', subscriptionPolicies: { quotaId: 'AzureForStudents_2018-01-01' } } };
  };
  return { calls, request };
}
test('collector uses bounded read-only API requests and never treats offer cap or 404 as a balance', async () => {
  const f = fakeAzure();
  const result = await collectCredit({ subscriptionId, now, request: f.request });
  assert.equal(result.report.balanceState, 'unknown');
  assert.equal(result.report.remainingUsd, null);
  assert.equal(result.report.dailyBurnUsd, 2);
  assert.ok(result.report.warnings.includes('balance-missing'));
  assert.ok(f.calls.length <= 6);
  assert.ok(f.calls.every(c => c.method === 'GET' || (c.method === 'POST' && c.path.includes('/Microsoft.CostManagement/query?'))));
  const query = f.calls.find(c => c.method === 'POST').body;
  assert.equal(query.type, 'ActualCost');
  assert.equal(query.timePeriod.from, '2026-11-04T00:00:00.000Z');
  assert.equal(query.timePeriod.to, '2026-11-10T23:59:59.999Z');
  assert.ok(result.diagnostics.some(d => d.endpoint === 'billing-account-balances' && d.status === 404 && d.code === '404'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET-TOKEN|example.invalid|synthetic-account|11111111/);
  assert.equal(result.format, 'hsr-azure-student-credit-monitor/v1');
});
for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} is unknown with exact status and no fabricated zero or retry`, async () => {
    const f = fakeAzure({ fail: status });
    const result = await collectCredit({ subscriptionId, now, request: f.request });
    assert.equal(result.report.remainingUsd, null);
    assert.equal(result.report.balanceState, 'unknown');
    assert.equal(result.diagnostics[0].status, status);
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /SECRET-TOKEN|example.invalid/);
  });
}
test('transport and malformed cost errors retain manual balance while warning about unknown runway', async () => {
  const result = await collectCredit({ subscriptionId, now, balance: balance(10), request: async () => { throw new Error('SECRET-TOKEN'); } });
  assert.equal(result.report.remainingUsd, 10);
  assert.equal(result.report.severity, 'critical');
  assert.equal(result.diagnostics[0].code, 'transport-error');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  const f = fakeAzure({ malformed: true });
  assert.equal((await collectCredit({ subscriptionId, now, request: f.request })).report.dailyBurnUsd, null);
});
test('invalid subscription is rejected before any request', async () => {
  let called = false;
  await assert.rejects(collectCredit({ subscriptionId: 'bad&az delete', now, request: async () => { called = true; } }), /subscription/i);
  assert.equal(called, false);
});
test('a hanging transport cannot keep collection running indefinitely', async () => {
  const start = performance.now();
  const result = await collectCredit({ subscriptionId, now, timeoutMs: 20, request: () => new Promise(() => {}) });
  assert.ok(performance.now() - start < 2000);
  assert.equal(result.report.balanceState, 'unknown');
  assert.equal(result.diagnostics[0].code, 'transport-error');
});
test('multiple billing accounts or nextLink do not expand discovery or follow arbitrary URLs', async () => {
  const f = fakeAzure(), request = async (path, options) => path.includes('billingAccounts?') ? { status: 200, body: { value: [{ name: 'one' }, { name: 'two' }], nextLink: 'https://evil.invalid/' } } : f.request(path, options);
  const result = await collectCredit({ subscriptionId, now, request });
  assert.ok(result.diagnostics.some(d => d.code === 'ambiguous-or-unavailable-scope'));
  assert.ok(f.calls.every(c => !c.path.includes('evil.invalid') && !c.path.includes('/billingAccounts/')));
});
test('non-Students metadata blocks all subsequent cloud requests', async () => {
  let calls = 0;
  const result = await collectCredit({ subscriptionId, now, request: async () => { calls++; return { status: 200, body: { subscriptionId, state: 'Enabled', subscriptionPolicies: { quotaId: 'PayAsYouGo' } } }; } });
  assert.equal(calls, 1);
  assert.equal(result.report.remainingUsd, null);
  assert.ok(result.diagnostics.some(d => d.code === 'students-scope-unverified'));
});
test('file reader caps input and rejects directories, malformed JSON and relative paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'student-credit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.json');
  await writeFile(file, JSON.stringify(balance()));
  assert.equal((await readJsonFile(file)).remaining, 30);
  await assert.rejects(readJsonFile(dir));
  await assert.rejects(readJsonFile('relative.json'));
  await writeFile(file, 'x'.repeat(262145));
  await assert.rejects(readJsonFile(file));
  await writeFile(file, 'SECRET-invalid-json');
  await assert.rejects(readJsonFile(file), e => !e.message.includes('SECRET'));
});
test('transport refuses non-ARM destinations before credentials can be sent', async () => {
  for (const path of ['https://evil.invalid/', '//evil.invalid/', '/subscriptions/x?secret=1']) {
    await assert.rejects(boundedJsonRequest(path, { token: 'SECRET', method: 'GET' }));
  }
});
test('CLI help and invalid arguments are offline and never echo input contents', async () => {
  const run = promisify(execFile);
  const script = new URL('../scripts/infrastructure/azure-student-credit-monitor.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Z]:)/, '');
  const help = await run(process.execPath, [script, '--help']);
  assert.match(help.stdout, /notify-only/);
  await assert.rejects(run(process.execPath, [script, '--SECRET-input']), e => e.code === 2 && !e.stderr.includes('SECRET'));
});

test('managed identity authenticates only to fixed IMDS with Metadata header and validates token response', async t => {
  assert.equal(typeof monitor.managedIdentityToken, 'function');
  let requested;
  const tokenResponse = { access_token: 'synthetic-token', token_type: 'Bearer', expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource: 'https://management.azure.com/' };
  let status = 200, body = JSON.stringify(tokenResponse);
  t.mock.method(http, 'request', (url, options, callback) => {
    requested = { url, options };
    const req = new EventEmitter();
    req.end = () => { const response = Readable.from([Buffer.from(body)]); response.statusCode = status; callback(response); };
    req.destroy = () => {};
    return req;
  });
  assert.equal(await monitor.managedIdentityToken(), 'synthetic-token');
  assert.equal(requested.url, 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com%2F');
  assert.equal(requested.options.headers.Metadata, 'true');
  assert.equal(requested.options.agent, false);
  for (const code of [301, 403, 404, 500]) { status = code; await assert.rejects(monitor.managedIdentityToken(), e => !e.message.includes('synthetic-token')); }
  status = 200;
  for (const data of [{ ...tokenResponse, access_token: '' }, { ...tokenResponse, expires_on: '0' }, { ...tokenResponse, resource: 'https://storage.azure.com/' }, { ...tokenResponse, token_type: 'other' }]) {
    body = JSON.stringify(data);
    await assert.rejects(monitor.managedIdentityToken());
  }
  body = 'x'.repeat(65537);
  await assert.rejects(monitor.managedIdentityToken());
});
