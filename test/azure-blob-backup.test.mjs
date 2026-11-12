import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { createStateBackup } from '../scripts/infrastructure/worker-state-backup.mjs';
import { deliverBackup, runScheduledBackup } from '../scripts/infrastructure/azure-blob-backup.mjs';

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
  const spool = join(root, 'spool'); await mkdir(spool);
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
  await assert.rejects(deliverBackup({config:f.config,snapshot:f.snapshot,request:s.request,getToken:token}),/upload/i);
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
