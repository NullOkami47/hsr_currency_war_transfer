import assert from "node:assert/strict";
import test from "node:test";
import { coordinatedBackup } from "../scripts/infrastructure/coordinated-worker-backup.mjs";

function fixture({ running = 0, queued = 0, initiallyEnabled = true, snapshotError = false } = {}) {
  const calls = []; let enabled = initiallyEnabled;
  const ops = {
    acquire: async () => calls.push("lock"), release: async () => calls.push("unlock"),
    checkJournal: async () => {}, beginJournal: async () => {}, phaseJournal: async () => {}, completeJournal: async () => {},
    dashboard: async () => { calls.push("dashboard"); return { settings: { publicSubmissionsEnabled: enabled }, stats: { running, queued } }; },
    setSubmissions: async value => { enabled=value; calls.push(`submissions:${value}`); },
    stop: async () => calls.push("stop"), assertStopped: async () => calls.push("stopped"),
    snapshot: async () => { calls.push("snapshot"); if(snapshotError) throw new Error("disk failure"); return { sha256: "synthetic-hash" }; },
    start: async () => calls.push("start"), health: async () => calls.push("health"),
    sleep: async () => calls.push("wait"),
  };
  return { calls, ops };
}

test("daily coordinated backup closes admission, drains, stops, snapshots, recovers service then admission", async () => {
  const f=fixture();
  const result=await coordinatedBackup({ operations:f.ops, authorised:true, maxPolls:2 });
  assert.equal(result.sha256,"synthetic-hash");
  assert.deepEqual(f.calls,["lock","dashboard","submissions:false","dashboard","dashboard","stop","stopped","snapshot","stopped","start","health","dashboard","submissions:true","dashboard","unlock"]);
});
test("missing authority and busy queue never stop the production worker", async () => {
  const a=fixture();
  await assert.rejects(coordinatedBackup({operations:a.ops}),/authorisation/);
  assert.deepEqual(a.calls,[]);
  const b=fixture({running:1,queued:1});
  await assert.rejects(coordinatedBackup({operations:b.ops,authorised:true,maxPolls:2}),/drain/);
  assert.ok(!b.calls.includes("stop"));
  assert.ok(b.calls.includes("submissions:true"));
  assert.equal(b.calls.at(-1),"unlock");
});
test("failed snapshot restores the original production service without pretending backup succeeded", async () => {
  const f=fixture({snapshotError:true});
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true}),/disk failure/);
  assert.ok(f.calls.includes("start"));
  assert.ok(f.calls.includes("health"));
  assert.equal(f.calls.at(-1),"unlock");
});
test("already disabled submissions remain disabled and missing queue evidence fails closed", async () => {
  const f=fixture({initiallyEnabled:false});
  await coordinatedBackup({operations:f.ops,authorised:true});
  assert.ok(!f.calls.includes("submissions:true"));
  const bad=fixture(); bad.ops.dashboard=async()=>({settings:{publicSubmissionsEnabled:true}});
  await assert.rejects(coordinatedBackup({operations:bad.ops,authorised:true}),/dashboard/);
  assert.ok(!bad.calls.includes("stop"));
});
test("failed stop requires manual reconciliation and unhealthy service never reopens submissions", async () => {
  const f=fixture(); f.ops.stop=async()=>{f.calls.push("stop");throw new Error("stop failed");};
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true}),/unverified|manual recovery/);
  assert.ok(!f.calls.includes("start"));
  const g=fixture(); g.ops.health=async()=>{throw new Error("unhealthy");};
  await assert.rejects(coordinatedBackup({operations:g.ops,authorised:true}),/unhealthy/);
  assert.ok(!g.calls.includes("submissions:true"));
});


test("uncertain stop or another state writer must keep publishing and admission paused for manual recovery", async () => {
  const f=fixture();
  f.ops.assertStopped=async()=>{f.calls.push("stopped-uncertain");throw new Error("another state writer");};
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true}),/unverified|manual recovery/);
  assert.ok(!f.calls.includes("start"),"must not restart publisher when exclusive ownership is unproven");
  assert.ok(!f.calls.includes("submissions:true"));
  const g=fixture();g.ops.stop=async()=>{g.calls.push("stop");throw new Error("unknown stop outcome");};
  await assert.rejects(coordinatedBackup({operations:g.ops,authorised:true}),/unverified|manual recovery/);
  assert.ok(!g.calls.includes("start"));
  assert.ok(!g.calls.includes("submissions:true"));
});

test('every drain poll and final pre-stop check reject reopened admission', async () => {
  for (const reopenAt of [1,2]) {
    const f=fixture(); let count=0, enabled=true;
    f.ops.checkJournal=async()=>{}; f.ops.beginJournal=async()=>{}; f.ops.phaseJournal=async()=>{}; f.ops.completeJournal=async()=>{};
    f.ops.setSubmissions=async value=>{enabled=value;f.calls.push(`submissions:${value}`);};
    f.ops.dashboard=async()=>{f.calls.push('dashboard');count++;return {settings:{publicSubmissionsEnabled:count>1 && count-1===reopenAt ? true : enabled},stats:{running:0,queued:0}};};
    await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true}),/admission|submission/i);
    assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('submissions:true'));
  }
});

test('journal is durably begun with original policy before admission changes and unfinished journal refuses all mutations', async () => {
  const f=fixture(); let original;
  f.ops.checkJournal=async()=>{f.calls.push('checkJournal');};
  f.ops.beginJournal=async value=>{original=value;f.calls.push('beginJournal');};
  f.ops.phaseJournal=async phase=>f.calls.push(`phase:${phase}`);
  f.ops.completeJournal=async()=>f.calls.push('completeJournal');
  let enabled=true; f.ops.setSubmissions=async value=>{enabled=value;f.calls.push(`submissions:${value}`);};
  f.ops.dashboard=async()=>({settings:{publicSubmissionsEnabled:enabled},stats:{running:0,queued:0}});
  await coordinatedBackup({operations:f.ops,authorised:true});
  assert.equal(original,true); assert.ok(f.calls.indexOf('beginJournal')<f.calls.indexOf('submissions:false'));
  assert.ok(f.calls.indexOf('completeJournal')>f.calls.indexOf('submissions:true'));
  const g=fixture(); g.ops.checkJournal=async()=>{throw new Error('unfinished journal');};
  await assert.rejects(coordinatedBackup({operations:g.ops,authorised:true}),/unfinished/);
  assert.ok(!g.calls.some(x=>x.startsWith('submissions:')||x==='stop'));
});

test('a termination request during snapshot recovers the service and reports interruption', async () => {
  const f=fixture();let interrupted=false;
  f.ops.snapshot=async()=>{f.calls.push('snapshot');interrupted=true;return {};};
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true,shouldAbort:()=>interrupted}),/interrupt/i);
  assert.ok(f.calls.includes('start')); assert.ok(f.calls.includes('submissions:true'));
});

test('journal write failure prevents the first admission mutation', async () => {
  const f=fixture();f.ops.beginJournal=async()=>{throw new Error('journal fsync failed');};
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true}),/fsync/);
  assert.ok(!f.calls.some(x=>x.startsWith('submissions:')||x==='stop'));
});

test('a job appearing at final pre-stop check prevents stopping', async () => {
  const f=fixture();let enabled=true,checks=0;
  f.ops.setSubmissions=async value=>{enabled=value;f.calls.push(`submissions:${value}`);};
  f.ops.dashboard=async()=>{checks++;return {settings:{publicSubmissionsEnabled:enabled},stats:{queued:checks===3?1:0,running:0}};};
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true}),/queue changed/i);
  assert.ok(!f.calls.includes('stop'));
});

test('admission changed while worker was stopped is not overwritten during recovery', async () => {
  const f=fixture();let enabled=true;
  f.ops.setSubmissions=async value=>{enabled=value;f.calls.push(`submissions:${value}`);};
  f.ops.dashboard=async()=>({settings:{publicSubmissionsEnabled:enabled},stats:{queued:0,running:0}});
  f.ops.start=async()=>{enabled=true;f.calls.push('start');};
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true}),/admission|manual/i);
  assert.ok(!f.calls.includes('submissions:true'));
});

test('without a stop, failed health prevents journal completion and leaves recovery for review', async () => {
  const f=fixture({running:1});let completed=false;
  f.ops.health=async()=>{throw new Error('health unavailable');};f.ops.completeJournal=async()=>{completed=true;};
  await assert.rejects(coordinatedBackup({operations:f.ops,authorised:true,maxPolls:1}),/health unavailable/);
  assert.equal(completed,false);assert.ok(!f.calls.includes('stop'));
});
