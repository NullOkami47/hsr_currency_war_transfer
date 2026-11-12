import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeBackupRetention } from '../scripts/infrastructure/backup-retention.mjs';
import { createAzureRetentionStorage, createLocalSpoolRetentionStorage, runAzureBackupRetention }
  from '../scripts/infrastructure/azure-backup-retention.mjs';

const NOW = '2026-11-12T19:00:00.000Z', clock = () => new Date(NOW);
const ROOT = '/var/lib/hsr-worker-backups', LOCK = '/run/hsr-worker-backup.flock';
const BASE = 'https://hsrstatebackup261112.blob.core.windows.net/worker-state';
const digest = b => createHash('sha256').update(b).digest('hex');
const stamp = at => `hsr-state/hsr-state-${at.replace(/[:.]/g, '-')}`;

function pair(at) {
  const archive = Buffer.from(JSON.stringify({ format: 'hsr-worker-backup/v1', encryptedKey: Buffer.alloc(384, 1).toString('base64'),
    iv: Buffer.alloc(12, 2).toString('base64'), tag: Buffer.alloc(16, 3).toString('base64'), ciphertext: Buffer.from('synthetic').toString('base64') }));
  const receipt = { format: 'hsr-worker-backup/v1', createdAt: at, sha256: digest(archive), bytes: archive.length, recipient: 'a'.repeat(64) };
  return { name: stamp(at) + '.enc.json', receiptName: stamp(at) + '.receipt.json', archive, receipt: Buffer.from(JSON.stringify(receipt)), identity: receipt };
}
const pinned = pair('2026-10-01T19:00:00.000Z'), expired = pair('2026-11-01T19:00:00.000Z'), fresh = pair('2026-11-12T18:00:00.000Z');
const pin = { ...pinned.identity, archiveName: pinned.name, verification: 'external-gcm-restore/v1', restoreVerifiedAt: '2026-10-02T00:00:00.000Z' };
const controller = () => new AbortController();
const requestArgs = name => ({ name, version: { etag: '"etag-3"' }, signal: controller().signal });
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function fakeAzure() {
  const objects = new Map(), calls = [];
  let sequence = 0;
  for (const p of [pinned, expired, fresh]) {
    for (const [name, body] of [[p.name, p.archive], [p.receiptName, p.receipt]]) {
      objects.set(name, { body, etag: `"etag-${++sequence}"`, modified: p.identity.createdAt });
    }
  }
  function xml() {
    return `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="${BASE.split('/worker-state')[0]}/" ContainerName="worker-state"><Prefix>hsr-state/</Prefix><Marker/><MaxResults>256</MaxResults><Blobs>${[...objects].map(([name, o]) => `<Blob><Name>${xmlEscape(name)}</Name><Properties><Last-Modified>${new Date(o.modified).toUTCString()}</Last-Modified><Etag>${xmlEscape(o.etag)}</Etag><Content-Length>${o.body.length}</Content-Length><BlobType>BlockBlob</BlobType><LeaseStatus>unlocked</LeaseStatus><ServerEncrypted>true</ServerEncrypted></Properties></Blob>`).join('')}</Blobs><NextMarker/></EnumerationResults>`;
  }
  async function request(url, options) {
    calls.push({ url, ...options });
    assert.ok(url.startsWith(BASE));
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    if (url.includes('?')) return { status: 200, body: Buffer.from(xml()) };
    const name = decodeURIComponent(url.slice((BASE + '/').length)), entry = objects.get(name);
    if (!entry) return { status: 404, body: Buffer.alloc(0) };
    if (options.headers['if-match'] !== entry.etag) return { status: 412, body: Buffer.alloc(0) };
    if (options.method === 'DELETE') { objects.delete(name); return { status: 202, body: Buffer.alloc(0) }; }
    return { status: 200, body: Buffer.from(entry.body) };
  }
  return { objects, calls, request, xml };
}
function azure(s, extra = {}) {
  return createAzureRetentionStorage({ pinnedBaseline: pin, request: s.request, getToken: async () => 'synthetic-token', now: clock, ...extra });
}

test('Azure dry-run uses fixed scoped list and conditional reads without DELETE', async () => {
  const s = fakeAzure(), storage = azure(s);
  const result = await executeBackupRetention({ storage, pinnedBaseline: pin, now: clock });
  assert.equal(result.status, 'ready'); assert.equal(s.objects.size, 6);
  const list = new URL(s.calls[0].url);
  assert.equal(list.origin + list.pathname, BASE); assert.equal(list.searchParams.get('prefix'), 'hsr-state/');
  assert.equal(list.searchParams.get('maxresults'), '256'); assert.equal(list.searchParams.has('include'), false);
  assert.ok(s.calls.slice(1).every(c => c.method === 'GET' && /^"etag-\d+"$/.test(c.headers['if-match'])));
  assert.ok(s.calls.every(c => c.method !== 'DELETE' && c.maxBytes <= 64 * 1024 * 1024));
});

// Read-only production ListBlobs, API 2021-12-02, 2026-11-12: no Marker,
// empty Content-CRC64 inside Properties and empty OrMetadata beside Properties.
// Payloads/ETags/names remain synthetic; this records the observed XML structure.
function observedAzureXml(xml) {
  return xml.replace('<Marker/>', '').replaceAll('<Properties>', '<Properties><Content-CRC64 />')
    .replaceAll('</Properties>', '</Properties><OrMetadata />');
}

test('actual Azure empty-page-marker schema passes the complete dry-run without any DELETE', async () => {
  const s = fakeAzure(), request = s.request;
  const storage = azure(s, { request: async (url, options) => {
    const response = await request(url, options);
    return url.includes('?') ? { ...response, body: Buffer.from(observedAzureXml(response.body.toString('utf8'))) } : response;
  } });
  const result = await executeBackupRetention({ storage, pinnedBaseline: pin, now: clock });
  assert.equal(result.status, 'ready'); assert.equal(result.mode, 'dry-run'); assert.equal(s.objects.size, 6);
  assert.equal(s.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.deepEqual(result.candidates.map(p => p.archiveName), [expired.name]);
});

for (const [description, transform] of [
  ['omitted Marker when no marker was requested', xml => xml.replace('<Marker/>', '')],
  ['empty Content-CRC64 property', xml => xml.replaceAll('<Properties>', '<Properties><Content-CRC64 />')],
  ['empty OrMetadata sibling', xml => xml.replaceAll('</Properties>', '</Properties><OrMetadata />')],
]) {
  test(`Azure accepts observed ${description}`, async () => {
    const s = fakeAzure();
    const storage = azure(s, { request: async () => ({ status: 200, body: Buffer.from(transform(s.xml())) }) });
    const result = await storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal });
    assert.equal(result.complete, true); assert.equal(result.objects.length, 6);
  });
}

test('observed schema still rejects pagination ambiguity and nonempty or malformed optional metadata', async () => {
  const s = fakeAzure(), original = observedAzureXml(s.xml());
  for (const xml of [
    original.replace('<NextMarker/>', ''),
    original.replace('<NextMarker/>', '<NextMarker>opaque-continuation</NextMarker>'),
    original.replace('<NextMarker/>', '<Marker>opaque-continuation</Marker><NextMarker/>'),
    original.replace('<NextMarker/>', '<ContinuationToken>opaque</ContinuationToken><NextMarker/>'),
    original.replace('<NextMarker/>', '<Marker/><Marker/><NextMarker/>'),
    original.replace('<OrMetadata />', '<OrMetadata>unsupported</OrMetadata>'),
    original.replace('<OrMetadata />', '<OrMetadata><Unknown/></OrMetadata>'),
    original.replace('<OrMetadata />', '<OrMetadata policy="unsupported"/>'),
    original.replace('<OrMetadata />', '<OrMetadata/><OrMetadata/>'),
    original.replace('<Content-CRC64 />', '<Content-CRC64><Unknown/></Content-CRC64>'),
    original.replace('<Content-CRC64 />', '<Content-CRC64/><Content-CRC64/>'),
    original.replace('<Content-CRC64 />', '<Content-CRC64 other="unsupported"/>'),
    original.replace('<Content-CRC64 />', '<UnrecognisedField/>'),
  ]) {
    const storage = azure(s, { request: async () => ({ status: 200, body: Buffer.from(xml) }) });
    await assert.rejects(storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal }));
  }
});

test('Azure apply removes only expired pair with exact ETag and no snapshots/versions option', async () => {
  const s = fakeAzure(), storage = azure(s, { apply: true });
  const result = await executeBackupRetention({ storage, pinnedBaseline: pin, now: clock, apply: true });
  assert.equal(result.status, 'applied'); assert.equal(result.deleted.length, 2);
  assert.ok(s.objects.has(pinned.name)); assert.ok(s.objects.has(fresh.name)); assert.ok(!s.objects.has(expired.name));
  const deletes = s.calls.filter(c => c.method === 'DELETE');
  assert.deepEqual(deletes.map(c => c.headers['if-match']), ['"etag-3"', '"etag-4"']);
  assert.ok(deletes.every(c => !c.url.includes('?') && !Object.hasOwn(c.headers, 'x-ms-delete-snapshots')));
});

test('Azure adapter independently rejects baseline, young, traversal, wrong prefix, missing read and implicit apply', async () => {
  const s = fakeAzure(), storage = azure(s, { apply: true });
  await storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal });
  for (const name of [pinned.name, pinned.receiptName, fresh.name, 'keys/private.pem', 'hsr-state/../keys/private.pem', 'other/' + expired.name]) {
    await assert.rejects(storage.delete(requestArgs(name)));
  }
  await assert.rejects(storage.delete(requestArgs(expired.name))); // Not previously read and verified.
  const dry = azure(s);
  await assert.rejects(dry.delete(requestArgs(expired.name)));
  assert.equal(s.calls.filter(c => c.method === 'DELETE').length, 0);
  await assert.rejects(storage.list({ prefix: '', limit: 257, signal: controller().signal }));
});

test('exact seven days and recently copied old names are protected by adapter age checks', async () => {
  for (const [name, modified] of [
    [expired.name, '2026-11-05T19:00:00.000Z'], [expired.name, '2026-11-12T18:00:00.000Z'],
    [expired.receiptName, '2026-11-05T19:00:00.000Z'], [expired.receiptName, '2026-11-12T18:00:00.000Z'],
  ]) {
    const s = fakeAzure(); s.objects.get(name).modified = modified;
    const storage = azure(s, { apply: true });
    const result = await executeBackupRetention({ storage, pinnedBaseline: pin, now: clock, apply: true });
    assert.equal(result.status, 'blocked'); assert.equal(s.calls.filter(c => c.method === 'DELETE').length, 0);
    assert.equal(s.objects.size, 6);
  }
});

test('strict XML refuses DTD, entities, malformed shape, duplicate fields, unknown pagination and oversize', async () => {
  const s = fakeAzure(), original = s.xml();
  const bad = [
    original.replace('<EnumerationResults ', '<!DOCTYPE e [<!ENTITY secret SYSTEM "file:///keys">]><EnumerationResults '),
    original.replace('<NextMarker/>', '<NextMarker>more</NextMarker>'),
    original.replace('<NextMarker/>', '<ContinuationToken>more</ContinuationToken><NextMarker/>'),
    original.replace('<Marker/>', '<Marker>old</Marker>'),
    original.replace('</Blobs>', '<BlobPrefix><Name>hsr-state/</Name></BlobPrefix></Blobs>'),
    original.replace('<Etag>', '<Etag>"extra"</Etag><Etag>'),
    original.replace('<Content-Length>', '<Unknown/><Content-Length>'),
    original.replace('</Blob>', '</Wrong>'),
    original.replace('hsr-state/hsr-state-', '&secret;hsr-state-'),
    original.replace('ContainerName="worker-state"', 'ContainerName="other"'),
    original.replace('<NextMarker/>', '<NextMarker/><NextMarker/>'),
    original.replace('<BlobType>BlockBlob', '<BlobType>AppendBlob'),
    'x'.repeat(2 * 1024 * 1024 + 1),
  ];
  for (const xml of bad) {
    const storage = azure(s, { request: async () => ({ status: 200, body: Buffer.from(xml) }) });
    await assert.rejects(storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal }));
  }
});

test('bare XML ETags are strongly quoted; more than 256 objects or duplicate names fail closed', async () => {
  const s = fakeAzure();
  const bare = s.xml().replaceAll('&quot;', '');
  const storage = azure(s, { request: async () => ({ status: 200, body: Buffer.from(bare) }) });
  const result = await storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal });
  assert.equal(result.objects[0].version.etag, '"etag-1"');
  const firstBlob = s.xml().match(/<Blob>.*?<\/Blob>/)[0];
  for (const xml of [s.xml().replace('</Blobs>', firstBlob + '</Blobs>'), s.xml().replace(/<Blobs>.*<\/Blobs>/, `<Blobs>${firstBlob.repeat(257)}</Blobs>`)]) {
    const bad = azure(s, { request: async () => ({ status: 200, body: Buffer.from(xml) }) });
    await assert.rejects(bad.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal }));
  }
});

test('Azure changed ETag/HTTP failure/body mismatch cannot become a successful deletion', async () => {
  for (const code of [404, 409, 412, 500]) {
    const s = fakeAzure(), request = s.request;
    s.request = async (url, options) => options.method === 'DELETE' ? { status: code, body: Buffer.alloc(0) } : request(url, options);
    const result = await executeBackupRetention({ storage: azure(s, { apply: true }), pinnedBaseline: pin, now: clock, apply: true });
    assert.equal(result.status, 'blocked'); assert.equal(result.unconfirmedDeletes.length, 1); assert.equal(s.objects.size, 6);
  }
  const s = fakeAzure(), storage = azure(s);
  await storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal });
  s.objects.get(expired.name).etag = '"new-etag"';
  await assert.rejects(storage.get({ ...requestArgs(expired.name), maxBytes: 1024 }));
});

test('aborted or late token retrieval never sends a subsequent request', async () => {
  const s = fakeAzure(), c = controller();
  const storage = azure(s, { getToken: async () => { c.abort(); return 'synthetic-token'; } });
  await assert.rejects(storage.list({ prefix: 'hsr-state/', limit: 257, signal: c.signal }));
  assert.equal(s.calls.length, 0);
});

const posixRoot = process.platform !== 'linux' || process.getuid?.() !== 0;

// A real private on-disk spool, with only fixed system paths/proc observations translated.
// No production directory or kernel lock is created. The lock table is synthetic evidence.
async function spoolFixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'hsr-retention-spool-')); await fs.chmod(directory, 0o700);
  const lock = join(directory, '.synthetic-lock'); await fs.writeFile(lock, '', { mode: 0o600 });
  const mapped = path => path === ROOT ? directory : path === LOCK ? lock : path;
  let locked = true;
  const filesystem = { ...fs,
    lstat: (p, ...args) => fs.lstat(mapped(p), ...args),
    open: (p, ...args) => fs.open(mapped(p), ...args),
    realpath: async p => p === ROOT ? (await fs.realpath(directory), ROOT) : fs.realpath(p),
    async readFile(p, ...args) {
      if (p === '/proc/locks') {
        const st = await fs.stat(lock, { bigint: true }), dev = st.dev;
        const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
        const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
        const line = locked ? `1: FLOCK ADVISORY WRITE ${process.pid} ${major.toString(16)}:${minor.toString(16)}:${st.ino} 0 EOF\n` : '';
        return Buffer.from(line);
      }
      return fs.readFile(mapped(p), ...args);
    },
  };
  for (const p of [pinned, expired, fresh]) {
    await fs.writeFile(join(directory, p.name.slice('hsr-state/'.length)), p.archive, { mode: 0o600 });
    await fs.writeFile(join(directory, p.receiptName.slice('hsr-state/'.length)), p.receipt, { mode: 0o600 });
  }
  const old = process.env.HSR_BACKUP_FLOCK_HELD; process.env.HSR_BACKUP_FLOCK_HELD = '1';
  t.after(async () => { if (old === undefined) delete process.env.HSR_BACKUP_FLOCK_HELD; else process.env.HSR_BACKUP_FLOCK_HELD = old; await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, filesystem, unlock: () => { locked = false; } };
}

test('local real spool dry-run then apply preserves baseline, newest, keys and malformed initial-copy orphans', { skip: posixRoot }, async t => {
  const f = await spoolFixture(t);
  for (const name of ['private.pem', '.enc.json', '.receipt.json']) await fs.writeFile(join(f.directory, name), 'keep', { mode: 0o600 });
  const storage = await createLocalSpoolRetentionStorage({ pinnedBaseline: pin, now: clock, apply: true, filesystem: f.filesystem });
  t.after(() => storage.close());
  const dry = await executeBackupRetention({ storage, pinnedBaseline: pin, now: clock });
  assert.equal(dry.status, 'ready');
  const result = await executeBackupRetention({ storage, pinnedBaseline: pin, now: clock, apply: true });
  assert.equal(result.status, 'applied'); assert.equal(result.deleted.length, 2);
  const names = await fs.readdir(f.directory);
  assert.ok(!names.includes(expired.name.slice(10))); assert.ok(names.includes(pinned.name.slice(10)));
  assert.ok(names.includes(fresh.name.slice(10))); assert.ok(names.includes('private.pem')); assert.ok(names.includes('.enc.json'));
});

test('local adapter independently rejects pinned/young/arbitrary objects, changed content and lost flock', { skip: posixRoot }, async t => {
  const f = await spoolFixture(t);
  const storage = await createLocalSpoolRetentionStorage({ pinnedBaseline: pin, now: clock, apply: true, filesystem: f.filesystem });
  t.after(() => storage.close());
  const listing = await storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal });
  for (const name of [pinned.name, fresh.name, 'keys/private.pem', 'hsr-state/../private.pem']) {
    await assert.rejects(storage.delete({ name, version: { etag: '"x"' }, signal: controller().signal }));
  }
  const entry = listing.objects.find(o => o.name === expired.name);
  await storage.get({ ...entry, maxBytes: 4096, signal: controller().signal });
  await fs.writeFile(join(f.directory, expired.name.slice(10)), Buffer.alloc(expired.archive.length, 1));
  await assert.rejects(storage.delete({ ...entry, signal: controller().signal }));
  f.unlock();
  await assert.rejects(storage.list({ prefix: 'hsr-state/', limit: 257, signal: controller().signal }));
  assert.ok((await fs.readdir(f.directory)).includes(expired.name.slice(10)));
});

test('local unsafe directory, symlink, hardlink and file permissions block before pruning', { skip: posixRoot }, async t => {
  for (const kind of ['directory', 'symlink', 'hardlink', 'file', 'missing-env']) {
    await t.test(kind, async sub => {
      const f = await spoolFixture(sub), path = join(f.directory, expired.name.slice(10));
      if (kind === 'directory') await fs.chmod(f.directory, 0o755);
      if (kind === 'file') await fs.chmod(path, 0o644);
      if (kind === 'symlink') { await fs.unlink(path); await fs.symlink(join(f.directory, 'private.pem'), path); }
      if (kind === 'hardlink') await fs.link(path, join(f.directory, 'private.pem'));
      if (kind === 'missing-env') delete process.env.HSR_BACKUP_FLOCK_HELD;
      let storage;
      try {
        storage = await createLocalSpoolRetentionStorage({ pinnedBaseline: pin, now: clock, apply: true, filesystem: f.filesystem });
        const result = await executeBackupRetention({ storage, pinnedBaseline: pin, now: clock, apply: true });
        assert.equal(result.status, 'blocked'); assert.equal(result.deleted.length, 0);
      } catch (error) { assert.match(error.message, /^Retention /); }
      finally { await storage?.close(); }
    });
  }
});

test('local non-root platform and absent real kernel lock cannot be bypassed by the env flag', async () => {
  const old = process.env.HSR_BACKUP_FLOCK_HELD; process.env.HSR_BACKUP_FLOCK_HELD = '1';
  try { await assert.rejects(createLocalSpoolRetentionStorage({ pinnedBaseline: pin, now: clock })); }
  finally { if (old === undefined) delete process.env.HSR_BACKUP_FLOCK_HELD; else process.env.HSR_BACKUP_FLOCK_HELD = old; }
});

test('local authority accepts a real ancestor-owned exclusive kernel flock on isolated D-drive fixture', { skip: posixRoot }, async t => {
  const f = await spoolFixture(t), lockPath = join(f.directory, '.synthetic-lock');
  if ((await fs.statfs(f.directory)).type === 0x1021997) {
    t.skip('WSL drvfs does not expose this lock as FLOCK in /proc/locks; use native Linux filesystem'); return;
  }
  const source = `
    import * as fs from 'node:fs/promises';
    import { createLocalSpoolRetentionStorage } from './scripts/infrastructure/azure-backup-retention.mjs';
    const directory = ${JSON.stringify(f.directory)}, lockPath = ${JSON.stringify(lockPath)};
    const io = { ...fs,
      lstat: (p,...a) => fs.lstat(p === '${ROOT}' ? directory : p === '${LOCK}' ? lockPath : p,...a),
      open: (p,...a) => fs.open(p === '${ROOT}' ? directory : p,...a),
      realpath: async p => p === '${ROOT}' ? '${ROOT}' : fs.realpath(p),
    };
    const storage = await createLocalSpoolRetentionStorage({pinnedBaseline:${JSON.stringify(pin)},now:()=>new Date('${NOW}'),filesystem:io});
    try { const result=await storage.list({prefix:'hsr-state/',limit:257,signal:new AbortController().signal}); console.log(JSON.stringify({complete:result.complete,count:result.objects.length})); }
    finally { await storage.close(); }
  `;
  const { stdout } = await promisify(execFile)('flock', ['--exclusive', '--nonblock', lockPath, process.execPath, '--input-type=module', '-e', source],
    { cwd: process.cwd(), timeout: 5000, env: { ...process.env, HSR_BACKUP_FLOCK_HELD: '1' } });
  assert.deepEqual(JSON.parse(stdout), { complete: true, count: 6 });
});

test('runner rejects destination/spool/config overrides and malformed baseline before token/network', async () => {
  let calls = 0;
  const config = { blobAccount: 'hsrstatebackup261112', blobContainer: 'worker-state', backupDirectory: ROOT };
  for (const patch of [{ blobAccount: 'evil' }, { blobContainer: 'other' }, { backupDirectory: '/tmp/other' }, { backupUser: 'user' }]) {
    await assert.rejects(runAzureBackupRetention({ config: { ...config, ...patch }, pinnedBaseline: pin,
      request: async () => { calls++; }, getToken: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test('runner coordinates Azure and spool with same policy and stops local prune after Azure failure', { skip: posixRoot }, async t => {
  for (const failAzure of [false, true]) {
    await t.test(failAzure ? 'Azure failure preserves local spool' : 'default runner dry-run and explicit apply', async sub => {
      const f = await spoolFixture(sub), s = fakeAzure();
      const config = { blobAccount: 'hsrstatebackup261112', blobContainer: 'worker-state', backupDirectory: ROOT };
      const options = { config, pinnedBaseline: pin, now: clock, filesystem: f.filesystem, request: s.request, getToken: async () => 'synthetic-token' };
      const dry = await runAzureBackupRetention(options);
      assert.equal(dry.azure.status, 'ready'); assert.equal(dry.spool.status, 'ready');
      if (failAzure) options.request = async () => ({ status: 500, body: Buffer.alloc(0) });
      const result = await runAzureBackupRetention({ ...options, apply: true });
      if (failAzure) {
        assert.equal(result.azure.status, 'blocked'); assert.equal(result.spool.status, 'blocked');
        assert.ok((await fs.readdir(f.directory)).includes(expired.name.slice(10)));
      } else {
        assert.equal(result.azure.status, 'applied'); assert.equal(result.spool.status, 'applied');
        assert.ok(!(await fs.readdir(f.directory)).includes(expired.name.slice(10)));
      }
    });
  }
});

test('CLI rejects wrong path, unknown or duplicate flags without exposing errors or touching cloud', async () => {
  for (const args of [[], ['/arbitrary/secret.json', '--apply'], ['/etc/hsr-backup/backup.json', '--apply=true'],
    ['/etc/hsr-backup/backup.json', '--apply', '--apply']]) {
    try {
      await promisify(execFile)(process.execPath, ['scripts/infrastructure/azure-backup-retention.mjs', ...args], { cwd: process.cwd(), timeout: 5000 });
      assert.fail('must fail');
    } catch (error) {
      assert.equal(error.code, 1); assert.ok(!error.stderr.includes('secret.json')); assert.equal(error.stdout, '');
      assert.match(error.stderr, /Retention operation failed/);
    }
  }
});
