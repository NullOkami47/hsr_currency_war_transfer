import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createJournal,createStatusStore} from '../scripts/infrastructure/backup-control-state.mjs';

async function root(t){const d=await mkdtemp(join(tmpdir(),'hsr-journal-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
test('journal preserves original admission and phase and refuses restart until explicitly completed',async t=>{
  const d=await root(t),j=createJournal({directory:d,service:'test.service'});
  await j.check(); await j.begin(true); await j.phase('stopping');
  const saved=JSON.parse(await readFile(join(d,'journal.json'),'utf8'));
  assert.equal(saved.originalAdmission,true); assert.equal(saved.phase,'stopping'); assert.equal(saved.service,'test.service');
  await assert.rejects(createJournal({directory:d,service:'test.service'}).check(),/unfinished/i);
  await j.phase('restoring_admission'); await j.complete(); await createJournal({directory:d,service:'test.service'}).check();
});
test('malformed journal fails closed and is retained',async t=>{
  const d=await root(t); await writeFile(join(d,'journal.json'),'{broken',{mode:0o600});
  await assert.rejects(createJournal({directory:d,service:'test.service'}).check());
  assert.equal(await readFile(join(d,'journal.json'),'utf8'),'{broken');
});
test('SIGKILL after journal write leaves durable unfinished record for next process',async t=>{
  const d=await root(t),moduleUrl=new URL('../scripts/infrastructure/backup-control-state.mjs',import.meta.url).href;
  const script=`import {createJournal} from ${JSON.stringify(moduleUrl)}; const j=createJournal({directory:process.argv[1],service:'test.service'}); await j.begin(true); await j.phase('draining'); console.log('READY'); setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,d],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('child exited '+code)));});
  const exited=new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGKILL'); await exited;
  const j=createJournal({directory:d,service:'test.service'}); await assert.rejects(j.check(),/unfinished/i);
  const saved=JSON.parse(await readFile(join(d,'journal.json'),'utf8'));assert.equal(saved.originalAdmission,true);assert.equal(saved.phase,'draining');
});
test('status records failure without erasing last transport success and marks running attempts staleable',async t=>{
  const d=await root(t),s=createStatusStore({directory:d});
  await s.start('2026-11-12T00:00:00.000Z'); await s.success('2026-11-12T00:01:00.000Z');
  await s.start('2026-11-13T00:00:00.000Z');
  let state=JSON.parse(await readFile(join(d,'status.json'),'utf8'));assert.equal(state.result,'running');assert.equal(state.lastSuccessAt,'2026-11-12T00:01:00.000Z');
  await s.failure('2026-11-13T00:02:00.000Z','delivery','confirmed');
  state=JSON.parse(await readFile(join(d,'status.json'),'utf8'));assert.equal(state.result,'failure');assert.equal(state.lastSuccessAt,'2026-11-12T00:01:00.000Z');assert.equal(state.workerHealth,'confirmed');assert.equal(state.restoreVerified,false);
});
test('insecure control directory is rejected on POSIX',{skip:process.platform==='win32'},async t=>{const d=await root(t);await chmod(d,0o755);await assert.rejects(createJournal({directory:d,service:'test.service'}).check(),/protected/i);});

test('monitored execution records delivery failure and preserves previous transport success',async t=>{
  const {runMonitoredBackup}=await import('../scripts/infrastructure/azure-blob-backup.mjs');
  const d=await root(t), s=createStatusStore({directory:d});
  const dates=['2026-11-12T00:00:00.000Z','2026-11-12T00:01:00.000Z','2026-11-13T00:00:00.000Z','2026-11-13T00:01:00.000Z'];
  const now=()=>dates.shift();
  await runMonitoredBackup({status:s,now,execute:async recovered=>{await recovered();return {transportVerified:true};}});
  await assert.rejects(runMonitoredBackup({status:s,now,execute:async recovered=>{await recovered();throw new Error('failed upload');}}));
  const state=JSON.parse(await readFile(join(d,'status.json'),'utf8'));
  assert.equal(state.lastSuccessAt,'2026-11-12T00:01:00.000Z');assert.equal(state.lastFailureAt,'2026-11-13T00:01:00.000Z');assert.equal(state.stage,'delivery');assert.equal(state.workerHealth,'confirmed');
});

test('status records coordinator recovery before delivery starts, including when process is killed during delivery',async t=>{
  const {runMonitoredBackup}=await import('../scripts/infrastructure/azure-blob-backup.mjs');
  const d=await root(t),s=createStatusStore({directory:d});
  await assert.rejects(runMonitoredBackup({status:s,execute:async recovered=>{
    await recovered();
    const state=JSON.parse(await readFile(join(d,'status.json'),'utf8'));
    assert.equal(state.result,'running');assert.equal(state.stage,'delivery');assert.equal(state.workerHealth,'confirmed');
    throw new Error('synthetic delivery failure');
  }}),/synthetic delivery failure/);
});

test('coordinator killed immediately after admission mutation leaves original policy in unfinished journal',async t=>{
  const d=await root(t), journalUrl=new URL('../scripts/infrastructure/backup-control-state.mjs',import.meta.url).href, coordinatorUrl=new URL('../scripts/infrastructure/coordinated-worker-backup.mjs',import.meta.url).href;
  const script=`import {createJournal} from ${JSON.stringify(journalUrl)}; import {coordinatedBackup} from ${JSON.stringify(coordinatorUrl)}; const j=createJournal({directory:process.argv[1],service:'test.service'}); const ops={acquire:async()=>{},release:async()=>{},checkJournal:j.check,beginJournal:j.begin,phaseJournal:j.phase,completeJournal:j.complete,dashboard:async()=>({settings:{publicSubmissionsEnabled:true},stats:{queued:0,running:0}}),setSubmissions:async()=>{console.log('MUTATED'); await new Promise(()=>{});}}; await coordinatedBackup({operations:ops,authorised:true});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,d],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('child exited '+code)));});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  const saved=JSON.parse(await readFile(join(d,'journal.json'),'utf8'));assert.equal(saved.originalAdmission,true);assert.equal(saved.phase,'closing_admission');
  await assert.rejects(createJournal({directory:d,service:'test.service'}).check(),/unfinished/i);
});
