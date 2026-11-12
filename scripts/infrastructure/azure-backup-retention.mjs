import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedRequest, managedIdentityToken } from './azure-blob-backup.mjs';
import { executeBackupRetention } from './backup-retention.mjs';

const PREFIX = 'hsr-state/', ACCOUNT = 'hsrstatebackup261112', CONTAINER = 'worker-state';
const BASE = `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}`;
const ROOT = '/var/lib/hsr-worker-backups', LOCK = '/run/hsr-worker-backup.flock';
const CONFIG = '/etc/hsr-backup/backup.json', BASELINE = '/etc/hsr-backup/restore-baseline.json';
const PIN_SHA = 'ba6f02b0cc6c289352bdb215b47b09aa2cc0698af286a2a5674fdab868a4c803';
const RECIPIENT = '1b7198fa8f2009311bff67b8df7376f08809d07dc4ffb456076baf67467a56d8';
const ARCHIVE_MAX = 64 * 1024 * 1024, XML_MAX = 2 * 1024 * 1024, WEEK = 7 * 86400000;
const NAME = /^hsr-state\/hsr-state-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.(enc|receipt)\.json$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stop = () => { throw new Error('Retention safety check failed'); };
const check = condition => { if (!condition) stop(); };
const signalCheck = signal => check(signal instanceof AbortSignal && !signal.aborted);

function canonicalTime(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
  const time = Date.parse(value);
  check(Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === value);
  return time;
}
function nameTime(name) {
  check(typeof name === 'string');
  const match = NAME.exec(name); check(match);
  const raw = match[1], iso = raw.slice(0, 13) + ':' + raw.slice(14, 16) + ':' + raw.slice(17, 19) + '.' + raw.slice(20);
  return canonicalTime(iso);
}
function baseline(value) {
  check(object(value) && Object.keys(value).sort().join() === 'archiveName,bytes,createdAt,format,recipient,restoreVerifiedAt,sha256,verification');
  check(value.format === 'hsr-worker-backup/v1' && value.verification === 'external-gcm-restore/v1'
    && typeof value.createdAt === 'string'
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && typeof value.recipient === 'string' && /^[a-f0-9]{64}$/.test(value.recipient)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= ARCHIVE_MAX
    && value.archiveName === PREFIX + 'hsr-state-' + value.createdAt.replace(/[:.]/g, '-') + '.enc.json');
  check(nameTime(value.archiveName) === canonicalTime(value.createdAt)
    && canonicalTime(value.restoreVerifiedAt) >= canonicalTime(value.createdAt));
  return Object.freeze({ ...value });
}
function guard(pin, now, apply) {
  check(typeof now === 'function' && typeof apply === 'boolean');
  let previous = -1;
  const clock = () => {
    const date = now(), time = date instanceof Date ? date.getTime() : NaN;
    check(Number.isFinite(time) && time >= previous && canonicalTime(pin.restoreVerifiedAt) <= time);
    previous = time; return time;
  };
  clock();
  return { clock, deleting(name) {
    const created = nameTime(name), time = clock();
    check(apply === true && name !== pin.archiveName && name !== pin.archiveName.replace(/\.enc\.json$/, '.receipt.json')
      && created < time - WEEK);
  } };
}
function etag(value) {
  check(typeof value === 'string');
  const quoted = value.startsWith('"') ? value : `"${value}"`;
  check(/^"[A-Za-z0-9._:+/=-]{1,128}"$/.test(quoted));
  return quoted;
}
function version(value) {
  check(object(value) && Object.keys(value).join() === 'etag' && value.etag === etag(value.etag));
  return value.etag;
}

// Small bounded XML reader: no DTD, external entities, namespaces, CDATA or PIs.
// An allowlist below checks the Azure ListBlobs tree, including all pagination fields.
function xmlTree(body) {
  check(Buffer.isBuffer(body) && body.length > 0 && body.length <= XML_MAX);
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { stop(); }
  source = source.replace(/^<\?xml version="1\.0" encoding="utf-8"\?>/i, '');
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source) && !/<!|<\?/.test(source));
  function decode(text) {
    check(!/&(?!(?:amp|lt|gt|quot|apos);)/.test(text));
    return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]);
  }
  const document = { children: [], text: '' }, stack = [document];
  let offset = 0, nodes = 0;
  while (offset < source.length) {
    const current = stack.at(-1);
    if (source[offset] !== '<') {
      const end = source.indexOf('<', offset), until = end === -1 ? source.length : end;
      current.text += decode(source.slice(offset, until));
      check(current.text.length <= 8192); offset = until; continue;
    }
    const end = source.indexOf('>', offset); check(end !== -1);
    const token = source.slice(offset, end + 1); offset = end + 1;
    const closing = /^<\/([A-Za-z][A-Za-z0-9-]*)>$/.exec(token);
    if (closing) { check(stack.length > 1 && stack.at(-1).name === closing[1]); stack.pop(); continue; }
    const opening = /^<([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][A-Za-z0-9-]*="[^"<>]*")*)\s*(\/?)>$/.exec(token);
    check(opening && ++nodes <= 20000 && stack.length <= 6);
    const node = { name: opening[1], attributes: {}, children: [], text: '' };
    for (const match of opening[2].matchAll(/\s+([A-Za-z][A-Za-z0-9-]*)="([^"<>]*)"/g)) {
      check(!Object.hasOwn(node.attributes, match[1])); node.attributes[match[1]] = decode(match[2]);
    }
    current.children.push(node); if (!opening[3]) stack.push(node);
  }
  check(stack.length === 1 && document.children.length === 1 && !document.text.trim());
  return document.children[0];
}
function fields(node, allowed, required = []) {
  check(!node.text.trim());
  const map = new Map();
  for (const child of node.children) {
    check(allowed.includes(child.name) && !map.has(child.name) && Object.keys(child.attributes).length === 0);
    map.set(child.name, child);
  }
  check(required.every(key => map.has(key))); return map;
}
function scalar(node) { check(node && node.children.length === 0); return node.text; }
const PROPERTY_NAMES = ['Creation-Time', 'Last-Modified', 'Etag', 'Content-Length', 'Content-Type', 'Content-Encoding',
  'Content-Language', 'Content-MD5', 'Cache-Control', 'Content-Disposition', 'BlobType', 'AccessTier', 'AccessTierInferred',
  'AccessTierChangeTime', 'LeaseStatus', 'LeaseState', 'LeaseDuration', 'ServerEncrypted', 'ArchiveStatus', 'RehydratePriority',
  'EncryptionScope', 'ImmutabilityPolicyUntilDate', 'ImmutabilityPolicyMode', 'LegalHold', 'CopyId', 'CopyStatus', 'CopySource',
  'CopyProgress', 'CopyCompletionTime', 'CopyStatusDescription', 'IncrementalCopy', 'DestinationSnapshot'];

function inventory(body, maximum, now) {
  const root = xmlTree(body);
  check(root.name === 'EnumerationResults' && Object.keys(root.attributes).sort().join() === 'ContainerName,ServiceEndpoint'
    && root.attributes.ContainerName === CONTAINER && root.attributes.ServiceEndpoint === `https://${ACCOUNT}.blob.core.windows.net/`);
  const f = fields(root, ['Prefix', 'Marker', 'MaxResults', 'Blobs', 'NextMarker'], ['Prefix', 'Marker', 'MaxResults', 'Blobs', 'NextMarker']);
  check(scalar(f.get('Prefix')) === PREFIX && scalar(f.get('Marker')) === '' && scalar(f.get('NextMarker')) === '');
  const maxResults = scalar(f.get('MaxResults'));
  check(/^[1-9]\d{0,2}$/.test(maxResults) && Number(maxResults) <= maximum);
  const blobs = f.get('Blobs'); check(!blobs.text.trim() && blobs.children.length <= maximum);
  const names = new Set(), objects = [];
  for (const blob of blobs.children) {
    check(blob.name === 'Blob' && Object.keys(blob.attributes).length === 0);
    const b = fields(blob, ['Name', 'Properties'], ['Name', 'Properties']);
    const name = scalar(b.get('Name'));
    check(name.startsWith(PREFIX) && name.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(name) && !names.has(name)); names.add(name);
    const properties = fields(b.get('Properties'), PROPERTY_NAMES, ['Last-Modified', 'Etag', 'Content-Length', 'BlobType']);
    for (const property of properties.values()) scalar(property);
    check(scalar(properties.get('BlobType')) === 'BlockBlob');
    const bytes = scalar(properties.get('Content-Length')), modifiedText = scalar(properties.get('Last-Modified'));
    const modified = Date.parse(modifiedText);
    check(/^[1-9]\d{0,8}$/.test(bytes) && Number(bytes) <= ARCHIVE_MAX && Number.isFinite(modified)
      && new Date(modified).toUTCString() === modifiedText && modified >= 0 && modified <= now);
    objects.push({ name, bytes: Number(bytes), version: { etag: etag(scalar(properties.get('Etag'))) }, modified });
  }
  return objects;
}

/** Fixed account/container; custom request/token sources are transport injection, never URL configuration. */
export function createAzureRetentionStorage({ pinnedBaseline, apply = false, now = () => new Date(), request = boundedRequest, getToken = managedIdentityToken } = {}) {
  const pin = baseline(pinnedBaseline), safety = guard(pin, now, apply);
  check(typeof request === 'function' && typeof getToken === 'function');
  let listed = new Map(), reads = new Map(), removed = new Set(), token;
  async function call(url, method, signal, maximum, headers = {}) {
    signalCheck(signal); safety.clock();
    if (!token) token = await getToken();
    signalCheck(signal); safety.clock();
    check(typeof token === 'string' && /^[\x21-\x7e]{1,16384}$/.test(token));
    const response = await request(url, { method, signal, headers: { authorization: `Bearer ${token}`, 'x-ms-version': '2021-12-02',
      'x-ms-date': new Date(safety.clock()).toUTCString(), ...headers }, timeoutMs: 20000, maxBytes: maximum });
    signalCheck(signal); safety.clock();
    check(object(response) && Buffer.isBuffer(response.body) && response.body.length <= maximum);
    return response;
  }
  function entry(name, expected) {
    nameTime(name); const match = version(expected), item = listed.get(name);
    check(item && !removed.has(name) && item.version.etag === match); return item;
  }
  return {
    async list({ prefix, limit, signal }) {
      signalCheck(signal); check(prefix === PREFIX && Number.isSafeInteger(limit) && limit >= 1 && limit <= 257);
      const maximum = Math.min(256, limit); listed = new Map(); reads = new Map(); removed = new Set();
      const url = `${BASE}?restype=container&comp=list&prefix=hsr-state%2F&maxresults=${maximum}`;
      const response = await call(url, 'GET', signal, XML_MAX); check(response.status === 200);
      const objects = inventory(response.body, maximum, safety.clock());
      listed = new Map(objects.map(item => [item.name, item]));
      return { complete: true, objects: objects.map(({ modified, ...item }) => structuredClone(item)) };
    },
    async get({ name, version: expected, maxBytes, signal }) {
      signalCheck(signal); const item = entry(name, expected);
      check(Number.isSafeInteger(maxBytes) && maxBytes >= item.bytes && maxBytes <= ARCHIVE_MAX);
      const response = await call(BASE + '/' + name, 'GET', signal, maxBytes, { 'if-match': item.version.etag });
      check(response.status === 200 && response.body.length === item.bytes);
      // boundedRequest returns no response headers. Azure's successful If-Match GET
      // establishes the requested strong ETag; 404/412/redirects are never accepted.
      reads.set(name, item.version.etag);
      return { body: response.body, version: { ...item.version } };
    },
    async delete({ name, version: expected, signal }) {
      signalCheck(signal); safety.deleting(name);
      const item = entry(name, expected);
      check(reads.get(name) === item.version.etag && item.modified < safety.clock() - WEEK);
      // Both members must satisfy the known server-age guard before deleting either.
      // Keep immutable list metadata after the first deletion for the second check.
      const archiveName = name.replace(/\.receipt\.json$/, '.enc.json');
      for (const memberName of [archiveName, archiveName.replace(/\.enc\.json$/, '.receipt.json')]) {
        const member = listed.get(memberName);
        check(member && member.modified < safety.clock() - WEEK
          && (reads.get(memberName) === member.version.etag || removed.has(memberName)));
      }
      const response = await call(BASE + '/' + name, 'DELETE', signal, 0, { 'if-match': item.version.etag });
      check(response.status === 202); reads.delete(name); removed.add(name);
      return { deleted: true };
    },
  };
}

async function rootAuthority(io) {
  check(process.platform === 'linux' && process.getuid?.() === 0 && process.env.HSR_BACKUP_FLOCK_HELD === '1');
  const st = await io.lstat(LOCK, { bigint: true });
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0n && (st.mode & 0o7777n) === 0o600n && st.nlink === 1n);
  const ancestors = new Set(); let pid = process.pid;
  for (let i = 0; i < 32 && pid > 0; i++) {
    check(!ancestors.has(pid)); ancestors.add(pid);
    const bytes = await io.readFile(`/proc/${pid}/stat`); check(Buffer.isBuffer(bytes) && bytes.length <= 8192);
    const text = bytes.toString('utf8'), parts = text.slice(text.lastIndexOf(')') + 2).split(' ');
    pid = Number(parts[1]); check(Number.isSafeInteger(pid) && pid >= 0);
  }
  const bytes = await io.readFile('/proc/locks'); check(Buffer.isBuffer(bytes) && bytes.length <= XML_MAX);
  const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & 0xfffff000n);
  const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & 0xffffff00n);
  check(bytes.toString('utf8').split('\n').some(line => {
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/.exec(line);
    return match && ancestors.has(Number(match[1])) && BigInt('0x' + match[2]) === major
      && BigInt('0x' + match[3]) === minor && BigInt(match[4]) === st.ino;
  }));
}
const identity = st => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const localVersion = st => ({ etag: `"${hash(identity(st))}"` });
function privateFile(st) {
  check(st.isFile() && !st.isSymbolicLink() && st.uid === 0n && (st.mode & 0o7777n) === 0o600n
    && st.nlink === 1n && st.size > 0n && st.size <= BigInt(ARCHIVE_MAX));
}
async function boundedRead(handle, maximum, signal) {
  const chunks = []; let bytes = 0;
  while (true) {
    signalCheck(signal);
    const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - bytes));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) return Buffer.concat(chunks);
    bytes += bytesRead; check(bytes <= maximum); chunks.push(chunk.subarray(0, bytesRead));
  }
}

/** Production path is fixed. filesystem permits isolated synthetic filesystem/proc observations in tests. */
export async function createLocalSpoolRetentionStorage({ pinnedBaseline, apply = false, now = () => new Date(), filesystem = fs } = {}) {
  const pin = baseline(pinnedBaseline), safety = guard(pin, now, apply), io = filesystem;
  await rootAuthority(io);
  async function directory() {
    for (const path of ['/var', '/var/lib']) {
      const parent = await io.lstat(path, { bigint: true });
      check(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0n && !(parent.mode & 0o022n));
    }
    const st = await io.lstat(ROOT, { bigint: true });
    check(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0n && (st.mode & 0o7777n) === 0o700n
      && await io.realpath(ROOT) === ROOT);
    return st;
  }
  const initial = await directory();
  const dir = await io.open(ROOT, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const anchored = `/proc/self/fd/${dir.fd}`;
  let closed = false, listed = new Map(), reads = new Map();
  async function authority(signal) {
    signalCheck(signal); check(!closed); safety.clock(); await rootAuthority(io);
    const st = await directory(), held = await dir.stat({ bigint: true });
    check(st.ino === initial.ino && st.dev === initial.dev && held.ino === initial.ino && held.dev === initial.dev);
  }
  function pathFor(name) { nameTime(name); return anchored + '/' + name.slice(PREFIX.length); }
  function entry(name, expected) { const item = listed.get(name); check(item && version(expected) === item.version.etag); return item; }
  async function read(name, expected, maximum, signal) {
    await authority(signal); const path = pathFor(name), item = entry(name, expected);
    check(Number.isSafeInteger(maximum) && maximum >= item.bytes && maximum <= ARCHIVE_MAX);
    const pathStat = await io.lstat(path, { bigint: true }); privateFile(pathStat);
    check(localVersion(pathStat).etag === item.version.etag);
    const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true }); privateFile(before); check(identity(before) === identity(pathStat));
      const body = await boundedRead(handle, maximum, signal);
      const after = await handle.stat({ bigint: true }), current = await io.lstat(path, { bigint: true });
      privateFile(after); privateFile(current);
      check(identity(before) === identity(after) && identity(before) === identity(current) && body.length === item.bytes);
      await authority(signal); return { body, version: { ...item.version } };
    } finally { await handle.close(); }
  }
  return {
    async close() { if (!closed) { closed = true; await dir.close(); } },
    async list({ prefix, limit, signal }) {
      await authority(signal); check(prefix === PREFIX && Number.isSafeInteger(limit) && limit >= 1 && limit <= 257);
      listed = new Map(); reads = new Map(); let count = 0;
      const directoryHandle = await io.opendir(anchored);
      for await (const item of directoryHandle) {
        signalCheck(signal);
        if (++count > Math.min(limit, 256)) return { complete: false, objects: [] };
        // Never stat/read keys or the intentionally kept .enc.json/.receipt.json copies.
        if (!/^hsr-state-[^/]*\.(enc|receipt)\.json$/.test(item.name)) continue;
        const path = anchored + '/' + item.name, st = await io.lstat(path, { bigint: true }); privateFile(st);
        const name = PREFIX + item.name;
        listed.set(name, { name, bytes: Number(st.size), version: localVersion(st) });
      }
      await authority(signal);
      return { complete: true, objects: [...listed.values()].map(item => structuredClone(item)) };
    },
    async get({ name, version: expected, maxBytes, signal }) {
      const result = await read(name, expected, maxBytes, signal); reads.set(name, hash(result.body)); return result;
    },
    async delete({ name, version: expected, signal }) {
      await authority(signal); safety.deleting(name); const item = entry(name, expected), priorHash = reads.get(name);
      check(typeof priorHash === 'string');
      const result = await read(name, expected, item.bytes, signal); check(hash(result.body) === priorHash);
      await authority(signal); safety.deleting(name);
      const path = pathFor(name), current = await io.lstat(path, { bigint: true }); privateFile(current);
      check(localVersion(current).etag === item.version.etag); signalCheck(signal);
      // POSIX has no conditional unlink. The verified ancestor-held kernel flock and
      // root-only directory serialize cooperating writers; privileged hostile writers
      // must not bypass that lock. fd-relative paths keep parent renames from redirecting us.
      await io.unlink(path); reads.delete(name); listed.delete(name); return { deleted: true };
    },
  };
}

/** Run after successful upload inside the SAME existing flock wrapper, never ExecStartPost outside it. */
export async function runAzureBackupRetention({ config, pinnedBaseline, apply = false, now = () => new Date(),
  request, getToken, filesystem = fs } = {}) {
  check(object(config) && config.blobAccount === ACCOUNT && config.blobContainer === CONTAINER && config.backupDirectory === ROOT
    && config.backupUser === undefined && config.privateKeyPath === undefined && typeof apply === 'boolean');
  const pin = baseline(pinnedBaseline);
  const spool = await createLocalSpoolRetentionStorage({ pinnedBaseline: pin, apply, now, filesystem });
  try {
    const azure = await executeBackupRetention({ storage: createAzureRetentionStorage({ pinnedBaseline: pin, apply, now, request, getToken }),
      pinnedBaseline: pin, apply, now });
    if (!['ready', 'applied'].includes(azure.status)) return { version: 1, azure, spool: { status: 'blocked', reasons: ['azure_retention_incomplete'] } };
    return { version: 1, azure, spool: await executeBackupRetention({ storage: spool, pinnedBaseline: pin, apply, now }) };
  } finally { await spool.close(); }
}

async function protectedJson(path) {
  check([CONFIG, BASELINE].includes(path));
  for (const parent of ['/etc', '/etc/hsr-backup']) {
    const st = await fs.lstat(parent, { bigint: true });
    check(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0n && !(st.mode & 0o022n));
  }
  check(await fs.realpath(path) === path);
  const st = await fs.lstat(path, { bigint: true }); privateFile(st); check(st.size <= 16384n);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true }); privateFile(before); check(identity(before) === identity(st));
    const body = await boundedRead(handle, 16384, new AbortController().signal);
    check(identity(await handle.stat({ bigint: true })) === identity(before));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally { await handle.close(); }
}
async function main() {
  const args = process.argv.slice(2);
  check(args[0] === CONFIG && (args.length === 1 || (args.length === 2 && args[1] === '--apply'))
    && (process.env.HSR_BACKUP_BASELINE_PATH === undefined || process.env.HSR_BACKUP_BASELINE_PATH === BASELINE));
  await rootAuthority(fs);
  const config = await protectedJson(CONFIG), pin = baseline(await protectedJson(BASELINE));
  check(pin.sha256 === PIN_SHA && pin.recipient === RECIPIENT);
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; }); process.on('SIGTERM', () => { interrupted = true; });
  const result = await runAzureBackupRetention({ config, pinnedBaseline: pin, apply: args[1] === '--apply',
    now: () => { check(!interrupted); return new Date(); } });
  console.log(JSON.stringify(result));
  if (![result.azure.status, result.spool.status].every(status => ['ready', 'applied'].includes(status))) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('Retention operation failed; no deletion or restore success is claimed. Inspect protected local diagnostics.'); process.exitCode = 1;
});
