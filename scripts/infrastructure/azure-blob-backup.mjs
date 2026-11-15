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
  spoolConfiguration(config);
}
function spoolConfiguration(config) {
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
export async function managedIdentityToken({request=boundedRequest}={}) {
  const url='http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F';
  const response=await request(url,{headers:{Metadata:'true'},timeoutMs:5000,maxBytes:65536});
  if (response.status !== 200) throw new Error('Managed identity unavailable');
  const token=JSON.parse(response.body.toString('utf8')).access_token;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) throw new Error('Invalid managed identity response');
  return token;
}

// The only upload source: an explicit, protected canonical encrypted pair.
// Neither destination may enumerate a directory or accept arbitrary bytes.
export async function readEncryptedBackupPair({config,file,receiptFile}) {
  spoolConfiguration(config);
  // Validate names before opening any path or asking for a token.
  const name=basename(file ?? '');
  if (!/^hsr-state-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.enc\.json$/.test(name)
      || resolve(file) !== resolve(join(config.backupDirectory,name))
      || resolve(receiptFile ?? '') !== resolve(join(config.backupDirectory,name.replace(/\.enc\.json$/,'.receipt.json')))) throw new Error('Source path is not allowlisted');
  await checkSpool(config);
  const ciphertext=await boundedFile(file,MAX_ARCHIVE), receiptBytes=await boundedFile(receiptFile,MAX_RECEIPT);
  const snapshot={...JSON.parse(receiptBytes.toString('utf8')),file,receiptFile};
  const receipt=checkPair(config,snapshot,ciphertext,receiptBytes);
  return {name,ciphertext,receiptBytes,receipt,snapshot};
}
export async function validateEncryptedBackup({config,snapshot}) {
  const pair=await readEncryptedBackupPair({config,file:snapshot?.file,receiptFile:snapshot?.receiptFile});
  if (['format','createdAt','sha256','bytes','recipient'].some(k=>snapshot[k]!==pair.receipt[k])) throw new Error('Encrypted backup receipt checksum mismatch');
  return pair;
}
export async function deliverBackup({config, snapshot, request=boundedRequest, getToken=managedIdentityToken, shouldAbort=()=>false}) {
  destination(config);
  const {name,ciphertext,receiptBytes,receipt}=await validateEncryptedBackup({config,snapshot});
  if (shouldAbort()) throw new Error('Backup interrupted');
  const token=await getToken();
  const base=`https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/hsr-state/`;
  const common={authorization:`Bearer ${token}`,'x-ms-version':'2021-12-02','x-ms-date':new Date().toUTCString()};
  const pairs=[[name,ciphertext],[name.replace(/\.enc\.json$/,'.receipt.json'),receiptBytes]];
  const verify=async(blob,bytes)=>{
    if (shouldAbort()) throw new Error('Backup interrupted');
    const response=await request(base+blob,{method:'GET',headers:common,timeoutMs:60000,maxBytes:bytes.length});
    if (response.status!==200 || response.body.length!==bytes.length || digest(response.body)!==digest(bytes)) throw new Error('Blob read-back checksum failed');
  };
  const verified=new Set();
  for (const [blob,bytes] of pairs) {
    if (shouldAbort()) throw new Error('Backup interrupted');
    const response=await request(base+blob,{method:'PUT',headers:{...common,'x-ms-blob-type':'BlockBlob','if-none-match':'*','content-type':'application/octet-stream','content-length':String(bytes.length)},body:bytes,timeoutMs:60000,maxBytes:65536});
    if (response.status === 412) { await verify(blob,bytes); verified.add(blob); }
    else if (response.status !== 201) throw new Error('Blob upload failed');
  }
  for (const [blob,bytes] of pairs) {
    if (!verified.has(blob)) await verify(blob,bytes);
  }
  if (shouldAbort()) throw new Error('Backup interrupted');
  return {transportVerified:true,restoreVerified:false,createdAt:receipt.createdAt,sha256:receipt.sha256,blobPrefix:`${CONTAINER}/hsr-state/`};
}
// Only fixed local control records are read; callers/events never receive their raw contents.
export async function readMonitorSnapshot({directory='/var/lib/hsr-worker-backup-control',service,recovered=false}={}) {
  try {
    await checkSpool({backupDirectory:directory});
    const journal=JSON.parse((await boundedFile(join(directory,'journal.json'),16384)).toString('utf8'));
    if (journal.version!==1 || journal.service!==service || typeof journal.originalAdmission!=='boolean'
        || !['prepared','closing_admission','draining','stopping','stopped','snapshotting','starting','restoring_admission','complete'].includes(journal.phase)) return {};
    return {admission:recovered && journal.phase==='complete'?journal.originalAdmission:'unknown',
      journal:{phase:journal.phase,originalAdmission:journal.originalAdmission}};
  } catch { return {}; }
}
async function runDestinations({config,obtainSnapshot,request,getToken,onRecovered=()=>{},shouldAbort=()=>false,readMonitor=readMonitorSnapshot,mode='scheduled'}) {
  destination(config);
  await checkSpool(config);
  // Lazy import avoids a module cycle while both transports share the same validator.
  const {validateGcsConfiguration,createGcsBackupClient}=await import('./gcs-backup.mjs');
  const enabled=validateGcsConfiguration(config);
  if (!enabled) {
    const snapshot=await obtainSnapshot();
    await onRecovered();
    if (shouldAbort()) throw new Error('Backup interrupted');
    return deliverBackup({config,snapshot,request,getToken,shouldAbort});
  }
  const gcs=createGcsBackupClient({config,request,shouldAbort});
  const skipped=()=>({status:'skipped',transportVerified:false,restoreVerified:false});
  const perDest={azure:skipped(),gcs:skipped()};
  let snapshot,azureResult,stage=mode==='resend'?'validation':'coordinator',failed=false,recovered=false;
  try {
    snapshot=await obtainSnapshot();
    await onRecovered(); recovered=mode==='scheduled'; stage='delivery';
    // Promise callbacks also isolate synchronous throws in either destination.
    const outcomes=await Promise.allSettled([
      Promise.resolve().then(()=>deliverBackup({config,snapshot,request,getToken,shouldAbort})),
      Promise.resolve().then(()=>gcs.deliver(snapshot)),
    ]);
    for (const [index,name] of ['azure','gcs'].entries()) {
      const outcome=outcomes[index],ok=outcome.status==='fulfilled'&&outcome.value?.transportVerified===true;
      perDest[name]={status:ok?'success':'failure',transportVerified:ok,restoreVerified:false};
      if (!ok) failed=true;
      if (name==='azure'&&ok) azureResult=outcome.value;
    }
  } catch { failed=true; }
  let statusEvent;
  try {
    let monitoring={}; try {monitoring=await readMonitor({service:config.service,recovered});} catch { /* Unknown evidence remains explicit. */ }
    statusEvent=await gcs.recordStatus({result:failed?'failure':'success',stage:failed?stage:'complete',mode,perDest,
      snapshot:{...monitoring,workerHealth:recovered?'confirmed':'unknown'}});
  } catch { statusEvent={status:'failure',transportVerified:false}; }
  if (failed || statusEvent.status!=='success') {
    const error=new Error('Backup run failed; inspect destination status and protected local recovery evidence');
    error.code=failed?'BACKUP_RUN_FAILED':'BACKUP_STATUS_FAILED';
    error.perDest=perDest;error.statusEvent=statusEvent;error.stage=stage;error.mode=mode;
    throw error;
  }
  return {...azureResult,perDest,statusEvent,mode};
}
// Integration: add gcs:{enabled:true} to the protected backup.json to enable the
// pinned bucket/provider. Azure-only callers retain the original return shape.
// Dual runs return perDest + statusEvent; failures expose the same safe fields.
export async function runScheduledBackup({runCoordinator,...options}) {
  return runDestinations({...options,obtainSnapshot:async()=>{
    const result=await runCoordinator();
    if (!result || result.offVmDeliveryVerified!==false || !result.localSnapshot) throw new Error('Invalid coordinator result');
    return result.localSnapshot;
  }});
}
// CLI: node azure-blob-backup.mjs /etc/hsr-backup/backup.json --resend-pair FILE RECEIPT
// Explicit resend never calls the coordinator, changes admission, or writes local run status.
export async function resendBackupPair({config,file,receiptFile,...options}) {
  const {snapshot}=await readEncryptedBackupPair({config,file,receiptFile});
  return runDestinations({...options,config,mode:'resend',obtainSnapshot:async()=>snapshot});
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
export function parseBackupArguments(args) {
  const [configPath,flag,file,receiptFile]=args;
  if (configPath==='/etc/hsr-backup/backup.json') {
    if (args.length===1) return {configPath,mode:'scheduled'};
    if (args.length===4&&flag==='--resend-pair'&&file&&receiptFile) return {configPath,mode:'resend',file,receiptFile};
  }
  throw new Error('Expected approved configuration, optionally followed by --resend-pair FILE RECEIPT');
}
async function main() {
  const {configPath,mode,file,receiptFile}=parseBackupArguments(process.argv.slice(2));
  const resend=mode==='resend';
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || configPath !== '/etc/hsr-backup/backup.json'
      || (!resend && process.env.HSR_BACKUP_FLOCK_HELD !== '1')) throw new Error('Root, approved configuration and flock for scheduled backup required');
  let interrupted=false;
  process.on('SIGTERM',()=>{interrupted=true;}); process.on('SIGINT',()=>{interrupted=true;});
  const loadConfig=async()=>{
    const stat=await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==0 || (stat.mode & 0o077)) throw new Error('Protected root-owned configuration required');
    return JSON.parse(await readFile(configPath,'utf8'));
  };
  if (resend) {
    console.log(JSON.stringify(await resendBackupPair({config:await loadConfig(),file,receiptFile,shouldAbort:()=>interrupted})));
    return;
  }
  const result=await runMonitoredBackup({status:createStatusStore({directory:'/var/lib/hsr-worker-backup-control'}),execute:async onRecovered=>{
    const config=await loadConfig();
    if(interrupted) throw new Error('Backup interrupted');
    return runScheduledBackup({config,onRecovered,shouldAbort:()=>interrupted,runCoordinator:async()=>{
      const {stdout}=await run(process.execPath,[resolve(import.meta.dirname,'coordinated-worker-backup.mjs'),configPath,'--authorise-service-pause'],{maxBuffer:32768});
      return JSON.parse(stdout);
    }});
  }});
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{
  console.error(JSON.stringify({code:error.code==='BACKUP_STATUS_FAILED'?'BACKUP_STATUS_FAILED':'BACKUP_RUN_FAILED',
    ...(error.perDest?{perDest:error.perDest,statusEvent:error.statusEvent,stage:error.stage,mode:error.mode}:{}),
    message:'Backup delivery failed; check service, admission and protected local diagnostics. No restore verification is claimed.'}));
  process.exitCode=1;
});
