import { constants } from 'node:fs';
import { open, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { createStatusStore } from './backup-control-state.mjs';

const ACCOUNT = 'hsrstatebackup261112', CONTAINER = 'worker-state';
const FORMAT = 'hsr-worker-backup/v1', MAX_ARCHIVE = 64 * 1024 * 1024, MAX_RECEIPT = 4096;
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function destination(config) {
  if (config?.blobAccount !== ACCOUNT || config?.blobContainer !== CONTAINER) throw new Error('Destination is not allowlisted');
  if (typeof config.backupDirectory !== 'string' || !isAbsolute(config.backupDirectory)) throw new Error('Absolute spool path required');
  if (config.backupUser !== undefined) throw new Error('Collector ownership is forbidden for this root-owned spool');
}
async function boundedFile(path, limit) {
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Source symlink forbidden');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Invalid protected bounded source file');
    const chunks = []; let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error('Source exceeds limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}
async function checkSpool(config) {
  const spool = await lstat(config.backupDirectory);
  if (!spool.isDirectory() || spool.isSymbolicLink() || (process.platform !== 'win32' && (spool.uid !== process.getuid() || (spool.mode & 0o077)))) throw new Error('Protected owner-only spool required');
}
function checkPair(config, snapshot, ciphertext, receiptBytes) {
  const name = basename(snapshot.file ?? '');
  if (!/^hsr-state-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.enc\.json$/.test(name)
      || resolve(snapshot.file) !== resolve(join(config.backupDirectory, name))
      || resolve(snapshot.receiptFile ?? '') !== resolve(join(config.backupDirectory, name.replace(/\.enc\.json$/, '.receipt.json')))) throw new Error('Source path is not allowlisted');
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (Object.keys(receipt).sort().join() !== 'bytes,createdAt,format,recipient,sha256'
      || receipt.format !== FORMAT || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !/^[a-f0-9]{64}$/.test(receipt.recipient)
      || receipt.bytes !== ciphertext.length || digest(ciphertext) !== receipt.sha256
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.createdAt)
      || name !== 'hsr-state-' + receipt.createdAt.replace(/[:.]/g, '-') + '.enc.json'
      || ['format','createdAt','sha256','bytes','recipient'].some(k => snapshot[k] !== receipt[k])) throw new Error('Encrypted backup receipt checksum mismatch');
  const envelope = JSON.parse(ciphertext.toString('utf8'));
  const fields = ['encryptedKey','iv','tag','ciphertext'];
  if (Object.keys(envelope).sort().join() !== 'ciphertext,encryptedKey,format,iv,tag' || envelope.format !== FORMAT
      || fields.some(k => typeof envelope[k] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope[k]))
      || Buffer.from(envelope.encryptedKey,'base64').length < 384 || Buffer.from(envelope.iv,'base64').length !== 12
      || Buffer.from(envelope.tag,'base64').length !== 16 || Buffer.from(envelope.ciphertext,'base64').length === 0) throw new Error('Invalid encrypted envelope');
  return receipt;
}

// Native HTTP clients do not consult proxy environment variables or follow redirects.
// A single absolute deadline covers connection, headers and response body.
export function boundedRequest(url, { method='GET', headers={}, body, timeoutMs=20000, maxBytes=MAX_ARCHIVE } = {}) {
  return new Promise((resolveRequest, reject) => {
    const parsed = new URL(url), client = parsed.protocol === 'https:' ? https : http;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const req = client.request(parsed, {method, headers, signal:controller.signal, agent:false}, res => {
      const chunks=[]; let total=0;
      res.on('data', chunk => { total += chunk.length; if (total > maxBytes) { const error = new Error('Response exceeds limit'); clearTimeout(timer); reject(error); req.destroy(error); return; } chunks.push(chunk); });
      res.on('end', () => { clearTimeout(timer); resolveRequest({status:res.statusCode,body:Buffer.concat(chunks)}); });
      res.on('error', error => {clearTimeout(timer);reject(error);});
    });
    req.on('error', error => {clearTimeout(timer);reject(error);});
    req.end(body);
  });
}
export async function managedIdentityToken() {
  const url='http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F';
  const response=await boundedRequest(url,{headers:{Metadata:'true'},timeoutMs:5000,maxBytes:65536});
  if (response.status !== 200) throw new Error('Managed identity unavailable');
  const token=JSON.parse(response.body.toString('utf8')).access_token;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) throw new Error('Invalid managed identity response');
  return token;
}

export async function deliverBackup({config, snapshot, request=boundedRequest, getToken=managedIdentityToken, shouldAbort=()=>false}) {
  destination(config);
  // Validate names before opening any path or asking for a token.
  const name=basename(snapshot?.file ?? '');
  if (!/^hsr-state-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.enc\.json$/.test(name)
      || resolve(snapshot.file) !== resolve(join(config.backupDirectory,name))
      || resolve(snapshot.receiptFile ?? '') !== resolve(join(config.backupDirectory,name.replace(/\.enc\.json$/,'.receipt.json')))) throw new Error('Source path is not allowlisted');
  await checkSpool(config);
  const ciphertext=await boundedFile(snapshot.file,MAX_ARCHIVE), receiptBytes=await boundedFile(snapshot.receiptFile,MAX_RECEIPT);
  const receipt=checkPair(config,snapshot,ciphertext,receiptBytes);
  const token=await getToken();
  const base=`https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/hsr-state/`;
  const common={authorization:`Bearer ${token}`,'x-ms-version':'2021-12-02','x-ms-date':new Date().toUTCString()};
  const pairs=[[name,ciphertext],[name.replace(/\.enc\.json$/,'.receipt.json'),receiptBytes]];
  for (const [blob,bytes] of pairs) {
    if (shouldAbort()) throw new Error('Backup interrupted');
    const response=await request(base+blob,{method:'PUT',headers:{...common,'x-ms-blob-type':'BlockBlob','if-none-match':'*','content-type':'application/octet-stream','content-length':String(bytes.length)},body:bytes,timeoutMs:60000,maxBytes:65536});
    if (response.status !== 201) throw new Error('Blob upload failed');
  }
  for (const [blob,bytes] of pairs) {
    if (shouldAbort()) throw new Error('Backup interrupted');
    const response=await request(base+blob,{method:'GET',headers:common,timeoutMs:60000,maxBytes:bytes.length});
    if (response.status !== 200 || response.body.length !== bytes.length || digest(response.body) !== digest(bytes)) throw new Error('Blob read-back checksum failed');
  }
  if (shouldAbort()) throw new Error('Backup interrupted');
  return {transportVerified:true,restoreVerified:false,createdAt:receipt.createdAt,sha256:receipt.sha256,blobPrefix:`${CONTAINER}/hsr-state/`};
}
export async function runScheduledBackup({config,runCoordinator,request,getToken,onRecovered=()=>{},shouldAbort=()=>false}) {
  destination(config);
  await checkSpool(config);
  const result=await runCoordinator();
  if (!result || result.offVmDeliveryVerified !== false || !result.localSnapshot) throw new Error('Invalid coordinator result');
  await onRecovered();
  if (shouldAbort()) throw new Error('Backup interrupted');
  return deliverBackup({config,snapshot:result.localSnapshot,request,getToken,shouldAbort});
}
export async function runMonitoredBackup({status,execute,now=()=>new Date().toISOString()}) {
  let stage='coordinator',workerHealth='unknown';
  await status.start(now());
  try {
    const result=await execute(async()=>{stage='delivery';workerHealth='confirmed';await status.recovered();});
    if (result?.transportVerified!==true) throw new Error('Delivery verification missing');
    await status.success(now()); return result;
  } catch(error) { await status.failure(now(),stage,workerHealth); throw error; }
}
async function main() {
  const [configPath] = process.argv.slice(2);
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || configPath !== '/etc/hsr-backup/backup.json' || process.env.HSR_BACKUP_FLOCK_HELD !== '1') throw new Error('Root, flock wrapper and approved configuration path required');
  let interrupted=false;
  process.on('SIGTERM',()=>{interrupted=true;}); process.on('SIGINT',()=>{interrupted=true;});
  const result=await runMonitoredBackup({status:createStatusStore({directory:'/var/lib/hsr-worker-backup-control'}),execute:async onRecovered=>{
    const stat=await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) throw new Error('Protected root-owned configuration required');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    if(interrupted) throw new Error('Backup interrupted');
    return runScheduledBackup({config,onRecovered,shouldAbort:()=>interrupted,runCoordinator:async()=>{
      const {stdout}=await run(process.execPath,[resolve(import.meta.dirname,'coordinated-worker-backup.mjs'),configPath,'--authorise-service-pause'],{maxBuffer:32768});
      return JSON.parse(stdout);
    }});
  }});
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{console.error('Backup delivery failed; check service, admission, and protected local diagnostics. No restore verification is claimed.');process.exitCode=1;});
