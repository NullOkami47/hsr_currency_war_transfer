import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {buildAvailabilityCaddy} from '../scripts/infrastructure/worker-availability-caddy.mjs';

async function listen(handler){const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s;}
test('real Caddy preserves worker authentication and only forwards the exact probe route',{
 skip:!process.env.HSR_CADDY_TEST_BINARY,
 timeout:30000,
},async t=>{
 const root=await mkdtemp(join(tmpdir(),'hsr-caddy-isolated-'));
 const admin='synthetic-worker-admin-000000000000';
 const probe='Basic '+Buffer.from('uptime:synthetic-read-only-probe-00000000').toString('base64');
 const seen=[];let stallProbe=false;
 const worker=await listen((req,res)=>{seen.push(['worker',req.url]);res.end('{"status":"ok"}');});
 const sidecar=await listen((req,res)=>{seen.push(['probe',req.url]);if(stallProbe)return;res.statusCode=req.headers.authorization===probe?200:401;res.end(JSON.stringify({status:res.statusCode===200?'ok':'unavailable'}));});
 const reserve=await listen((_q,r)=>r.end());const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const baseline='worker.35-223-56-40.sslip.io {\n    @authorised header Authorization "Bearer {$HSR_GCP_WORKER_TOKEN}"\n    handle @authorised {\n        reverse_proxy 127.0.0.1:8787\n    }\n    handle {\n        respond "Unauthorised" 401\n    }\n    header -Server\n}\n';
 let candidate=buildAvailabilityCaddy(baseline,createHash('sha256').update(baseline).digest('hex'));
 candidate='{\n admin off\n auto_https off\n}\n'+candidate.replace('worker.35-223-56-40.sslip.io',`http://127.0.0.1:${port}`).replace('127.0.0.1:8787',`127.0.0.1:${worker.address().port}`).replace('127.0.0.1:8790',`127.0.0.1:${sidecar.address().port}`);
 const path=join(root,'Caddyfile');await writeFile(path,candidate);
 const child=spawn(process.env.HSR_CADDY_TEST_BINARY,['run','--config',path,'--adapter','caddyfile'],{env:{...process.env,HSR_GCP_WORKER_TOKEN:admin},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',b=>{logs+=b;});child.stdout.on('data',b=>{logs+=b;});
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);}await Promise.all([new Promise(r=>worker.close(r)),new Promise(r=>sidecar.close(r))]);await rm(root,{recursive:true,force:true});});
 const request=(path,auth)=>fetch(`http://127.0.0.1:${port}${path}`,{headers:auth?{authorization:auth}:{},signal:AbortSignal.timeout(1500),redirect:'error'});
 let ready=false;for(let i=0;i<100;i++){try{await request('/');ready=true;break;}catch{if(child.exitCode!==null)throw Error(logs);await delay(50);}}
 assert.ok(ready,logs);
 assert.equal((await request('/health')).status,401);
 assert.equal((await request('/health','Bearer '+admin)).status,200);
 assert.equal((await request('/health',probe)).status,401);
 assert.equal((await request('/_hsr/availability',probe)).status,200);
 assert.equal((await request('/_hsr/availability','Bearer '+admin)).status,401);
 assert.equal((await request('/_hsr/availability/extra',probe)).status,401);
 assert.equal((await request('/_hsr/availability-evil',probe)).status,401);
 assert.deepEqual(seen,[['worker','/health'],['probe','/_hsr/availability'],['probe','/_hsr/availability']]);
 stallProbe=true;
 const failed=await fetch(`http://127.0.0.1:${port}/_hsr/availability`,{headers:{authorization:probe},signal:AbortSignal.timeout(8000)});
 assert.equal(failed.status,504,'a stalled sidecar must terminate at the Caddy response-header deadline');
});
