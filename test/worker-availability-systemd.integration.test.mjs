// Opt in ONLY on an isolated Ubuntu host, never the production VM.
import assert from 'node:assert/strict';
import{execFile}from'node:child_process';import{promisify}from'node:util';
import{mkdtemp,readFile,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';
import{setTimeout as delay}from'node:timers/promises';import test from'node:test';
const run=promisify(execFile);
test('real systemd DynamicUser probe detects worker outage independently and recovers',{skip:process.env.HSR_AVAILABILITY_SYSTEMD_TEST!=='1',timeout:90000},async t=>{
 assert.equal(process.platform,'linux');
 const unit='hsr-worker-availability.service',worker='hsr-worker-production.service';
 const control=async(...args)=>(await run('sudo',['-n','systemctl',...args],{timeout:15000})).stdout.trim();
 for(const name of [unit,worker])assert.equal(await control('show',name,'-p','LoadState','--value'),'not-found','refuse existing production-named unit');
 const dir=await mkdtemp(join(tmpdir(),'hsr-availability-systemd-'));
 const destination='/opt/'+dir.split('/').at(-1);
 await run('sudo',['-n','install','-d','-m','0755',destination]);
 const installed=[];
 t.after(async()=>{
  for(const name of installed.reverse())await control('stop',name).catch(()=>{});
  for(const name of installed)await run('sudo',['-n','rm','--','/run/systemd/system/'+name]);
  await control('daemon-reload');
  await run('sudo',['-n','rm','-r','--',destination]);
  await rm(dir,{recursive:true,force:true});
 });
 async function install(name,content,mode='0644',target=destination+'/'+name){const source=join(dir,name);await writeFile(source,content);await run('sudo',['-n','install','-m',mode,source,target]);}
 for(const name of ['server.mjs','probe.mjs','credentials.mjs'])await install(name,await readFile(resolve('scripts/infrastructure/worker-availability/'+name)));
 const username='isolated-uptime',password='synthetic-read-only-availability-00000000';
 await install('username',username,'0600');await install('password',password,'0600');
 await install('mode','ok');
 await install('worker.mjs',`import{createServer}from'node:http';import{readFile}from'node:fs/promises';const server=createServer(async(_q,r)=>{const mode=(await readFile('${destination}/mode','utf8')).trim();r.setHeader('content-type','application/json');r.end(JSON.stringify({status:mode}));});server.listen(8787,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
 await install('worker.service',`[Unit]\nDescription=Isolated synthetic HSR availability test worker\n[Service]\nExecStart=${process.execPath} ${destination}/worker.mjs\nRestart=no\nTimeoutStopSec=5s\n`, '0644','/run/systemd/system/'+worker);installed.push(worker);
 const candidate=(await readFile(resolve('scripts/infrastructure/worker-availability/hsr-worker-availability.service'),'utf8'))
  .replace('WorkingDirectory=/opt/hsr-worker-availability','WorkingDirectory='+destination)
  .replace(/ExecStart=.*\n/,'ExecStart='+process.execPath+' '+destination+'/server.mjs\n')
  .replace('/etc/hsr-worker-availability/probe-username',destination+'/username')
  .replace('/etc/hsr-worker-availability/probe-password',destination+'/password');
 await install('probe.service',candidate,'0644','/run/systemd/system/'+unit);installed.push(unit);
 await control('daemon-reload');await run('sudo',['-n','systemd-analyze','verify','/run/systemd/system/'+worker,'/run/systemd/system/'+unit]);
 await control('start',worker);await control('start',unit);
 const auth='Basic '+Buffer.from(username+':'+password).toString('base64');
 async function sample(header=auth){try{const r=await fetch('http://127.0.0.1:8790/_hsr/availability',{headers:{authorization:header},signal:AbortSignal.timeout(3000)});return{status:r.status,body:await r.text()};}catch{return{status:0};}}
 async function until(status){for(let i=0;i<70;i++){const value=await sample();if(value.status===status)return value;await delay(200);}const log=(await run('sudo',['-n','journalctl','-u',unit,'-n','20','--no-pager'])).stdout;throw Error('Expected '+status+' '+log);}
 assert.deepEqual(await until(200),{status:200,body:'{"status":"ok"}'});
 assert.equal(await control('show',unit,'-p','DynamicUser','--value'),'yes');
 const pid=await control('show',unit,'-p','MainPID','--value');assert.notEqual(pid,'0');
 assert.equal((await sample('Basic invalid')).status,503);
 await install('mode','unexpected');assert.equal((await until(503)).body,'{"status":"unavailable"}');
 await install('mode','ok');await until(200);
 const backupMetric=0;await control('stop',worker);await until(503);
 assert.equal(backupMetric,0);assert.equal(await control('show',unit,'-p','MainPID','--value'),pid,'monitor survives worker outage');
 await control('start',worker);await until(200);
 await control('stop',worker);await control('start',worker);await until(503);
 assert.equal(await control('show',worker,'-p','ActiveState','--value'),'active','repeated starts remain unhealthy despite responding process');
 t.diagnostic('Real DynamicUser/LoadCredential, system D-Bus, proc/cgroup ownership and monotonic clock passed. Only synthetic fixed service names were used; no publishing code or cloud alerts executed.');
});
