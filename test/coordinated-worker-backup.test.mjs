import assert from "node:assert/strict";
import test from "node:test";
import { coordinatedBackup } from "../scripts/infrastructure/coordinated-worker-backup.mjs";

function fixture({ running = 0, queued = 0, initiallyEnabled = true, snapshotError = false } = {}) {
  const calls = [];
  const ops = {
    acquire: async () => calls.push("lock"), release: async () => calls.push("unlock"),
    dashboard: async () => { calls.push("dashboard"); return { settings: { publicSubmissionsEnabled: initiallyEnabled }, stats: { running, queued } }; },
    setSubmissions: async enabled => calls.push(`submissions:${enabled}`),
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
  assert.deepEqual(f.calls,["lock","dashboard","submissions:false","dashboard","stop","stopped","snapshot","stopped","start","health","submissions:true","unlock"]);
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
