import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStateBackup, verifyStateBackup } from '../scripts/infrastructure/worker-state-backup.mjs';
import { planBackupRetention, executeBackupRetention } from '../scripts/infrastructure/backup-retention.mjs';

const NOW = '2026-11-12T19:00:00.000Z';
const clock = () => new Date(NOW);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const recipient = 'a'.repeat(64);
const nameAt = at => `hsr-state/hsr-state-${at.replace(/[:.]/g, '-')}`;

function pair(at, mutateEnvelope = x => x) {
  const envelope = mutateEnvelope({ format: 'hsr-worker-backup/v1', encryptedKey: Buffer.alloc(384, 1).toString('base64'),
    iv: Buffer.alloc(12, 2).toString('base64'), tag: Buffer.alloc(16, 3).toString('base64'), ciphertext: Buffer.from('synthetic ciphertext').toString('base64') });
  const archive = Buffer.from(JSON.stringify(envelope) + '\n');
  const receipt = { format: 'hsr-worker-backup/v1', createdAt: at, bytes: archive.length, sha256: hash(archive), recipient };
  return { archiveName: nameAt(at) + '.enc.json', receiptName: nameAt(at) + '.receipt.json', archive,
    receipt: Buffer.from(JSON.stringify(receipt) + '\n'), identity: receipt };
}

function store(pairs, kind = 'generation') {
  let sequence = 0;
  const objects = new Map(), calls = [];
  function put(name, body) {
    const version = kind === 'generation' ? { generation: String(++sequence) } : { etag: `"etag-${++sequence}"` };
    objects.set(name, { name, bytes: body.length, version, body: Buffer.from(body) });
  }
  for (const p of pairs) { put(p.archiveName, p.archive); put(p.receiptName, p.receipt); }
  const operations = {
    async list(options) {
      calls.push(['list', options]);
      return { complete: true, objects: [...objects.values()].map(({ body, ...metadata }) => structuredClone(metadata)) };
    },
    async get(options) {
      calls.push(['get', options]);
      const value = objects.get(options.name);
      if (!value || JSON.stringify(value.version) !== JSON.stringify(options.version)) throw new Error('precondition failed: synthetic secret');
      if (value.body.length > options.maxBytes) throw new Error('size cap');
      return { body: Buffer.from(value.body), version: structuredClone(value.version) };
    },
    async delete(options) {
      calls.push(['delete', options]);
      const value = objects.get(options.name);
      if (!value || JSON.stringify(value.version) !== JSON.stringify(options.version)) throw new Error('precondition failed');
      objects.delete(options.name);
      return { deleted: true };
    },
  };
  return { objects, calls, put, operations };
}

function setup(kind) {
  const pinned = pair('2026-10-01T19:00:00.000Z');
  const expired = pair('2026-11-01T19:00:00.000Z');
  const fresh = pair('2026-11-12T18:00:00.000Z');
  const s = store([pinned, expired, fresh], kind);
  const pinnedBaseline = { ...pinned.identity, archiveName: pinned.archiveName,
    verification: 'external-gcm-restore/v1', restoreVerifiedAt: '2026-10-02T00:00:00.000Z' };
  return { ...s, pinned, expired, fresh, options: { storage: s.operations, pinnedBaseline, now: clock } };
}

test('default dry run validates ciphertext and proposes only the expired unpinned pair', async () => {
  const s = setup();
  const result = await executeBackupRetention(s.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.validation, 'transport-only');
  assert.equal(result.restoreVerified, false);
  assert.deepEqual(result.candidates.map(p => p.archiveName), [s.expired.archiveName]);
  assert.deepEqual(new Set(result.protected), new Set([s.pinned.archiveName, s.fresh.archiveName]));
  assert.equal(s.calls.filter(([op]) => op === 'delete').length, 0);
  assert.equal(s.objects.size, 6);
  assert.equal((await planBackupRetention({ ...s.options, apply: true })).mode, 'dry-run');
  assert.equal(s.objects.size, 6);
});

for (const kind of ['generation', 'etag']) {
  test(`apply deletes both expired objects with exact ${kind} conditions and preserves anchors`, async () => {
    const s = setup(kind);
    const result = await executeBackupRetention({ ...s.options, apply: true });
    assert.equal(result.status, 'applied');
    assert.equal(result.deleted.length, 2);
    assert.equal(s.objects.has(s.expired.archiveName), false);
    assert.equal(s.objects.has(s.expired.receiptName), false);
    for (const p of [s.pinned, s.fresh]) {
      assert.ok(s.objects.has(p.archiveName)); assert.ok(s.objects.has(p.receiptName));
    }
    const deletes = s.calls.filter(([op]) => op === 'delete');
    assert.equal(deletes.length, 2);
    assert.ok(deletes.every(([, args]) => typeof args.version[kind] === 'string' && args.signal instanceof AbortSignal));
    // Baseline and newest must be read again between the two non-atomic deletes.
    const indices = s.calls.flatMap(([op], i) => op === 'delete' ? [i] : []);
    assert.ok(s.calls.slice(indices[0] + 1, indices[1]).some(([op, args]) => op === 'get' && args.name === s.fresh.archiveName));
  });
}

test('seven days is an exclusive cutoff and freshness includes exactly 36 hours', async () => {
  const s = setup();
  const boundary = pair('2026-11-05T19:00:00.000Z');
  s.put(boundary.archiveName, boundary.archive); s.put(boundary.receiptName, boundary.receipt);
  s.objects.delete(s.fresh.archiveName); s.objects.delete(s.fresh.receiptName);
  const fresh = pair('2026-11-11T07:00:00.000Z');
  s.put(fresh.archiveName, fresh.archive); s.put(fresh.receiptName, fresh.receipt);
  const result = await planBackupRetention(s.options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.candidates.map(x => x.archiveName), [s.expired.archiveName]);
  const stale = pair('2026-11-11T06:59:59.999Z');
  s.objects.delete(fresh.archiveName); s.objects.delete(fresh.receiptName);
  s.put(stale.archiveName, stale.archive); s.put(stale.receiptName, stale.receipt);
  const blocked = await executeBackupRetention({ ...s.options, apply: true });
  assert.ok(blocked.reasons.includes('fresh_pair_required'));
  assert.equal(s.calls.filter(([op]) => op === 'delete').length, 0);
});

test('the only valid pair and pinned initial archive survive regardless of age', async () => {
  const s = setup();
  for (const p of [s.expired, s.fresh]) { s.objects.delete(p.archiveName); s.objects.delete(p.receiptName); }
  const result = await executeBackupRetention({ ...s.options, apply: true });
  assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 2);
});

test('apply with only younger-than-seven-day production-shaped pairs performs no deletes', async () => {
  const s = setup(); s.objects.delete(s.expired.archiveName); s.objects.delete(s.expired.receiptName);
  const result = await executeBackupRetention({ ...s.options, apply: true });
  assert.equal(result.status, 'applied'); assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.deleted, []); assert.deepEqual(result.unconfirmedDeletes, []);
  assert.equal(s.objects.size, 4);
});

test('key objects and other prefixes are never read or deleted', async () => {
  const s = setup();
  const names = ['keys/private.pem', 'hsr-state/keys/private.pem', 'other/' + s.expired.archiveName,
    'hsr-state/../keys/private.pem', 'hsr-state/hsr-state-2026-11-01T19-00-00-000Z.enc.json/key',
    'hsr-state/.enc.json', 'hsr-state/.receipt.json'];
  for (const name of names) s.put(name, Buffer.from('DO NOT READ'));
  const result = await executeBackupRetention({ ...s.options, apply: true });
  assert.equal(result.status, 'applied');
  assert.ok(names.every(name => s.objects.has(name)));
  assert.ok(s.calls.filter(([op]) => op !== 'list').every(([, args]) => !names.includes(args.name)));
});

test('missing, mutable, spoofed or future external baseline blocks every deletion', async () => {
  for (const patch of [null, { verification: 'transport-only' }, { sha256: 'b'.repeat(64) },
    { archiveName: 'keys/private.pem' }, { restoreVerifiedAt: '2099-01-01T00:00:00.000Z' }]) {
    const s = setup();
    const result = await executeBackupRetention({ ...s.options, apply: true,
      pinnedBaseline: patch === null ? null : { ...s.options.pinnedBaseline, ...patch } });
    assert.equal(result.status, 'blocked');
    assert.equal(s.calls.filter(([op]) => op === 'delete').length, 0);
  }
});

test('malformed, future, mismatched and incomplete pairs fail the entire preflight closed', async () => {
  const mutations = [
    s => s.objects.delete(s.expired.receiptName),
    s => s.put(s.expired.archiveName, Buffer.from('{"secret":"plaintext"}')),
    s => { const r = JSON.parse(s.expired.receipt); r.createdAt = '2026-02-30T19:00:00.000Z'; s.put(s.expired.receiptName, Buffer.from(JSON.stringify(r))); },
    s => { const r = JSON.parse(s.expired.receipt); r.extra = 'secret'; s.put(s.expired.receiptName, Buffer.from(JSON.stringify(r))); },
    s => { const p = pair('2026-11-12T19:00:00.001Z'); s.put(p.archiveName, p.archive); s.put(p.receiptName, p.receipt); },
    s => { const p = pair('2026-11-01T18:00:00.000Z', e => ({ ...e, iv: 'AA==' })); s.put(p.archiveName, p.archive); s.put(p.receiptName, p.receipt); },
    s => { const r = JSON.parse(s.expired.receipt); r.recipient = 'b'.repeat(64); s.put(s.expired.receiptName, Buffer.from(JSON.stringify(r))); },
  ];
  for (const mutate of mutations) {
    const s = setup(); mutate(s);
    const result = await executeBackupRetention({ ...s.options, apply: true });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.candidates, []);
    assert.equal(s.calls.filter(([op]) => op === 'delete').length, 0);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('list pagination, duplicate names, absent version and excessive inventory never prune', async () => {
  for (const change of [r => ({ ...r, complete: false }), r => ({ ...r, objects: [...r.objects, r.objects[0]] }),
    r => ({ ...r, objects: r.objects.map(o => ({ ...o, version: {} })) }),
    r => ({ ...r, objects: r.objects.map(o => ({ ...o, version: { generation: '0' } })) }),
    r => ({ ...r, objects: r.objects.map(o => ({ ...o, bytes: -1 })) })]) {
    const s = setup(), list = s.operations.list;
    s.operations.list = async args => change(await list(args));
    const result = await executeBackupRetention({ ...s.options, apply: true });
    assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
  }
  const s = setup();
  const result = await executeBackupRetention({ ...s.options, apply: true, limits: { maxObjects: 4 } });
  assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
});

test('a replaced object is not deleted with the stale generation and failure stops further deletes', async () => {
  const s = setup(), remove = s.operations.delete;
  s.operations.delete = async args => {
    s.put(args.name, Buffer.from('replacement'));
    return remove(args);
  };
  const result = await executeBackupRetention({ ...s.options, apply: true });
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('delete_unconfirmed'));
  assert.equal(s.calls.filter(([op]) => op === 'delete').length, 1);
  assert.equal(s.objects.size, 6);
});

test('loss of a protected pair during execution aborts before the next delete', async () => {
  const s = setup(), remove = s.operations.delete;
  s.operations.delete = async args => {
    const result = await remove(args);
    s.objects.delete(s.fresh.receiptName);
    return result;
  };
  const result = await executeBackupRetention({ ...s.options, apply: true });
  assert.equal(result.status, 'partial'); assert.equal(result.deleted.length, 1);
  assert.equal(s.calls.filter(([op]) => op === 'delete').length, 1);
});

test('object replacement between list and get and lying get versions both block', async () => {
  for (const mutate of [
    (s, get) => async args => { s.put(args.name, s.objects.get(args.name).body); return get(args); },
    (s, get) => async args => ({ ...await get(args), version: { generation: '9999' } }),
  ]) {
    const s = setup(); s.operations.get = mutate(s, s.operations.get);
    const result = await executeBackupRetention({ ...s.options, apply: true });
    assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
  }
});

test('read budget, operation budget, and deletion batch bound work without bypassing preflight', async () => {
  for (const limits of [{ maxTotalReadBytes: 32 }, { maxOperations: 2 },
    { maxOperations: 15 }, { maxTotalReadBytes: 7500 }]) {
    const s = setup();
    const result = await executeBackupRetention({ ...s.options, apply: true, limits });
    assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
  }
  const s = setup();
  for (const at of ['2026-11-02T19:00:00.000Z', '2026-11-03T19:00:00.000Z']) {
    const p = pair(at); s.put(p.archiveName, p.archive); s.put(p.receiptName, p.receipt);
  }
  const result = await executeBackupRetention({ ...s.options, apply: true, limits: { maxDeletePairs: 1 } });
  assert.equal(result.status, 'applied'); assert.equal(result.deleted.length, 2);
  assert.equal(result.remainingCandidates, 2); assert.equal(s.objects.size, 8);
});

test('timeout aborts bounded reads and never starts deletion after a late response', async () => {
  const s = setup(); let signal;
  s.operations.list = async args => { signal = args.signal; await new Promise(r => setTimeout(r, 30)); return { complete: true, objects: [] }; };
  const result = await executeBackupRetention({ ...s.options, apply: true, limits: { timeoutMs: 5 } });
  assert.equal(result.status, 'blocked'); assert.ok(signal.aborted);
  assert.equal(s.objects.size, 6);
});

test('clock rollback or invalid now and non-boolean apply never delete', async () => {
  for (const now of [() => new Date('invalid'), () => new Date('2026-02-30'), (() => { let n = 0; return () => new Date(n++ ? '2026-11-12T18:59:00.000Z' : NOW); })()]) {
    const s = setup();
    const result = await executeBackupRetention({ ...s.options, now, apply: true });
    // A Date already normalised by JavaScript is valid, but cannot satisfy the current baseline/freshness gate.
    assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
  }
  const s = setup();
  const result = await executeBackupRetention({ ...s.options, apply: 'true' });
  assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
});

test('transport validation never invents GCM proof, even with well-formed unauthenticated ciphertext', async () => {
  const s = setup();
  const result = await planBackupRetention(s.options);
  assert.equal(result.status, 'ready'); assert.equal(result.restoreVerified, false);
  assert.equal(result.validation, 'transport-only');
});

test('freshness is checked after the final candidate read, immediately before DELETE', async () => {
  const s = setup(), get = s.operations.get;
  let time = NOW, archiveReads = 0;
  s.operations.get = async args => {
    const result = await get(args);
    if (args.name === s.expired.archiveName && ++archiveReads === 3) time = '2026-11-14T06:00:00.001Z';
    return result;
  };
  const result = await executeBackupRetention({ ...s.options, apply: true, now: () => new Date(time) });
  assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
  assert.equal(s.calls.filter(([op]) => op === 'delete').length, 0);
});

test('ambiguous DELETE acknowledgement reports uncertainty and never retries', async () => {
  for (const response of [undefined, { deleted: false }, 'throw', 'timeout']) {
    const s = setup(), remove = s.operations.delete;
    s.operations.delete = async args => {
      await remove(args);
      if (response === 'throw') throw new Error('synthetic credential');
      if (response === 'timeout') await new Promise(r => setTimeout(r, 250));
      return response;
    };
    const result = await executeBackupRetention({ ...s.options, apply: true, limits: { timeoutMs: 200 } });
    assert.equal(result.status, 'blocked'); assert.equal(result.unconfirmedDeletes.length, 1);
    assert.equal(s.calls.filter(([op]) => op === 'delete').length, 1);
    assert.equal(s.objects.size, 5); assert.ok(!JSON.stringify(result).includes('credential'));
  }
});

test('all malformed envelope and non-canonical base64 variants block despite matching outer hash', async () => {
  for (const mutate of [e => ({ ...e, extra: 'plaintext' }), e => ({ ...e, format: 'unknown' }),
    e => ({ ...e, encryptedKey: Buffer.alloc(383).toString('base64') }),
    e => ({ ...e, tag: Buffer.alloc(15).toString('base64') }), e => ({ ...e, ciphertext: '' }),
    e => ({ ...e, iv: e.iv + '\n' }), e => ({ ...e, ciphertext: 'YR==' })]) {
    const s = setup(), p = pair('2026-11-01T19:00:00.000Z', mutate);
    s.put(p.archiveName, p.archive); s.put(p.receiptName, p.receipt);
    const result = await executeBackupRetention({ ...s.options, apply: true });
    assert.equal(result.status, 'blocked'); assert.equal(s.objects.size, 6);
  }
});

test('unsafe version conditions, oversized receipts, read mismatch and malformed limits cannot prune', async () => {
  for (const mutate of [
    s => { s.objects.get(s.expired.archiveName).version = { etag: '*' }; },
    s => { s.objects.get(s.expired.archiveName).version = { generation: '1', etag: '"a"' }; },
    s => { s.objects.get(s.expired.archiveName).version = { generation: '01' }; },
    s => s.put(s.expired.receiptName, Buffer.alloc(4097)),
    s => { const get = s.operations.get; s.operations.get = async args => ({ ...await get(args), body: Buffer.from('bad') }); },
    s => s.put('hsr-state/hsr-state-not-a-time.enc.json', Buffer.from('invalid')),
  ]) {
    const s = setup(); mutate(s); const before = s.objects.size;
    assert.equal((await executeBackupRetention({ ...s.options, apply: true })).status, 'blocked');
    assert.equal(s.objects.size, before);
  }
  for (const limits of [null, { maxObjects: 257 }, { maxDeletePairs: 33 }, { timeoutMs: 0 }, { unknown: 1 }]) {
    const s = setup();
    assert.equal((await executeBackupRetention({ ...s.options, apply: true, limits })).status, 'blocked');
    assert.equal(s.calls.length, 0);
  }
});

test('null or malformed top-level options return a bounded sanitised failure', async () => {
  for (const options of [undefined, null, [], 'SYNTHETIC-CREDENTIAL']) {
    const result = await executeBackupRetention(options);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.deleted, []);
    assert.ok(!JSON.stringify(result).includes('CREDENTIAL'));
  }
});

test('real existing encryption and external GCM proof work without providing private keys to retention', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr-retention-encrypted-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { transfers: join(directory, 'transfers.json'), jobs: join(directory, 'jobs.json') };
  paths.security = paths.jobs + '.security.json';
  await writeFile(paths.transfers, JSON.stringify({ version: 1, transfers: {} }));
  await writeFile(paths.jobs, JSON.stringify({ version: 4, settings: {}, jobs: {}, quota: { events: [], blockedUntil: 0 } }));
  await writeFile(paths.security, JSON.stringify({ version: 1, requests: {}, sessions: {} }));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pairs = [];
  for (const at of ['2026-10-01T19:00:00.000Z', '2026-11-01T19:00:00.000Z', '2026-11-12T18:00:00.000Z']) {
    const backup = await createStateBackup({ paths, publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      assertQuiescent: async () => {}, now: () => new Date(at) });
    const verified = verifyStateBackup(backup.encrypted, privateKey, backup.receipt);
    for (const file of Object.values(verified.files)) file.fill(0);
    pairs.push({ archiveName: nameAt(at) + '.enc.json', receiptName: nameAt(at) + '.receipt.json',
      archive: backup.encrypted, receipt: Buffer.from(JSON.stringify(backup.receipt)), identity: backup.receipt });
  }
  const s = store(pairs);
  const result = await executeBackupRetention({ storage: s.operations, now: clock, apply: true,
    pinnedBaseline: { ...pairs[0].identity, archiveName: pairs[0].archiveName,
      verification: 'external-gcm-restore/v1', restoreVerifiedAt: '2026-10-02T00:00:00.000Z' } });
  assert.equal(result.status, 'applied'); assert.equal(s.objects.size, 4);
  assert.equal(result.restoreVerified, false);
});
