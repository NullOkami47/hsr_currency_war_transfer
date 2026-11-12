import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createStateBackup } from '../scripts/infrastructure/worker-state-backup.mjs';
import { boundedRequest } from '../scripts/infrastructure/azure-blob-backup.mjs';

const gcs = await import('../scripts/infrastructure/gcs-backup.mjs');
const bucket = 'hsr-worker-backups-282550645630';
const audience = '//iam.googleapis.com/projects/282550645630/locations/global/workloadIdentityPools/hsr-azure-backup/providers/azure-vm';
const key = generateKeyPairSync('rsa', { modulusLength:3072 }).publicKey.export({type:'spki',format:'pem'});
const tokenReply = () => ({status:200,body:Buffer.from(JSON.stringify({access_token:'synthetic-gcp-token',token_type:'Bearer',issued_token_type:'urn:ietf:params:oauth:token-type:access_token',expires_in:3600}))});
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'hsr-gcs-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const paths={transfers:join(root,'transfers'),jobs:join(root,'jobs')}; paths.security=paths.jobs+'.security.json';
  await writeFile(paths.transfers,JSON.stringify({version:1,transfers:{}}));
  await writeFile(paths.jobs,JSON.stringify({version:4,settings:{},jobs:{},quota:{events:[],blockedUntil:0}}));
  await writeFile(paths.security,JSON.stringify({version:1,requests:{},sessions:{}}));
  const backup=await createStateBackup({paths,publicKey:key,assertQuiescent:async()=>{},now:()=>new Date('2026-11-12T01:00:00.000Z')});
  const spool=join(root,'spool'); await mkdir(spool,{mode:0o700});
  const stem=join(spool,'hsr-state-2026-11-12T01-00-00-000Z');
  await writeFile(stem+'.enc.json',backup.encrypted,{mode:0o600});
  await writeFile(stem+'.receipt.json',JSON.stringify(backup.receipt)+'\n',{mode:0o600});
  return {root,config:{backupDirectory:spool,gcs:{enabled:true,bucket,audience}},snapshot:{...backup.receipt,file:stem+'.enc.json',receiptFile:stem+'.receipt.json'}};
}
function store({intercept}={}) {
  const objects=new Map(),requests=[];
  const request=async (url,options={})=>{
    requests.push({url,...options});
    const override=await intercept?.(url,options,requests.length);
    if (override) return override;
    const u=new URL(url);
    if (u.hostname==='169.254.169.254') return {status:200,body:Buffer.from('{"access_token":"synthetic-azure-token"}')};
    if (u.hostname==='sts.googleapis.com') return tokenReply();
    assert.equal(u.hostname,'storage.googleapis.com');
    assert.equal(options.headers.authorization,'Bearer synthetic-gcp-token');
    if (options.method==='POST') {
      assert.equal(u.pathname,`/upload/storage/v1/b/${bucket}/o`);
      assert.equal(u.searchParams.get('uploadType'),'media');
      assert.equal(u.searchParams.get('ifGenerationMatch'),'0');
      const name=u.searchParams.get('name');
      if (objects.has(name)) return {status:412,body:Buffer.alloc(0)};
      objects.set(name,Buffer.from(options.body)); return {status:200,body:Buffer.from('{}')};
    }
    assert.equal(options.method,'GET'); assert.equal(u.searchParams.get('alt'),'media');
    const name=decodeURIComponent(u.pathname.slice(`/storage/v1/b/${bucket}/o/`.length));
    return {status:objects.has(name)?200:404,body:objects.get(name)??Buffer.alloc(0)};
  };
  return {objects,requests,request};
}

test('GCS exchanges only Azure storage MI through pinned WIF then uploads the validated pair and hashes readback',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t),s=store();
  const client=gcs.createGcsBackupClient({config:f.config,request:s.request});
  const result=await client.deliver(f.snapshot);
  assert.equal(result.transportVerified,true); assert.equal(result.restoreVerified,false);
  const mi=s.requests[0],sts=s.requests[1],form=new URLSearchParams(sts.body.toString());
  assert.equal(new URL(mi.url).searchParams.get('resource'),'https://storage.azure.com/');
  assert.equal(mi.headers.Metadata,'true');
  assert.equal(sts.url,'https://sts.googleapis.com/v1/token'); assert.equal(sts.method,'POST');
  assert.equal(sts.headers.authorization,undefined);
  assert.equal(form.get('audience'),audience); assert.equal(form.get('subject_token'),'synthetic-azure-token');
  assert.equal(form.get('subject_token_type'),'urn:ietf:params:oauth:token-type:jwt');
  assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(form.get('requested_token_type'),'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(form.get('scope'),'https://www.googleapis.com/auth/devstorage.read_write');
  assert.equal(s.objects.size,2);
  assert.deepEqual(s.objects.get('hsr-state/'+f.snapshot.file.split(/[\\/]/).at(-1)),await readFile(f.snapshot.file));
  assert.ok(s.requests.every(r=>r.timeoutMs>0 && r.timeoutMs<=60000));
  assert.doesNotMatch(JSON.stringify(result),/synthetic|access_token|private/i);
});

test('identical existing pairs and a partially uploaded pair are idempotent without replacement',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t),s=store(),client=gcs.createGcsBackupClient({config:f.config,request:s.request});
  await client.deliver(f.snapshot);
  const before=[...s.objects].map(([name,bytes])=>[name,hash(bytes)]);
  assert.equal((await client.deliver(f.snapshot)).transportVerified,true);
  assert.deepEqual([...s.objects].map(([name,bytes])=>[name,hash(bytes)]),before);
  s.objects.delete(before[1][0]);
  assert.equal((await client.deliver(f.snapshot)).transportVerified,true);
  assert.equal(s.objects.size,2);
});

test('an existing ciphertext collision fails before receipt creation and never overwrites or deletes',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t),s=store();
  const name='hsr-state/'+f.snapshot.file.split(/[\\/]/).at(-1);
  s.objects.set(name,Buffer.from('foreign object'));
  await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot),/checksum|collision/i);
  assert.equal(s.objects.size,1); assert.equal(s.objects.get(name).toString(),'foreign object');
  assert.ok(s.requests.every(r=>!['PUT','DELETE','PATCH'].includes(r.method)));
});

test('both ciphertext and receipt readbacks must match even after fresh successful uploads',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t);
  for (const suffix of ['.enc.json','.receipt.json']) {
    const s=store({intercept:(url,o)=>{
      const name=decodeURIComponent(new URL(url).pathname.split('/o/')[1]??'');
      return o.method==='GET'&&name.endsWith(suffix)&&s.objects.has(name)?{status:200,body:Buffer.from('corrupted')}:undefined;
    }});
    await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot),/checksum/i);
    assert.equal(s.objects.size,suffix==='.enc.json'?1:2);
  }
});

test('disabled or altered destinations and credential configuration fail before network',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t),s=store();
  for (const value of [undefined,{enabled:false},{...f.config.gcs,enabled:'true'},{...f.config.gcs,bucket:'foreign'},
    {...f.config.gcs,audience:audience+'/foreign'},{...f.config.gcs,keyFile:'/secret.json'}]) {
    await assert.rejects(async()=>gcs.createGcsBackupClient({config:{...f.config,gcs:value},request:s.request}).deliver(f.snapshot),/config|enabled|destination/i);
  }
  assert.equal(s.requests.length,0);
});

test('paths, symlinks, plaintext, forged envelope and receipt mismatch are rejected before identity access',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t),s=store(),client=gcs.createGcsBackupClient({config:f.config,request:s.request});
  await assert.rejects(client.deliver({...f.snapshot,file:join(f.root,'private.pem')}));
  const cipher=await readFile(f.snapshot.file),receipt=await readFile(f.snapshot.receiptFile);
  await writeFile(f.snapshot.file,'{"privateKey":"plaintext"}'); await assert.rejects(client.deliver(f.snapshot));
  await writeFile(f.snapshot.file,cipher); await writeFile(f.snapshot.receiptFile,JSON.stringify({...JSON.parse(receipt),secret:'not allowed'}));
  await assert.rejects(client.deliver(f.snapshot));
  const forged=Buffer.from(JSON.stringify({format:f.snapshot.format,encryptedKey:'private key',iv:'',tag:'',ciphertext:''}));
  const forgedReceipt={...JSON.parse(receipt),bytes:forged.length,sha256:hash(forged)};
  await writeFile(f.snapshot.file,forged); await writeFile(f.snapshot.receiptFile,JSON.stringify(forgedReceipt));
  await assert.rejects(client.deliver({...f.snapshot,...forgedReceipt}));
  assert.equal(s.requests.length,0);
});

test('WIF, IMDS and transport errors expose no response, body, token or caller error',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t);
  for (const host of ['169.254.169.254','sts.googleapis.com','storage.googleapis.com']) {
    const s=store({intercept:url=>new URL(url).hostname===host?{status:403,body:Buffer.from('super-secret-token')}:undefined});
    await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot),error=>{
      assert.doesNotMatch(String(error)+JSON.stringify(error),/synthetic|super-secret/); return true;
    });
    assert.equal(s.requests.filter(r=>new URL(r.url).hostname===host).length,1);
  }
});

test('transient responses and an ambiguously committed upload retry within a fixed bound',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t); let attempts=0;
  const s=store({intercept:(url,o)=>{
    if (new URL(url).hostname==='sts.googleapis.com' && ++attempts<3) return {status:503,body:Buffer.from('secret')};
    if (o.method==='POST' && new URL(url).hostname==='storage.googleapis.com' && !s.objects.size) {
      s.objects.set(new URL(url).searchParams.get('name'),Buffer.from(o.body)); throw new Error('secret connection lost after commit');
    }
  }});
  assert.equal((await gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot)).transportVerified,true);
  assert.equal(attempts,3);
  const failed=store({intercept:()=>({status:503,body:Buffer.from('secret')})});
  await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:failed.request}).deliver(f.snapshot));
  assert.equal(failed.requests.length,3);
});

test('deadline and cancellation bound work even if an injected transport never settles',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t); let calls=0;
  const started=Date.now();
  await assert.rejects(gcs.createGcsBackupClient({config:f.config,timeoutMs:40,request:()=>{calls++;return new Promise(()=>{});}}).deliver(f.snapshot),/deadline|timeout/i);
  assert.ok(Date.now()-started<1500); assert.equal(calls,1);
  await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:()=>{calls++;},shouldAbort:()=>true}).deliver(f.snapshot),/interrupt/i);
  assert.equal(calls,1);
});

test('status events use unique immutable names, safe projected snapshots and readback without arbitrary fields',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t),s=store(),client=gcs.createGcsBackupClient({config:f.config,request:s.request});
  const state={result:'failure',stage:'delivery',perDest:{azure:{status:'failure',secret:'credential'},gcs:{status:'success'}},
    snapshot:{runStatus:'secret',workerHealth:'confirmed',admission:true,journal:{phase:'complete',originalAdmission:true,secret:'credential'},privateKey:'credential'},error:new Error('credential')};
  await client.recordStatus(state); await client.recordStatus(state);
  assert.equal(s.objects.size,2);
  for (const [name,bytes] of s.objects) {
    assert.match(name,/^monitor\/events\/\d{4}-.*[a-f0-9-]{36}\.json$/);
    const event=JSON.parse(bytes);
    assert.equal(event.result,'failure'); assert.equal(event.snapshot.runStatus,'failure');
    assert.equal(event.snapshot.admission,true); assert.equal(event.snapshot.journal.phase,'complete');
    assert.equal(event.perDest.azure.status,'failure'); assert.doesNotMatch(bytes.toString(),/secret|credential|privateKey|access_token/);
  }
  assert.equal(s.requests.filter(r=>new URL(r.url).hostname==='sts.googleapis.com').length,1);
});

test('failed WIF never sends status objects and cached rejection prevents extra authentication retries',async t=>{
  assert.equal(typeof gcs.createGcsBackupClient,'function');
  const f=await fixture(t),s=store({intercept:url=>url.includes('sts.googleapis.com')?{status:403,body:Buffer.from('secret')}:undefined});
  const client=gcs.createGcsBackupClient({config:f.config,request:s.request});
  await assert.rejects(client.deliver(f.snapshot)); await assert.rejects(client.recordStatus({result:'failure'}));
  assert.equal(s.objects.size,0); assert.equal(s.requests.length,2);
});

test('objectCreator and objectViewer can verify an identical pre-existing held pair without overwrite permission',async t=>{
  const f=await fixture(t),s=store({intercept:(url,o)=>new URL(url).hostname==='storage.googleapis.com'&&o.method==='POST'?{status:403,body:Buffer.from('overwrite requires delete')}:undefined});
  s.objects.set('hsr-state/'+f.snapshot.file.split(/[\\/]/).at(-1),await readFile(f.snapshot.file));
  s.objects.set('hsr-state/'+f.snapshot.receiptFile.split(/[\\/]/).at(-1),await readFile(f.snapshot.receiptFile));
  assert.equal((await gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot)).transportVerified,true);
  assert.equal(s.requests.filter(r=>new URL(r.url).hostname==='storage.googleapis.com'&&r.method==='POST').length,0);
});

test('malformed federation responses and redirects never forward credentials or reach storage',async t=>{
  const f=await fixture(t);
  for(const response of [{status:302,body:Buffer.from('secret')},{status:200,body:Buffer.from('secret-invalid-json')},
    {status:200,body:Buffer.from(JSON.stringify({access_token:'secret\nheader',token_type:'Bearer',issued_token_type:'urn:ietf:params:oauth:token-type:access_token',expires_in:3599}))},
    {status:200,body:Buffer.from(JSON.stringify({access_token:'secret',token_type:'Bearer',expires_in:0}))}]){
    const s=store({intercept:url=>new URL(url).hostname==='sts.googleapis.com'?response:undefined});
    await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot),error=>{
      assert.doesNotMatch(String(error)+JSON.stringify(error),/secret/);return true;
    });
    assert.equal(s.requests.length,2);assert.equal(s.objects.size,0);
  }
});

test('POSIX symlinks and unprotected ciphertext permissions never reach identity or storage',{skip:process.platform==='win32'},async t=>{
  const {symlink,unlink,chmod}=await import('node:fs/promises');
  const f=await fixture(t),s=store(),bytes=await readFile(f.snapshot.file);
  const other=join(f.root,'private.pem');await writeFile(other,bytes,{mode:0o600});
  await unlink(f.snapshot.file);await symlink(other,f.snapshot.file);
  await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot),/symlink/i);
  await unlink(f.snapshot.file);await writeFile(f.snapshot.file,bytes,{mode:0o600});await chmod(f.snapshot.file,0o644);
  await assert.rejects(gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot),/protected/i);
  assert.equal(s.requests.length,0);
});

test('native HTTP transport completes WIF, immutable uploads, idempotent readbacks and a status event using synthetic data',async t=>{
  const {createServer}=await import('node:http');
  const f=await fixture(t),s=store();
  const server=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await s.request('https://'+req.headers['x-test-host']+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(chunks)});
      res.writeHead(response.status);res.end(response.body);
    }catch{res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const client=gcs.createGcsBackupClient({config:{...f.config,gcs:{enabled:true}},request:(url,options)=>{
    const u=new URL(url);
    return boundedRequest(`http://127.0.0.1:${server.address().port}${u.pathname}${u.search}`,{...options,headers:{...options.headers,'x-test-host':u.hostname}});
  }});
  assert.equal((await client.deliver(f.snapshot)).transportVerified,true);
  assert.equal((await client.deliver(f.snapshot)).transportVerified,true);
  assert.equal((await client.recordStatus({result:'success',perDest:{azure:{status:'success'},gcs:{status:'success'}}})).status,'success');
  assert.equal(s.objects.size,3);
});

test('a bounded JSON 404 body larger than the receipt still permits create-only upload',async t=>{
  const f=await fixture(t);
  const s=store({intercept:(url,o)=>{
    const u=new URL(url),name=decodeURIComponent(u.pathname.split('/o/')[1]??'');
    if(u.hostname==='storage.googleapis.com'&&o.method==='GET'&&!s.objects.has(name))return {status:404,body:Buffer.from(JSON.stringify({error:{code:404,message:'No such object '+name,detail:'x'.repeat(8192)}}))};
  }});
  assert.equal((await gcs.createGcsBackupClient({config:f.config,request:s.request}).deliver(f.snapshot)).transportVerified,true);
  assert.equal(s.objects.size,2);
});
