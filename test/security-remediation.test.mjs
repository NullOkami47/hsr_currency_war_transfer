import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRolesHandler, createTransfersHandler } from "../src/http.mjs";
import { JsonWorkerJobStore } from "../src/worker.mjs";
import { createAdminSessionHandler, createAdminApiHandler } from "../src/admin-http.mjs";

const SOURCE = "6a56fe3021253d0e1a9f4761";
const TOKEN = "synthetic-admin-token-for-security-tests-only";
function response() {
  return { headers: {}, setHeader(k,v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = JSON.parse(body); } };
}
async function call(handler, request) {
  const res = response(); await handler({ headers: {}, ...request }, res); return res;
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "hsr-security-"));
  t.after(() => rm(dir, {recursive:true,force:true}));
  return join(dir,"jobs.json");
}

test("F1 rejects cache-busting role queries before any upstream call", async () => {
  let calls=0;
  const handler=createRolesHandler({fetchChinaRoleOptionsFn: async()=>{calls++; return {roles:[]};}});
  const res=await call(handler,{method:"GET",url:"/api/roles?nonce=1"});
  assert.equal(res.statusCode,400); assert.equal(calls,0);
});

test("F1 coalesces concurrent catalogue reads and caches the result", async () => {
  let calls=0;
  const handler=createRolesHandler({fetchChinaRoleOptionsFn: async()=>{calls++; await new Promise(r=>setTimeout(r,5)); return {roles:[]};}});
  const results=await Promise.all(Array.from({length:10},()=>call(handler,{method:"GET",url:"/api/roles"})));
  assert.ok(results.every(r=>r.statusCode===200));
  await call(handler,{method:"GET",url:"/api/roles"});
  assert.equal(calls,1);
});

test("F2 bootstrap never overwrites persisted administrative disablement", async t => {
  const path=await fixture(t);
  const store=new JsonWorkerJobStore(path);
  await store.initialise({publicSubmissionsEnabled:true});
  await store.updateSettings({publicSubmissionsEnabled:false});
  const restarted=new JsonWorkerJobStore(path);
  await restarted.initialise({publicSubmissionsEnabled:true});
  assert.equal((await restarted.dashboard()).settings.publicSubmissionsEnabled,false);
});

test("F3 terminal retention and restart cannot reset daily quota", async t => {
  const path=await fixture(t);
  let store=new JsonWorkerJobStore(path);
  await store.updateSettings({publicSubmissionsEnabled:true,maxStoredJobs:5,dailyAccountQuota:6,perIpLimit:20});
  for(let i=0;i<6;i++){
    const {job}=await store.createOrGetActive(i.toString(16).padStart(24,"0"),{public:true,clientKey:"client-one"});
    await store.update(job.id,{status:"completed"});
  }
  store=new JsonWorkerJobStore(path);
  assert.equal((await store.dashboard()).jobs.length,5);
  await assert.rejects(()=>store.createOrGetActive(SOURCE,{public:true,clientKey:"other"}),e=>e.code==="daily_quota_reached");
});

test("F3 retained-job pruning cannot reset a client submission window", async t => {
  const path=await fixture(t); const store=new JsonWorkerJobStore(path);
  await store.updateSettings({publicSubmissionsEnabled:true,maxStoredJobs:5,dailyAccountQuota:100,perIpLimit:6});
  for(let i=0;i<6;i++){
    const {job}=await store.createOrGetActive(i.toString(16).padStart(24,"0"),{public:true,clientKey:"same-client"});
    await store.update(job.id,{status:"failed"});
  }
  await assert.rejects(()=>new JsonWorkerJobStore(path).createOrGetActive(SOURCE,{public:true,clientKey:"same-client"}),e=>e.code==="rate_limited");
});

test("F4 duplicate active submissions do not rewrite job state", async t=>{
  const store=new JsonWorkerJobStore(await fixture(t));
  await store.createOrGetActive(SOURCE);
  let writes=0; const write=store.writeState.bind(store);
  store.writeState=async s=>{writes++;return write(s);};
  await Promise.all(Array.from({length:10},()=>store.createOrGetActive(SOURCE)));
  assert.equal(writes,0);
});

test("F4 rejects malformed polling identifiers before worker I/O", async()=>{
  let calls=0;
  const handler=createTransfersHandler({getTransferFn:async()=>{calls++;return {status:"queued",jobId:"x"};}});
  const res=await call(handler,{method:"GET",url:"/api/transfers?jobId=..%2Fadmin"});
  assert.equal(res.statusCode,400);assert.equal(calls,0);
});

test("F5 successful logout revokes a copied cookie in another API handler",async()=>{
  const session=createAdminSessionHandler({adminToken:TOKEN,adminTotpSecret:"",production:false,secureCookies:false});
  const login=await call(session,{method:"POST",body:{token:TOKEN}});
  const cookie=login.headers["set-cookie"].split(";")[0];
  const logout=await call(session,{method:"DELETE",headers:{cookie,"x-csrf-token":login.body.csrfToken}});
  assert.equal(logout.statusCode,200);
  const api=createAdminApiHandler({adminToken:TOKEN,adminTotpSecret:"",production:false,fetchDashboardFn:async()=>({settings:{}})});
  const replay=await call(api,{method:"GET",headers:{cookie}});
  assert.equal(replay.statusCode,401);
});
