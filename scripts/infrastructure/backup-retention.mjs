import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const FORMAT = 'hsr-worker-backup/v1';
const PREFIX = 'hsr-state/';
const ALLOWED_PREFIXES = new Map([
  ['hsr-state/', /^hsr-state\/hsr-state-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.(enc|receipt)\.json$/],
  ['gcp-production/hsr-state/', /^gcp-production\/hsr-state\/hsr-state-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.(enc|receipt)\.json$/],
]);
const DAY = 86400000, FRESH = 36 * 3600000;
const SHA = /^[a-f0-9]{64}$/;
const DEFAULTS = Object.freeze({ maxObjects: 256, maxArchiveBytes: 64 * 1024 * 1024,
  maxTotalReadBytes: 256 * 1024 * 1024, maxOperations: 1024, maxDeletePairs: 8, timeoutMs: 120000 });
const HARD_LIMITS = { ...DEFAULTS, maxTotalReadBytes: 512 * 1024 * 1024, maxDeletePairs: 32 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join() === expected.split(',').sort().join();
class Unsafe extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new Unsafe(code); };

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail('invalid_timestamp');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < 0 || new Date(time).toISOString() !== value) fail('invalid_timestamp');
  return time;
}

function version(value) {
  if (keys(value, 'generation') && typeof value.generation === 'string' && /^[1-9]\d{0,30}$/.test(value.generation)) {
    return Object.freeze({ generation: value.generation });
  }
  if (keys(value, 'etag') && typeof value.etag === 'string' && /^"[A-Za-z0-9._:+/=-]{1,128}"$/.test(value.etag)) {
    return Object.freeze({ etag: value.etag });
  }
  fail('invalid_version');
}
const sameVersion = (a, b) => a.generation === b.generation && a.etag === b.etag;

function configuration(input) {
  if (!object(input) || Object.keys(input).some(k => !Object.hasOwn(DEFAULTS, k))) fail('invalid_limits');
  const limits = { ...DEFAULTS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) fail('invalid_limits');
  }
  return limits;
}

function baseline(value, time, prefix, namePattern) {
  if (!value) fail('baseline_missing');
  if (!keys(value, 'format,createdAt,sha256,bytes,recipient,archiveName,verification,restoreVerifiedAt')
      || value.format !== FORMAT || value.verification !== 'external-gcm-restore/v1'
      || !SHA.test(value.sha256) || !SHA.test(value.recipient)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > DEFAULTS.maxArchiveBytes
      || typeof value.archiveName !== 'string' || !namePattern.test(value.archiveName)
      || !value.archiveName.endsWith('.enc.json')) fail('invalid_baseline');
  const created = timestamp(value.createdAt), verified = timestamp(value.restoreVerifiedAt);
  if (created > time || verified > time || verified < created) fail('invalid_baseline');
  if (value.archiveName !== prefix + 'hsr-state-' + value.createdAt.replace(/[:.]/g, '-') + '.enc.json') fail('invalid_baseline');
  return Object.freeze({ ...value });
}

function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('invalid_pair'); }
}

function base64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || value.length < 4
      || value.length > 4 * Math.ceil(maximum / 3) || /[^A-Za-z0-9+/=]/.test(value)) fail('invalid_envelope');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) fail('invalid_envelope');
}

function validatePair(archive, receiptBytes, archiveName, time, recipient, prefix) {
  const receipt = json(receiptBytes);
  if (!keys(receipt, 'format,createdAt,sha256,bytes,recipient') || receipt.format !== FORMAT
      || !SHA.test(receipt.sha256) || !SHA.test(receipt.recipient) || receipt.recipient !== recipient
      || receipt.bytes !== archive.length || receipt.sha256 !== digest(archive)) fail('invalid_pair');
  const created = timestamp(receipt.createdAt);
  if (created > time) fail('future_timestamp');
  if (archiveName !== prefix + 'hsr-state-' + receipt.createdAt.replace(/[:.]/g, '-') + '.enc.json') fail('invalid_pair');
  const envelope = json(archive);
  if (!keys(envelope, 'format,encryptedKey,iv,tag,ciphertext') || envelope.format !== FORMAT) fail('invalid_envelope');
  base64(envelope.encryptedKey, 384, 2048);
  base64(envelope.iv, 12, 12);
  base64(envelope.tag, 16, 16);
  base64(envelope.ciphertext, 1, DEFAULTS.maxArchiveBytes);
  return { ...receipt, time: created, receiptSha256: digest(receiptBytes) };
}

function context(storage, now, limits) {
  if (!object(storage) || ['list', 'get', 'delete'].some(k => typeof storage[k] !== 'function') || typeof now !== 'function') fail('invalid_configuration');
  // Capture methods and immutable metadata; callers cannot change a live plan through shared references.
  const methods = Object.fromEntries(['list', 'get', 'delete'].map(k => [k, storage[k].bind(storage)]));
  const controller = new AbortController(), started = performance.now();
  let operations = 0, readBytes = 0, previousTime = -1;
  const currentTime = () => {
    let date;
    try { date = now(); } catch { fail('invalid_clock'); }
    const value = date instanceof Date ? date.getTime() : NaN;
    if (!Number.isFinite(value) || value < 0 || value < previousTime) fail('invalid_clock');
    previousTime = value;
    if (controller.signal.aborted || performance.now() - started >= limits.timeoutMs) fail('deadline_exceeded');
    return value;
  };
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  return {
    limits, currentTime,
    close() { clearTimeout(timer); controller.abort(); },
    ensureBudget(extraOperations, extraBytes) {
      if (operations + extraOperations > limits.maxOperations) fail('operation_limit');
      if (readBytes + extraBytes > limits.maxTotalReadBytes) fail('read_limit');
    },
    async call(method, args) {
      currentTime();
      if (++operations > limits.maxOperations) fail('operation_limit');
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Unsafe('deadline_exceeded'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = await Promise.race([methods[method]({ ...args, signal: controller.signal }), aborted]);
        currentTime();
        return result;
      } catch (error) {
        if (error instanceof Unsafe) throw error;
        fail(method === 'delete' ? 'delete_unconfirmed' : 'storage_unavailable');
      } finally { controller.signal.removeEventListener('abort', onAbort); }
    },
    async read(metadata, cap) {
      const remaining = limits.maxTotalReadBytes - readBytes;
      if (metadata.bytes > cap || metadata.bytes > remaining) fail('read_limit');
      const result = await this.call('get', { name: metadata.name, version: metadata.version, maxBytes: Math.min(cap, remaining) });
      if (!object(result) || !Buffer.isBuffer(result.body) || result.body.length !== metadata.bytes
          || result.body.length > cap || !sameVersion(version(result.version), metadata.version)) fail('invalid_read');
      readBytes += result.body.length;
      return result.body;
    },
  };
}

async function readPair(ctx, pair, pin, prefix) {
  const archive = await ctx.read(pair.archive, ctx.limits.maxArchiveBytes);
  const receipt = await ctx.read(pair.receipt, 4096);
  return validatePair(archive, receipt, pair.archive.name, ctx.currentTime(), pin.recipient, prefix);
}

async function inspect(ctx, pin, prefix, namePattern) {
  const listed = await ctx.call('list', { prefix, limit: ctx.limits.maxObjects + 1 });
  if (!object(listed) || listed.complete !== true || listed.nextPageToken || listed.continuationToken
      || !Array.isArray(listed.objects) || listed.objects.length > ctx.limits.maxObjects) fail('invalid_inventory');
  const pairs = new Map(), seen = new Set();
  for (const item of listed.objects) {
    if (!object(item) || typeof item.name !== 'string' || item.name.length > 1024 || seen.has(item.name)) fail('invalid_inventory');
    seen.add(item.name);
    const match = namePattern.exec(item.name);
    if (!match) {
      // Unrelated keys and nested paths are outside our read/delete authority.
      if (item.name.startsWith(prefix + 'hsr-state-') && /\.(enc|receipt)\.json$/.test(item.name) && !item.name.slice(prefix.length).includes('/')) {
        fail('invalid_pair_name');
      }
      continue;
    }
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 1) fail('invalid_inventory');
    const metadata = Object.freeze({ name: item.name, bytes: item.bytes, version: version(item.version) });
    const stem = item.name.replace(/\.(enc|receipt)\.json$/, '');
    if (!pairs.has(stem)) pairs.set(stem, {});
    pairs.get(stem)[match[2] === 'enc' ? 'archive' : 'receipt'] = metadata;
  }
  const valid = [];
  // Validate EVERY in-scope pair before selecting any deletion batch.
  for (const pair of pairs.values()) {
    if (!pair.archive || !pair.receipt) fail('incomplete_pair');
    valid.push({ ...pair, identity: await readPair(ctx, pair, pin, prefix) });
  }
  const initial = valid.find(pair => pair.archive.name === pin.archiveName);
  if (!initial || ['format', 'createdAt', 'sha256', 'bytes', 'recipient'].some(k => initial.identity[k] !== pin[k])) fail('baseline_mismatch');
  valid.sort((a, b) => b.identity.time - a.identity.time);
  const newest = valid[0], time = ctx.currentTime();
  if (time - newest.identity.time > FRESH) fail('fresh_pair_required');
  const protectedPairs = [...new Set([initial, newest])];
  const candidates = valid.filter(pair => !protectedPairs.includes(pair) && pair.identity.time < time - 7 * DAY)
    .sort((a, b) => a.identity.time - b.identity.time);
  return { protectedPairs, candidates, expiresBefore: new Date(time - 7 * DAY).toISOString() };
}

const publicPair = pair => ({ archiveName: pair.archive.name, receiptName: pair.receipt.name,
  createdAt: pair.identity.createdAt, sha256: pair.identity.sha256 });

async function run({ storage, pinnedBaseline, now = () => new Date(), limits: inputLimits = {}, apply = false, prefix = PREFIX } = {}) {
  const result = { version: 1, status: 'blocked', mode: apply === true ? 'apply' : 'dry-run',
    validation: 'transport-only', restoreVerified: false, reasons: [], protected: [], candidates: [], deleted: [],
    unconfirmedDeletes: [], remainingCandidates: 0 };
  let ctx;
  try {
    if (typeof apply !== 'boolean') fail('invalid_apply');
    const namePattern = ALLOWED_PREFIXES.get(prefix);
    if (!namePattern) fail('invalid_configuration');
    const limits = configuration(inputLimits);
    ctx = context(storage, now, limits);
    const pin = baseline(pinnedBaseline, ctx.currentTime(), prefix, namePattern);
    const plan = await inspect(ctx, pin, prefix, namePattern);
    result.protected = plan.protectedPairs.map(pair => pair.archive.name);
    result.candidates = plan.candidates.slice(0, limits.maxDeletePairs).map(publicPair);
    result.remainingCandidates = Math.max(0, plan.candidates.length - limits.maxDeletePairs);
    result.expiresBefore = plan.expiresBefore;
    const selected = plan.candidates.slice(0, limits.maxDeletePairs);
    const anchorBytes = plan.protectedPairs.reduce((total, pair) => total + pair.archive.bytes + pair.receipt.bytes, 0);
    // Reserve the whole selected batch before its first DELETE. Never create an orphan
    // merely because our own known read/operation budget runs out between pair members.
    const requiredBytes = selected.reduce((total, pair) => total + 2 * (pair.archive.bytes + pair.receipt.bytes) + 2 * anchorBytes, 0);
    ctx.ensureBudget(selected.length * (6 + 4 * plan.protectedPairs.length), requiredBytes);
    result.status = 'ready';
    if (!apply) return result;
    for (const candidate of selected) {
      // A plan supplied by a caller is never executed; this is a freshly inspected internal plan.
      await readPair(ctx, candidate, pin, prefix);
      for (const metadata of [candidate.archive, candidate.receipt]) {
        for (const protectedPair of plan.protectedPairs) {
          const identity = await readPair(ctx, protectedPair, pin, prefix);
          if (identity.sha256 !== protectedPair.identity.sha256 || identity.receiptSha256 !== protectedPair.identity.receiptSha256) fail('protected_pair_changed');
        }
        const time = ctx.currentTime();
        if (!plan.protectedPairs.some(pair => time - pair.identity.time <= FRESH)) fail('fresh_pair_required');
        const bytes = await ctx.read(metadata, metadata === candidate.archive ? limits.maxArchiveBytes : 4096);
        if (digest(bytes) !== (metadata === candidate.archive ? candidate.identity.sha256 : candidate.identity.receiptSha256)) fail('candidate_changed');
        if (!plan.protectedPairs.some(pair => ctx.currentTime() - pair.identity.time <= FRESH)) fail('fresh_pair_required');
        result.unconfirmedDeletes.push(metadata.name);
        const response = await ctx.call('delete', { name: metadata.name, version: metadata.version });
        if (!object(response) || response.deleted !== true) fail('delete_unconfirmed');
        result.unconfirmedDeletes.pop();
        result.deleted.push(metadata.name);
      }
    }
    result.status = 'applied';
    return result;
  } catch (error) {
    result.status = result.deleted.length ? 'partial' : 'blocked';
    result.reasons = [error instanceof Unsafe ? error.code : 'invalid_state'];
    result.candidates = [];
    return result;
  } finally { ctx?.close(); }
}

/** Complete bounded preflight. No delete operation is invoked. */
export async function planBackupRetention(options = {}) {
  return run({ ...options, apply: false });
}

/** Defaults to dry-run. Only the literal boolean apply:true permits conditional deletion. */
export async function executeBackupRetention(options) {
  return run(object(options) ? options : {});
}
