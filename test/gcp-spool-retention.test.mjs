import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normaliseGcpSpoolBaseline, parseGcpSpoolRetentionArguments,
  createGcpSpoolRetentionStorage, runGcpSpoolRetention, runGcpSpoolRetentionFromFiles,
} from '../scripts/infrastructure/gcp-spool-retention.mjs';
import { executeBackupRetention } from '../scripts/infrastructure/backup-retention.mjs';

const ROOT = '/var/lib/hsr-worker-backups-gcp-production';
const LOCK = '/run/hsr-worker-backup.flock';
const CONTROL = '/var/lib/hsr-worker-backup-control';
const CONFIG = '/etc/hsr-gcp-production/backup.json';
const PIN_PATH = '/etc/hsr-gcp-production/restore-baseline.json';
const NOW = '2026-11-15T20:00:00.000Z', clock = () => new Date(NOW);
const digest = body => createHash('sha256').update(body).digest('hex');
const signal = () => new AbortController().signal;
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;
const run = promisify(execFile);

function pair(at) {
  const archive = Buffer.from(JSON.stringify({ format: 'hsr-worker-backup/v1',
    encryptedKey: Buffer.alloc(384, 1).toString('base64'), iv: Buffer.alloc(12, 2).toString('base64'),
    tag: Buffer.alloc(16, 3).toString('base64'), ciphertext: Buffer.from(at).toString('base64') }));
  const identity = { format: 'hsr-worker-backup/v1', createdAt: at, sha256: digest(archive),
    bytes: archive.length, recipient: 'a'.repeat(64) };
  const stem = `hsr-state/hsr-state-${at.replace(/[:.]/g, '-')}`;
  return { name: stem + '.enc.json', receiptName: stem + '.receipt.json', archive,
    receipt: Buffer.from(JSON.stringify(identity)), identity };
}
const pinned = pair('2026-10-01T19:00:00.000Z');
const expired = pair('2026-11-01T19:00:00.000Z');
const fresh = pair('2026-11-15T19:00:00.000Z');
const pin = { ...pinned.identity, archiveName: pinned.name, verification: 'external-gcm-restore/v1',
  restoreVerifiedAt: '2026-10-02T00:00:00.000Z' };
const config = { service: 'hsr-worker-production.service', endpoint: 'http://127.0.0.1:8787/',
  environmentFile: '/etc/hsr-gcp-production/worker.env', publicKeyPath: '/etc/hsr-gcp-production/recipient-public.pem',
  backupDirectory: ROOT, paths: { transfers: '/var/lib/hsr-transfer-worker-production/transfers.json',
    jobs: '/var/lib/hsr-transfer-worker-production/jobs.json', security: '/var/lib/hsr-transfer-worker-production/jobs.json.security.json' },
  gcs: { enabled: true, bucket: 'hsr-worker-backups-282550645630', archivePrefix: 'gcp-production/hsr-state/',
    eventPrefix: 'gcp-production/monitor/events/' }, azureSecondary: { enabled: false } };
const upload = { transportVerified: true, restoreVerified: false, createdAt: fresh.identity.createdAt,
  sha256: fresh.identity.sha256, bucket: config.gcs.bucket, objectPrefix: config.gcs.archivePrefix,
  mode: 'scheduled', perDest: { azure: { status: 'skipped', transportVerified: false, restoreVerified: false },
    gcs: { status: 'success', transportVerified: true, restoreVerified: false } },
  statusEvent: { status: 'success', transportVerified: true,
    object: 'gcp-production/monitor/events/2026-11-15T19-00-04-000Z-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json' } };
const status = { version: 1, result: 'success', lastAttemptAt: '2026-11-15T18:59:00.000Z',
  lastSuccessAt: '2026-11-15T19:00:05.000Z', lastFailureAt: null, stage: 'complete', workerHealth: 'confirmed',
  transportVerified: true, restoreVerified: false };
const journal = { version: 1, runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', service: config.service,
  originalAdmission: true, phase: 'complete', updatedAt: '2026-11-15T19:00:02.000Z' };

test('local pin is canonical and a GCP cloud pin requires explicit translation without changing its attestation', () => {
  assert.deepEqual(normaliseGcpSpoolBaseline(pin), pin);
  const cloud = { ...pin, archiveName: 'gcp-production/' + pin.archiveName };
  assert.throws(() => normaliseGcpSpoolBaseline(cloud));
  assert.deepEqual(normaliseGcpSpoolBaseline(cloud, 'gcp'), pin);
  assert.equal(cloud.archiveName, 'gcp-production/' + pin.archiveName);
  assert.throws(() => normaliseGcpSpoolBaseline(pin, 'gcp'));
  for (const patch of [{ verification: 'transport-only' }, { archiveName: 'hsr-state/../key.enc.json' },
    { restoreVerifiedAt: '2026-09-01T00:00:00.000Z' }, { recipient: 'invalid' }, { bytes: 0 },
    { privateKeyPath: '/private/forbidden' }]) assert.throws(() => normaliseGcpSpoolBaseline({ ...pin, ...patch }));
});

test('CLI pins config, confines the external pin to /etc/hsr-gcp-production, and requires explicit apply/translation', () => {
  assert.deepEqual(parseGcpSpoolRetentionArguments([CONFIG, PIN_PATH]),
    { configPath: CONFIG, pinPath: PIN_PATH, apply: false, baselineNamespace: 'local' });
  assert.deepEqual(parseGcpSpoolRetentionArguments([CONFIG, PIN_PATH, '--pin-namespace=gcp', '--apply']),
    { configPath: CONFIG, pinPath: PIN_PATH, apply: true, baselineNamespace: 'gcp' });
  for (const args of [[], [CONFIG], ['/tmp/config.json', PIN_PATH], [CONFIG, '/etc/other/pin.json'],
    [CONFIG, CONFIG], [CONFIG, '/etc/hsr-gcp-production/../pin.json'], [CONFIG, PIN_PATH, '--apply', '--apply'],
    [CONFIG, PIN_PATH, '--unknown'], [CONFIG, PIN_PATH, '--pin-namespace=auto'],
    [CONFIG, PIN_PATH, '--pin-namespace=gcp', '--pin-namespace=local']]) {
    assert.throws(() => parseGcpSpoolRetentionArguments(args));
  }
});

// Native ext4 fixtures live on the D-backed WSL VHD. Only fixed system paths and
// /proc observations are translated; no production path or lock is created.
async function fixture(t) {
  const base = await fs.mkdtemp(join(tmpdir(), 'hsr-gcp-spool-'));
  const directory = join(base, 'spool'), control = join(base, 'control'), etc = join(base, 'config');
  for (const path of [base, directory, control, etc]) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const lock = join(base, 'lock'); await fs.writeFile(lock, '', { mode: 0o600 });
  const mapped = path => path === ROOT ? directory : path === LOCK ? lock
    : path === CONTROL ? control : path.startsWith(CONTROL + '/') ? control + path.slice(CONTROL.length)
      : path === '/etc/hsr-gcp-production' ? etc : path.startsWith('/etc/hsr-gcp-production/')
        ? etc + path.slice('/etc/hsr-gcp-production'.length) : path;
  let locked = true, unlinks = [], onUnlink;
  const filesystem = { ...fs,
    lstat: (path, ...args) => fs.lstat(mapped(path), ...args),
    open: (path, ...args) => fs.open(mapped(path), ...args),
    realpath: async path => [ROOT, CONTROL, '/etc/hsr-gcp-production'].includes(path)
      ? (await fs.realpath(mapped(path)), path) : fs.realpath(mapped(path)),
    async readFile(path, ...args) {
      if (path === '/proc/locks') {
        const st = await fs.stat(lock, { bigint: true }), dev = st.dev;
        const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
        const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
        return Buffer.from(locked ? `1: FLOCK ADVISORY WRITE ${process.pid} ${major.toString(16)}:${minor.toString(16)}:${st.ino} 0 EOF\n` : '');
      }
      return fs.readFile(mapped(path), ...args);
    },
    async unlink(path) { unlinks.push(path); if (onUnlink) return onUnlink(path); return fs.unlink(path); },
  };
  const write = async (path, value) => fs.writeFile(mapped(path), JSON.stringify(value), { mode: 0o600 });
  async function add(p) {
    await fs.writeFile(join(directory, p.name.slice(10)), p.archive, { mode: 0o600 });
    await fs.writeFile(join(directory, p.receiptName.slice(10)), p.receipt, { mode: 0o600 });
  }
  for (const p of [pinned, expired, fresh]) await add(p);
  await write(CONTROL + '/status.json', status); await write(CONTROL + '/journal.json', journal);
  await write(CONFIG, config); await write(PIN_PATH, pin);
  const old = process.env.HSR_BACKUP_FLOCK_HELD; process.env.HSR_BACKUP_FLOCK_HELD = '1';
  t.after(async () => {
    if (old === undefined) delete process.env.HSR_BACKUP_FLOCK_HELD; else process.env.HSR_BACKUP_FLOCK_HELD = old;
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, directory, control, lock, filesystem, add, write, unlinks,
    unlock: () => { locked = false; }, setUnlink: fn => { onUnlink = fn; } };
}
const options = (f, patch = {}) => ({ config, pinnedBaseline: pin, successfulUpload: upload,
  filesystem: f.filesystem, now: clock, ...patch });

test('default dry-run and explicit apply prune only expired pairs and preserve external baseline, newest and unknown files',
  { skip: !linuxRoot }, async t => {
    const f = await fixture(t);
    for (const name of ['private.pem', '.enc.json', '.receipt.json', 'operator-note.txt']) {
      await fs.writeFile(join(f.directory, name), 'synthetic-do-not-read', { mode: 0o600 });
    }
    const dry = await runGcpSpoolRetention(options(f));
    assert.equal(dry.status, 'ready'); assert.equal(dry.mode, 'dry-run'); assert.equal(f.unlinks.length, 0);
    const result = await runGcpSpoolRetention(options(f, { apply: true }));
    assert.equal(result.status, 'applied'); assert.equal(result.restoreVerified, false);
    assert.deepEqual(result.deleted.sort(), [expired.name, expired.receiptName].sort());
    const names = await fs.readdir(f.directory);
    for (const name of [pinned.name.slice(10), fresh.name.slice(10), 'private.pem', '.enc.json', '.receipt.json', 'operator-note.txt']) {
      assert.ok(names.includes(name));
    }
  });

test('scheduled upload identity, successful event and matching local status/journal are all required before any pruning',
  { skip: !linuxRoot }, async t => {
    const cases = [
      ['missing upload', null], ['resend', { ...upload, mode: 'resend' }],
      ['failed transport', { ...upload, transportVerified: false }],
      ['failed event', { ...upload, statusEvent: { ...upload.statusEvent, status: 'failure' } }],
      ['skipped GCS', { ...upload, perDest: { ...upload.perDest, gcs: { ...upload.perDest.gcs, status: 'skipped' } } }],
      ['foreign bucket', { ...upload, bucket: 'other' }],
    ];
    for (const [name, successfulUpload] of cases) await t.test(name, async sub => {
      const f = await fixture(sub);
      await assert.rejects(runGcpSpoolRetention(options(f, { successfulUpload, apply: true })));
      assert.equal(f.unlinks.length, 0);
    });
    await t.test('uploaded hash must match the actual canonical archive', async sub => {
      const f = await fixture(sub);
      const result = await runGcpSpoolRetention(options(f,
        { successfulUpload: { ...upload, sha256: 'b'.repeat(64) }, apply: true }));
      assert.equal(result.status, 'blocked'); assert.equal(f.unlinks.length, 0);
    });
    for (const [name, record, patch] of [
      ['failed state', 'status', { result: 'failure' }], ['running state', 'status', { result: 'running' }],
      ['unverified worker', 'status', { workerHealth: 'unknown' }],
      ['old success', 'status', { lastSuccessAt: '2026-11-14T19:00:00.000Z' }],
      ['unfinished journal', 'journal', { phase: 'starting' }],
      ['other service', 'journal', { service: 'other.service' }],
      ['old journal', 'journal', { updatedAt: '2026-11-14T19:00:00.000Z' }],
    ]) await t.test(name, async sub => {
      const f = await fixture(sub);
      await f.write(`${CONTROL}/${record}.json`, { ...(record === 'status' ? status : journal), ...patch });
      await assert.rejects(runGcpSpoolRetention(options(f, { apply: true })));
      assert.equal(f.unlinks.length, 0);
    });
  });

test('unuploaded newer pair and absent uploaded pair block deletion even when a fresh old success exists', { skip: !linuxRoot }, async t => {
  for (const newer of [true, false]) await t.test(newer ? 'newer local snapshot' : 'missing uploaded pair', async sub => {
    const f = await fixture(sub);
    if (newer) await f.add(pair('2026-11-15T19:30:00.000Z'));
    else await fs.unlink(join(f.directory, fresh.name.slice(10)));
    const result = await runGcpSpoolRetention(options(f, { apply: true }));
    assert.equal(result.status, 'blocked'); assert.equal(f.unlinks.length, 0);
  });
});

test('seven-day exclusive cutoff and exactly 36-hour fresh successor work through the local adapter', { skip: !linuxRoot }, async t => {
  const f = await fixture(t), boundary = pair('2026-11-08T20:00:00.000Z'); await f.add(boundary);
  const result = await runGcpSpoolRetention(options(f, { apply: true }));
  assert.equal(result.status, 'applied'); assert.ok((await fs.readdir(f.directory)).includes(boundary.name.slice(10)));
  const future = () => new Date('2026-11-17T07:00:00.000Z');
  assert.equal((await runGcpSpoolRetention(options(f, { now: future }))).status, 'ready');
  await assert.rejects(runGcpSpoolRetention(options(f, { now: () => new Date('2026-11-17T07:00:00.001Z') })));
});

test('malformed and orphan pairs block the complete preflight without deleting unknown files', { skip: !linuxRoot }, async t => {
  for (const kind of ['name', 'receipt', 'orphan']) await t.test(kind, async sub => {
    const f = await fixture(sub);
    if (kind === 'name') await fs.writeFile(join(f.directory, 'hsr-state-bad.enc.json'), '{}', { mode: 0o600 });
    if (kind === 'receipt') await fs.writeFile(join(f.directory, expired.receiptName.slice(10)), '{}', { mode: 0o600 });
    if (kind === 'orphan') await fs.unlink(join(f.directory, expired.receiptName.slice(10)));
    const result = await runGcpSpoolRetention(options(f, { apply: true }));
    assert.equal(result.status, 'blocked'); assert.equal(f.unlinks.length, 0);
  });
});

test('unsafe directories, symlinks, hardlinks, permissions, missing flag and lost kernel flock fail closed', { skip: !linuxRoot }, async t => {
  for (const kind of ['directory', 'file', 'symlink', 'unknown symlink', 'hardlink', 'status symlink', 'flag', 'flock']) {
    await t.test(kind, async sub => {
      const f = await fixture(sub), file = join(f.directory, expired.name.slice(10));
      if (kind === 'directory') await fs.chmod(f.directory, 0o755);
      if (kind === 'file') await fs.chmod(file, 0o644);
      if (kind === 'symlink') { await fs.unlink(file); await fs.symlink('/does-not-exist', file); }
      if (kind === 'unknown symlink') await fs.symlink('/does-not-exist', join(f.directory, 'unknown'));
      if (kind === 'hardlink') await fs.link(file, join(f.directory, 'unknown'));
      if (kind === 'status symlink') { await fs.unlink(join(f.control, 'status.json')); await fs.symlink('/does-not-exist', join(f.control, 'status.json')); }
      if (kind === 'flag') delete process.env.HSR_BACKUP_FLOCK_HELD;
      if (kind === 'flock') f.unlock();
      try {
        const result = await runGcpSpoolRetention(options(f, { apply: true })); assert.equal(result.status, 'blocked');
      } catch (error) { assert.match(error.message, /^GCP spool retention /); }
      assert.equal(f.unlinks.length, 0);
    });
  }
});

test('adapter blocks candidate mutation, directory replacement and lock loss between list/read/delete', { skip: !linuxRoot }, async t => {
  for (const kind of ['file', 'directory', 'flock']) await t.test(kind, async sub => {
    const f = await fixture(sub), storage = await createGcpSpoolRetentionStorage(options(f, { apply: true }));
    sub.after(() => storage.close());
    const listed = await storage.list({ prefix: 'hsr-state/', limit: 257, signal: signal() });
    const item = listed.objects.find(entry => entry.name === expired.name);
    await storage.get({ ...item, maxBytes: 4096, signal: signal() });
    if (kind === 'file') await fs.writeFile(join(f.directory, expired.name.slice(10)), Buffer.alloc(expired.archive.length, 9));
    if (kind === 'directory') { await fs.rename(f.directory, f.directory + '-old'); await fs.mkdir(f.directory, { mode: 0o700 }); }
    if (kind === 'flock') f.unlock();
    await assert.rejects(storage.delete({ ...item, signal: signal() })); assert.equal(f.unlinks.length, 0);
  });
});

test('adapter independently refuses direct anchor, young, arbitrary and unverified deletions', { skip: !linuxRoot }, async t => {
  const f = await fixture(t), storage = await createGcpSpoolRetentionStorage(options(f, { apply: true }));
  t.after(() => storage.close());
  const listing = await storage.list({ prefix: 'hsr-state/', limit: 257, signal: signal() });
  for (const name of [pinned.name, fresh.name, 'keys/private.pem', 'hsr-state/../private.pem', expired.name]) {
    const item = listing.objects.find(entry => entry.name === name);
    await assert.rejects(storage.delete({ name, version: item?.version ?? { etag: '"x"' }, signal: signal() }));
  }
  assert.equal(f.unlinks.length, 0);
});

test('ambiguous unlink is never retried and a partially deleted pair blocks the next run', { skip: !linuxRoot }, async t => {
  const f = await fixture(t);
  f.setUnlink(async path => { await fs.unlink(path); throw new Error('synthetic uncertainty'); });
  const result = await runGcpSpoolRetention(options(f, { apply: true }));
  assert.equal(result.status, 'blocked'); assert.equal(result.unconfirmedDeletes.length, 1); assert.equal(f.unlinks.length, 1);
  f.setUnlink(null);
  const retry = await runGcpSpoolRetention(options(f, { apply: true }));
  assert.equal(retry.status, 'blocked'); assert.equal(f.unlinks.length, 1);
});

test('an oversized inventory cannot cause partial pruning', { skip: !linuxRoot }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 251; i++) await fs.writeFile(join(f.directory, `unknown-${i}`), 'keep', { mode: 0o600 });
  const result = await runGcpSpoolRetention(options(f, { apply: true }));
  assert.equal(result.status, 'blocked'); assert.equal(f.unlinks.length, 0);
});

test('aborted operations, oversized files and clock rollback preserve every pair', { skip: !linuxRoot }, async t => {
  await t.test('abort before list and delete', async sub => {
    const f = await fixture(sub), storage = await createGcpSpoolRetentionStorage(options(f, { apply: true }));
    sub.after(() => storage.close());
    const controller = new AbortController(); controller.abort();
    await assert.rejects(storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller.signal }));
    await assert.rejects(storage.delete({ name: expired.name, version: { etag: '"x"' }, signal: controller.signal }));
    assert.equal(f.unlinks.length, 0);
  });
  await t.test('oversized archive', async sub => {
    const f = await fixture(sub);
    await fs.truncate(join(f.directory, expired.name.slice(10)), 64 * 1024 * 1024 + 1);
    const result = await runGcpSpoolRetention(options(f, { apply: true }));
    assert.equal(result.status, 'blocked'); assert.equal(f.unlinks.length, 0);
  });
  await t.test('clock rollback after opening spool', async sub => {
    const f = await fixture(sub); let calls = 0;
    const storage = await createGcpSpoolRetentionStorage(options(f,
      { apply: true, now: () => new Date(Date.parse(NOW) - calls++ * 1000) }));
    sub.after(() => storage.close());
    await assert.rejects(storage.list({ prefix: 'hsr-state/', limit: 257, signal: signal() }));
    assert.equal(f.unlinks.length, 0);
  });
});

test('protected CLI inputs reject namespace drift, config overrides, key paths and symlinked pin', { skip: !linuxRoot }, async t => {
  const f = await fixture(t);
  const args = { configPath: CONFIG, pinPath: PIN_PATH, successfulUpload: upload, filesystem: f.filesystem, now: clock };
  assert.equal((await runGcpSpoolRetentionFromFiles(args)).status, 'ready');
  await f.write(PIN_PATH, { ...pin, archiveName: 'gcp-production/' + pin.archiveName });
  await assert.rejects(runGcpSpoolRetentionFromFiles(args));
  assert.equal((await runGcpSpoolRetentionFromFiles({ ...args, baselineNamespace: 'gcp' })).status, 'ready');
  await f.write(PIN_PATH, pin);
  for (const patch of [{ backupDirectory: '/tmp/unsafe' }, { privateKeyPath: '/private/forbidden' },
    { azureSecondary: { enabled: true } }, { service: 'other.service' }]) {
    await f.write(CONFIG, { ...config, ...patch }); await assert.rejects(runGcpSpoolRetentionFromFiles(args));
  }
  await f.write(CONFIG, config);
  const target = join(f.base, 'external-pin.json'); await fs.writeFile(target, JSON.stringify(pin), { mode: 0o600 });
  await fs.unlink(join(f.base, 'config', 'restore-baseline.json')); await fs.symlink(target, join(f.base, 'config', 'restore-baseline.json'));
  await assert.rejects(runGcpSpoolRetentionFromFiles(args)); assert.equal(f.unlinks.length, 0);
});

test('environment assertion alone never grants root/kernel authority', async () => {
  const old = process.env.HSR_BACKUP_FLOCK_HELD; process.env.HSR_BACKUP_FLOCK_HELD = '1';
  try { await assert.rejects(createGcpSpoolRetentionStorage({ pinnedBaseline: pin, successfulUpload: upload, now: clock })); }
  finally { if (old === undefined) delete process.env.HSR_BACKUP_FLOCK_HELD; else process.env.HSR_BACKUP_FLOCK_HELD = old; }
});

test('closing during an uncertain unlink retains the directory descriptor until that operation settles', { skip: !linuxRoot }, async t => {
  const f = await fixture(t), storage = await createGcpSpoolRetentionStorage(options(f, { apply: true }));
  t.after(() => storage.close());
  const listing = await storage.list({ prefix: 'hsr-state/', limit: 257, signal: signal() });
  const item = listing.objects.find(entry => entry.name === expired.name);
  await storage.get({ ...item, maxBytes: 4096, signal: signal() });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  f.setUnlink(async path => { entered(); await delayed; await fs.unlink(path); });
  const deletion = storage.delete({ ...item, signal: signal() });
  await started;
  await storage.close();
  release();
  assert.deepEqual(await deletion, { deleted: true });
  await assert.rejects(storage.list({ prefix: 'hsr-state/', limit: 257, signal: signal() }));
  assert.equal(f.unlinks.length, 1);
});

test('real ancestor flock protects the isolated native Linux spool', { skip: !linuxRoot }, async t => {
  const f = await fixture(t);
  const source = `
    import * as fs from 'node:fs/promises';
    import { createGcpSpoolRetentionStorage } from './scripts/infrastructure/gcp-spool-retention.mjs';
    const directory=${JSON.stringify(f.directory)}, lock=${JSON.stringify(f.lock)};
    const io={...fs,lstat:(p,...a)=>fs.lstat(p==='${ROOT}'?directory:p==='${LOCK}'?lock:p,...a),
      open:(p,...a)=>fs.open(p==='${ROOT}'?directory:p,...a),realpath:async p=>p==='${ROOT}'?'${ROOT}':fs.realpath(p)};
    const storage=await createGcpSpoolRetentionStorage({pinnedBaseline:${JSON.stringify(pin)},successfulUpload:${JSON.stringify(upload)},filesystem:io,now:()=>new Date('${NOW}')});
    try {const result=await storage.list({prefix:'hsr-state/',limit:257,signal:new AbortController().signal}); console.log(JSON.stringify({complete:result.complete,count:result.objects.length}));}
    finally {await storage.close();}
  `;
  const { stdout } = await run('flock', ['--exclusive', '--nonblock', f.lock, process.execPath, '--input-type=module', '-e', source],
    { cwd: process.cwd(), timeout: 10000, env: { ...process.env, HSR_BACKUP_FLOCK_HELD: '1' } });
  assert.deepEqual(JSON.parse(stdout), { complete: true, count: 6 });
});

test('invalid CLI requests return only a fixed diagnostic and never enter cloud or production paths', async () => {
  for (const args of [[CONFIG, PIN_PATH, '--bad=SYNTHETIC_PRIVATE'], ['/tmp/SYNTHETIC_PRIVATE', PIN_PATH]]) {
    const result = await run(process.execPath, ['scripts/infrastructure/gcp-spool-retention.mjs', ...args],
      { timeout: 5000 }).catch(error => error);
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^GCP spool retention failed;/); assert.doesNotMatch(result.stderr, /SYNTHETIC_PRIVATE|Error:|\/etc\//);
  }
});
