import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { createStateBackup } from '../scripts/infrastructure/worker-state-backup.mjs';
import * as backupApi from '../scripts/infrastructure/azure-blob-backup.mjs';
const { deliverBackup, runScheduledBackup } = backupApi;

const key = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey.export({ type: 'spki', format: 'pem' });
const config = { blobAccount: 'hsrstatebackup261112', blobContainer: 'worker-state' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hsr-blob-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { transfers: join(root, 'transfers'), jobs: join(root, 'jobs') }; paths.security = paths.jobs + '.security.json';
  await writeFile(paths.transfers, JSON.stringify({version:1,transfers:{}}));
  await writeFile(paths.jobs, JSON.stringify({version:4,settings:{},jobs:{},quota:{events:[],blockedUntil:0}}));
  await writeFile(paths.security, JSON.stringify({version:1,requests:{},sessions:{}}));
  const backup = await createStateBackup({paths, publicKey:key, assertQuiescent:async()=>{}, now:()=>new Date('2026-11-12T01:00:00.000Z')});
  const spool = join(root, 'spool'); await mkdir(spool, {mode:0o700});
  const stem = join(spool, 'hsr-state-2026-11-12T01-00-00-000Z');
  await writeFile(stem+'.enc.json',backup.encrypted,{mode:0o600}); await writeFile(stem+'.receipt.json',JSON.stringify(backup.receipt)+'\n',{mode:0o600});
  return {root, config:{...config,backupDirectory:spool}, snapshot:{...backup.receipt,file:stem+'.enc.json',receiptFile:stem+'.receipt.json'}};
}
function fakeStore({ corrupt, fail } = {}) {
  const objects = new Map(), requests = [];
  const request = async (url, options) => {
    requests.push({url, ...options});
    if (fail === requests.length) throw new Error('transport failure');
    if (options.method === 'PUT') {
      if (objects.has(url)) return {status:412, body:Buffer.alloc(0)};
      objects.set(url,Buffer.from(options.body)); return {status:201, body:Buffer.alloc(0)};
    }
    const body=objects.get(url); if (!body) return {status:404,body:Buffer.alloc(0)};
    return {status:200,body:corrupt && url.endsWith(corrupt) ? Buffer.from('corrupted') : Buffer.from(body)};
  };
  return {objects,requests,request};
}
const token = async () => 'synthetic-token';

test('encrypted snapshot and receipt are uploaded without overwrite and both read back before success', async t => {
  const f=await fixture(t), s=fakeStore();
  const result=await deliverBackup({config:f.config,snapshot:f.snapshot,request:s.request,getToken:token});
  assert.equal(result.transportVerified,true); assert.equal(result.restoreVerified,false);
  assert.equal(s.requests.length,4);
  assert.deepEqual(s.requests.map(r=>r.method),['PUT','PUT','GET','GET']);
  assert.ok(s.requests.every(r=>r.url.startsWith('https://hsrstatebackup261112.blob.core.windows.net/worker-state/hsr-state/')));
  assert.ok(s.requests.slice(0,2).every(r=>r.headers['if-none-match']==='*'));
  assert.deepEqual(s.objects.get(s.requests[0].url),await readFile(f.snapshot.file));
  assert.deepEqual(s.objects.get(s.requests[1].url),await readFile(f.snapshot.receiptFile));
});

test('destination changes and non-allowlisted source paths fail before token or network', async t => {
  const f=await fixture(t), s=fakeStore(); let tokens=0; const getToken=async()=>{tokens++;return 'synthetic-token';};
  for (const c of [{...f.config,blobAccount:'evil'}, {...f.config,blobContainer:'other'}])
    await assert.rejects(deliverBackup({config:c,snapshot:f.snapshot,request:s.request,getToken}),/destination/i);
  await assert.rejects(deliverBackup({config:f.config,snapshot:{...f.snapshot,file:join(f.root,'private-key.pem')},request:s.request,getToken}),/source|path/i);
  assert.equal(tokens,0); assert.equal(s.requests.length,0);
});

test('plaintext, tampered ciphertext and mismatched receipt are rejected before network', async t => {
  const f=await fixture(t), s=fakeStore();
  await writeFile(f.snapshot.file,'{"secret":"plaintext"}');
  await assert.rejects(deliverBackup({config:f.config,snapshot:f.snapshot,request:s.request,getToken:token}),/checksum|encrypted/i);
  assert.equal(s.requests.length,0);
});

test('readback corruption, failed upload and collision never claim verified delivery or delete data', async t => {
  const f=await fixture(t);
  for (const opts of [{corrupt:'.enc.json'}, {corrupt:'.receipt.json'}, {fail:2}]) {
    const s=fakeStore(opts); await assert.rejects(deliverBackup({config:f.config,snapshot:f.snapshot,request:s.request,getToken:token}));
    assert.ok(s.requests.every(r=>r.method!=='DELETE'));
  }
  const s=fakeStore(); await deliverBackup({config:f.config,snapshot:f.snapshot,request:s.request,getToken:token});
  assert.equal((await deliverBackup({config:f.config,snapshot:f.snapshot,request:s.request,getToken:token})).transportVerified,true);
  s.objects.set(s.requests[0].url,Buffer.from('collision'));
  await assert.rejects(deliverBackup({config:f.config,snapshot:f.snapshot,request:s.request,getToken:token}),/checksum|collision/i);
  assert.ok(await readFile(f.snapshot.file));
});

test('scheduled delivery waits for successful coordinator recovery and never sends on coordinator failure', async t => {
  const f=await fixture(t), s=fakeStore(), events=[];
  const runCoordinator=async()=>{events.push('recovered');return {localSnapshot:f.snapshot,offVmDeliveryVerified:false};};
  const result=await runScheduledBackup({config:f.config,runCoordinator,request:async(...args)=>{events.push('request');return s.request(...args);},getToken:token});
  assert.equal(events[0],'recovered'); assert.equal(result.transportVerified,true);
  await assert.rejects(runScheduledBackup({config:f.config,runCoordinator:async()=>{throw new Error('recovery failed');},request:s.request,getToken:token}));
  assert.equal(s.requests.length,4);
});

test('bounded transport stops slow responses and refuses bodies larger than the cap', async t => {
  const { createServer }=await import('node:http');
  const { boundedRequest }=await import('../scripts/infrastructure/azure-blob-backup.mjs');
  const server=createServer((req,res)=>{if(req.url==='/slow'){res.writeHead(200);res.write('a');}else{res.end('123456');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  await assert.rejects(boundedRequest(base+'/slow',{timeoutMs:100,maxBytes:20}));
  await assert.rejects(boundedRequest(base+'/big',{timeoutMs:1000,maxBytes:4}));
});

test('scheduled backup refuses a non-root collector ownership configuration before pausing the worker', async t => {
  const f=await fixture(t); let called=false;
  await assert.rejects(runScheduledBackup({config:{...f.config,backupUser:'azureuser'},runCoordinator:async()=>{called=true;}}),/owner|collector/i);
  assert.equal(called,false);
});

test('POSIX spool accessible to other users is rejected before coordinator runs', {skip:process.platform==='win32'}, async t => {
  const {chmod}=await import('node:fs/promises'); const f=await fixture(t); await chmod(f.config.backupDirectory,0o755); let called=false;
  await assert.rejects(runScheduledBackup({config:f.config,runCoordinator:async()=>{called=true;}}),/spool/i);
  assert.equal(called,false);
});

const gcsConfig={enabled:true,bucket:'hsr-worker-backups-282550645630',audience:'//iam.googleapis.com/projects/282550645630/locations/global/workloadIdentityPools/hsr-azure-backup/providers/azure-vm'};
function fakeGcs({fail=false}={}) {
  const objects=new Map(),requests=[];
  const request=async(url,options)=>{
    requests.push({url,...options}); const u=new URL(url);
    if(u.hostname==='169.254.169.254')return {status:200,body:Buffer.from('{"access_token":"synthetic-azure"}')};
    if(u.hostname==='sts.googleapis.com')return {status:200,body:Buffer.from(JSON.stringify({access_token:'synthetic-gcp',token_type:'Bearer',issued_token_type:'urn:ietf:params:oauth:token-type:access_token',expires_in:3600}))};
    if(options.method==='POST'){
      const name=u.searchParams.get('name');
      if(fail&&name.startsWith('hsr-state/'))return {status:403,body:Buffer.from('secret')};
      if(objects.has(name))return {status:412,body:Buffer.alloc(0)};
      objects.set(name,Buffer.from(options.body));return {status:200,body:Buffer.from('{}')};
    }
    const name=decodeURIComponent(u.pathname.split('/o/')[1]);
    return {status:objects.has(name)?200:404,body:objects.get(name)??Buffer.alloc(0)};
  };
  return {objects,requests,request};
}
function dualRequest(azure,gcs) {return (url,o)=>new URL(url).hostname.endsWith('.blob.core.windows.net')?azure.request(url,o):gcs.request(url,o);}
const monitor=async()=>({workerHealth:'confirmed',admission:true,journal:{phase:'complete',originalAdmission:true,token:'secret'},token:'secret'});

test('enabled GCS shares exactly one recovered snapshot with Azure and records per-destination success',async t=>{
  const f=await fixture(t),azure=fakeStore(),gcs=fakeGcs();let coordinated=0,recovered=false;
  const result=await runScheduledBackup({config:{...f.config,gcs:gcsConfig},runCoordinator:async()=>{coordinated++;return {localSnapshot:f.snapshot,offVmDeliveryVerified:false};},
    onRecovered:()=>{recovered=true;},readMonitor:monitor,getToken:token,request:(url,o)=>{assert.equal(recovered,true);return dualRequest(azure,gcs)(url,o);}});
  assert.equal(coordinated,1); assert.equal(result.perDest?.azure.status,'success');assert.equal(result.perDest?.gcs.status,'success');
  assert.equal(result.statusEvent.status,'success');
  const ciphertext=[...gcs.objects].find(([name])=>name.endsWith('.enc.json'))[1];
  assert.deepEqual(ciphertext,azure.objects.get(azure.requests[0].url));
  const event=JSON.parse([...gcs.objects].find(([name])=>name.startsWith('monitor/events/'))[1]);
  assert.equal(event.result,'success');assert.equal(event.snapshot.journal.phase,'complete');assert.equal(event.snapshot.admission,true);
});

test('each failed destination still allows the other to finish and emits a safe failure event',async t=>{
  const f=await fixture(t);
  for(const failed of ['azure','gcs']){
    const azure=fakeStore({fail:failed==='azure'?1:undefined}),gcs=fakeGcs({fail:failed==='gcs'});
    await assert.rejects(runScheduledBackup({config:{...f.config,gcs:gcsConfig},runCoordinator:async()=>({localSnapshot:f.snapshot,offVmDeliveryVerified:false}),
      request:dualRequest(azure,gcs),getToken:token,readMonitor:monitor}),error=>{
      assert.equal(error.perDest?.[failed].status,'failure');
      assert.equal(error.perDest?.[failed==='azure'?'gcs':'azure'].status,'success');
      assert.equal(error.statusEvent.status,'success');assert.doesNotMatch(JSON.stringify(error)+String(error),/secret|synthetic/);return true;
    });
    const event=JSON.parse([...gcs.objects].find(([name])=>name.startsWith('monitor/events/'))[1]);
    assert.equal(event.result,'failure'); assert.equal(event.perDest[failed].status,'failure');
  }
});

test('allSettled waits for an outstanding destination before publishing failure',async t=>{
  const f=await fixture(t),gcs=fakeGcs();let release,finished=false;
  const blocked=new Promise(resolve=>{release=resolve;});
  const azure=fakeStore();
  const pending=runScheduledBackup({config:{...f.config,gcs:gcsConfig},runCoordinator:async()=>({localSnapshot:f.snapshot,offVmDeliveryVerified:false}),
    getToken:token,readMonitor:monitor,request:async(url,o)=>{
      if(new URL(url).hostname.endsWith('.blob.core.windows.net')){await blocked;return azure.request(url,o);}
      if(new URL(url).searchParams.get('name')?.startsWith('hsr-state/'))return {status:403,body:Buffer.alloc(0)};
      return gcs.request(url,o);
    }}).catch(error=>{finished=true;return error;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(finished,false);
  assert.equal([...gcs.objects].some(([name])=>name.startsWith('monitor/events/')),false);
  release();const error=await pending;assert.equal(error.perDest?.azure.status,'success');assert.equal(error.perDest?.gcs.status,'failure');
});

test('coordinator failure attempts only immutable failure telemetry after WIF and sends no state pair',async t=>{
  const f=await fixture(t),azure=fakeStore(),gcs=fakeGcs();
  await assert.rejects(runScheduledBackup({config:{...f.config,gcs:gcsConfig},runCoordinator:async()=>{throw new Error('secret coordinator stderr');},
    request:dualRequest(azure,gcs),getToken:token,readMonitor:async()=>({admission:false,journal:{phase:'snapshotting',originalAdmission:true}})}),error=>{
    assert.equal(error.perDest?.azure.status,'skipped');assert.equal(error.perDest?.gcs.status,'skipped');assert.doesNotMatch(String(error),/secret/);return true;
  });
  assert.equal(azure.requests.length,0);assert.equal(gcs.objects.size,1);
  const event=JSON.parse([...gcs.objects.values()][0]);assert.equal(event.result,'failure');assert.equal(event.stage,'coordinator');
  assert.equal(event.snapshot.admission,false);assert.equal(event.snapshot.journal.phase,'snapshotting');
});

test('Azure-only remains unchanged with missing or explicitly disabled GCS config',async t=>{
  const f=await fixture(t);
  for(const gcs of [undefined,{enabled:false}]){
    const azure=fakeStore();
    const result=await runScheduledBackup({config:{...f.config,gcs},runCoordinator:async()=>({localSnapshot:f.snapshot,offVmDeliveryVerified:false}),request:azure.request,getToken:token,
      readMonitor:()=>{throw new Error('must not read telemetry');}});
    assert.equal(result.transportVerified,true);assert.equal(azure.requests.length,4);
  }
});

test('invalid enabled GCS configuration is rejected before any coordinator mutation',async t=>{
  const f=await fixture(t);let calls=0;
  for(const gcs of [{...gcsConfig,bucket:'foreign'},{enabled:'true'},{...gcsConfig,keyFile:'secret.json'}]){
    await assert.rejects(runScheduledBackup({config:{...f.config,gcs},runCoordinator:async()=>{calls++;}}),/config|destination/i);
  }
  assert.equal(calls,0);
});

test('monitor upload failure fails the run while preserving both verified destination results',async t=>{
  const f=await fixture(t),azure=fakeStore(),gcs=fakeGcs();
  await assert.rejects(runScheduledBackup({config:{...f.config,gcs:gcsConfig},runCoordinator:async()=>({localSnapshot:f.snapshot,offVmDeliveryVerified:false}),getToken:token,readMonitor:monitor,
    request:(url,o)=>new URL(url).searchParams.get('name')?.startsWith('monitor/events/')?Promise.resolve({status:403,body:Buffer.from('secret')}):dualRequest(azure,gcs)(url,o)}),error=>{
    assert.equal(error.perDest?.azure.status,'success');assert.equal(error.perDest?.gcs.status,'success');assert.equal(error.statusEvent.status,'failure');return true;
  });
});

test('resend API validates only the explicitly named pair without invoking a coordinator or asserting recovery',async t=>{
  assert.equal(typeof backupApi.resendBackupPair,'function');
  const f=await fixture(t),azure=fakeStore(),gcs=fakeGcs();
  await writeFile(join(f.config.backupDirectory,'orphan.enc.json'),'private-secret');
  const result=await backupApi.resendBackupPair({config:{...f.config,gcs:gcsConfig},file:f.snapshot.file,receiptFile:f.snapshot.receiptFile,
    request:dualRequest(azure,gcs),getToken:token,readMonitor:async()=>({})});
  assert.equal(result.perDest.azure.status,'success');assert.equal(result.perDest.gcs.status,'success');
  assert.equal(result.mode,'resend');assert.equal(azure.objects.size,2);
  const event=JSON.parse([...gcs.objects].find(([name])=>name.startsWith('monitor/events/'))[1]);
  assert.equal(event.mode,'resend');assert.equal(event.snapshot.workerHealth,'unknown');
  assert.ok([...gcs.objects].every(([name,bytes])=>!name.includes('orphan')&&!bytes.includes('private-secret')));
  assert.equal(await readFile(join(f.config.backupDirectory,'orphan.enc.json'),'utf8'),'private-secret');
});

test('resend refuses arbitrary directories and mismatched names before requesting credentials',async t=>{
  assert.equal(typeof backupApi.resendBackupPair,'function');
  const f=await fixture(t);let requests=0;
  await assert.rejects(backupApi.resendBackupPair({config:f.config,file:join(f.root,'private-key.pem'),receiptFile:f.snapshot.receiptFile,
    request:()=>{requests++;},getToken:()=>{requests++;}}),/path|source/i);
  assert.equal(requests,0);
});

test('interruption before Azure delivery never requests credentials',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects(deliverBackup({config:f.config,snapshot:f.snapshot,shouldAbort:()=>true,getToken:()=>{calls++;return 'token';}}),/interrupt/i);
  assert.equal(calls,0);
});

test('WIF failure still finishes Azure and reports both destinations without any GCS status object',async t=>{
  const f=await fixture(t),azure=fakeStore(),gcs=fakeGcs();
  await assert.rejects(runScheduledBackup({config:{...f.config,gcs:gcsConfig},runCoordinator:async()=>({localSnapshot:f.snapshot,offVmDeliveryVerified:false}),getToken:token,readMonitor:monitor,
    request:(url,o)=>url.includes('sts.googleapis.com')?Promise.resolve({status:403,body:Buffer.from('secret')}):dualRequest(azure,gcs)(url,o)}),error=>{
      assert.equal(error.perDest.azure.status,'success');assert.equal(error.perDest.gcs.status,'failure');
      assert.equal(error.statusEvent.status,'failure');return true;
    });
  assert.equal(azure.objects.size,2);assert.equal(gcs.objects.size,0);
});

test('old completed journals cannot claim current admission after coordinator failure or resend',async t=>{
  const f=await fixture(t),directory=join(f.root,'control');await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'journal.json'),JSON.stringify({version:1,service:'hsr-transfer-worker.service',phase:'complete',originalAdmission:true,secret:'credential'}),{mode:0o600});
  const unconfirmed=await backupApi.readMonitorSnapshot({directory,service:'hsr-transfer-worker.service'});
  assert.equal(unconfirmed.admission,'unknown');
  const confirmed=await backupApi.readMonitorSnapshot({directory,service:'hsr-transfer-worker.service',recovered:true});
  assert.equal(confirmed.admission,true);assert.equal(confirmed.journal.phase,'complete');
  assert.doesNotMatch(JSON.stringify(confirmed),/secret|credential/);
  assert.deepEqual(await backupApi.readMonitorSnapshot({directory,service:'other.service',recovered:true}),{});
});

test('CLI selects resend only for a complete explicit pair and rejects ambiguous arguments',()=>{
  assert.equal(typeof backupApi.parseBackupArguments,'function');
  const config='/etc/hsr-backup/backup.json';
  assert.deepEqual(backupApi.parseBackupArguments([config]),{configPath:config,mode:'scheduled'});
  assert.deepEqual(backupApi.parseBackupArguments([config,'--resend-pair','cipher','receipt']),{configPath:config,mode:'resend',file:'cipher',receiptFile:'receipt'});
  for(const args of [[],['other.json'],[config,''],[config,'','cipher','receipt'],[config,'--resend-pair'],[config,'--resend-pair','cipher'],
    [config,'--resend-pair','','receipt'],[config,'--resend-pair','cipher','receipt','extra']])assert.throws(()=>backupApi.parseBackupArguments(args));
});
