import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startSyntheticWorker, validateSyntheticEnvironment } from "../scripts/infrastructure/synthetic-worker-server.mjs";
const token = "synthetic-staging-test-token-only-0000000000";
const sourceId = "a".repeat(24);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hsr-synthetic-service-"));
  t.recoveryClosers = [];
  t.after(async () => { for (const close of t.recoveryClosers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function result(base, id) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${base}/jobs/${id}`, { headers });
    const value = await response.json();
    if (value.status !== "queued") return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic job did not finish");
}
function submit(base, source = sourceId) {
  return fetch(`${base}/jobs`, { method: "POST", headers, body: JSON.stringify({ sourceId: source, clientKey: "synthetic-test" }) });
}

test("synthetic service rejects inherited production configuration and non-loopback binds", () => {
  assert.doesNotThrow(() => validateSyntheticEnvironment({ HSR_SYNTHETIC_ONLY: "1", HSR_SYNTHETIC_TOKEN: token, HSR_SYNTHETIC_STATE_DIR: join(tmpdir(), "new-synthetic") }));
  for (const patch of [ { CURRENCY_WAR_WORKER_TOKEN: "production-must-not-be-read" }, { CURRENCY_WAR_PROFILE_DIR: "/production/profile" }, { HSR_SYNTHETIC_ONLY: "0" }, { HSR_SYNTHETIC_HOST: "0.0.0.0" }, { HSR_SYNTHETIC_STATE_DIR: "." } ]) {
    assert.throws(() => validateSyntheticEnvironment({ HSR_SYNTHETIC_ONLY: "1", HSR_SYNTHETIC_TOKEN: token, HSR_SYNTHETIC_STATE_DIR: join(tmpdir(), "new-synthetic"), ...patch }));
  }
});

test("synthetic service refuses unmarked nonempty state and never adopts an existing profile", async t => {
  const root = await fixture(t), directory = join(root, "existing");
  await mkdir(directory);
  await writeFile(join(directory, "jobs.json"), "production-like-marker");
  await assert.rejects(startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) }), /unmarked|synthetic/i);
  assert.equal(await readFile(join(directory, "jobs.json"), "utf8"), "production-like-marker");
});

test("real HTTP handlers preserve bearer, payload, active-duplicate, quota and persisted mapping contracts", async t => {
  const root = await fixture(t);
  let release, signal;
  const entered = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let launches = 0;
  const worker = await startSyntheticWorker({ directory: join(root, "state"), token, browserCheck: async () => { launches++; signal(); await gate; return { synthetic: true, browserVersion: "synthetic-injected" }; } });
  t.recoveryClosers.push(async () => { release(); await worker.close(); });
  const health = await (await fetch(`${worker.endpoint}/health`)).json();
  assert.equal(health.mode, "hsr-synthetic-worker");
  assert.equal((await fetch(`${worker.endpoint}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId }) })).status, 401);
  assert.equal((await submit(worker.endpoint, "invalid")).status, 400);
  const first = await (await submit(worker.endpoint)).json();
  await entered;
  const duplicate = await (await submit(worker.endpoint)).json();
  assert.equal(duplicate.jobId, first.jobId);
  release();
  const completed = await result(worker.endpoint, first.jobId);
  assert.equal(completed.synthetic, true);
  assert.equal(completed.shareCode, "SYNTHETIC-" + sourceId.slice(0, 12));
  const admin = await (await fetch(`${worker.endpoint}/admin`, { headers })).json();
  assert.equal(admin.stats.jobsToday, 1);
  assert.equal(launches, 1);
  const maps = JSON.parse(await readFile(join(root, "state", "transfers.json")));
  assert.equal(maps.transfers[sourceId].shareCode, completed.shareCode);
  assert.ok(JSON.parse(await readFile(join(root, "state", "jobs.json.security.json"))).requests.submit);
});

test("service recreation retains mappings, policy, quota, security and never republishes completed source", async t => {
  const root = await fixture(t), directory = join(root, "state");
  let launches = 0;
  const browserCheck = async () => { launches++; return { synthetic: true }; };
  let worker = await startSyntheticWorker({ directory, token, browserCheck });
  const first = await (await submit(worker.endpoint)).json();
  await result(worker.endpoint, first.jobId);
  await fetch(`${worker.endpoint}/admin`, { method: "PUT", headers, body: JSON.stringify({ dailyAccountQuota: 1 }) });
  const marker = (await (await fetch(`${worker.endpoint}/health`)).json()).syntheticStateId;
  await worker.close();
  worker = await startSyntheticWorker({ directory, token, browserCheck });
  t.recoveryClosers.push(() => worker.close());
  assert.equal((await (await fetch(`${worker.endpoint}/health`)).json()).syntheticStateId, marker);
  assert.equal((await result(worker.endpoint, first.jobId)).status, "created");
  assert.equal((await submit(worker.endpoint, "b".repeat(24))).status, 429);
  const admin = await (await fetch(`${worker.endpoint}/admin`, { headers })).json();
  assert.equal(admin.stats.jobsToday, 1);
  assert.equal(admin.settings.dailyAccountQuota, 1);
  assert.equal(launches, 1);
  await fetch(`${worker.endpoint}/admin`, { method: "PUT", headers, body: JSON.stringify({ dailyAccountQuota: 25 }) });
  const repeated = await (await submit(worker.endpoint)).json();
  assert.equal((await result(worker.endpoint, repeated.jobId)).shareCode, "SYNTHETIC-" + sourceId.slice(0, 12));
  assert.equal(launches, 1);
});

test("interrupted synthetic running work is recoverable with one mapping and unchanged quota", async t => {
  const root = await fixture(t), directory = join(root, "state");
  const seeded = await startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) });
  await seeded.close();
  const { JsonWorkerJobStore } = await import("../src/worker.mjs");
  const store = new JsonWorkerJobStore(join(directory, "jobs.json"));
  const { job } = await store.createOrGetActive(sourceId, { public: true, clientKey: "synthetic" });
  await store.update(job.id, { status: "running" });
  let calls = 0;
  const worker = await startSyntheticWorker({ directory, token, browserCheck: async () => { calls++; return { synthetic: true }; } });
  t.recoveryClosers.push(() => worker.close());
  assert.equal((await result(worker.endpoint, job.id)).status, "created");
  assert.equal((await worker.store.dashboard()).stats.jobsToday, 1);
  assert.equal(calls, 1);
});

test("a second service cannot own the same marked synthetic state", async t => {
  const root = await fixture(t), directory = join(root, "state");
  const worker = await startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) });
  t.recoveryClosers.push(() => worker.close());
  await assert.rejects(startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) }), /owned|live process/i);
  assert.equal((await fetch(`${worker.endpoint}/health`)).status, 200);
});

test("durable request budgets survive service recreation", async t => {
  const root = await fixture(t), directory = join(root, "state");
  let worker = await startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) });
  t.recoveryClosers.push(() => worker.close());
  const first = await (await submit(worker.endpoint)).json();
  await result(worker.endpoint, first.jobId);
  await fetch(`${worker.endpoint}/admin`, { method: "PUT", headers, body: JSON.stringify({ perIpLimit: 100, dailyAccountQuota: 100 }) });
  for (let i=1;i<10;i++) assert.equal((await submit(worker.endpoint)).status, 202);
  assert.equal((await submit(worker.endpoint)).status, 429);
  await worker.close();
  worker = await startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) });
  assert.equal((await submit(worker.endpoint)).status, 429);
});

test("only provably dead synthetic transfer locks are removed on restart", async t => {
  const root = await fixture(t), directory = join(root, "state");
  let worker = await startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) });
  t.recoveryClosers.push(() => worker.close());
  await worker.close();
  await writeFile(join(directory, "transfers.json.lock"), String(process.pid));
  await assert.rejects(startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) }), /lock|writer/i);
  await writeFile(join(directory, "transfers.json.lock"), "2147483647");
  worker = await startSyntheticWorker({ directory, token, browserCheck: async () => ({ synthetic: true }) });
  const first = await (await submit(worker.endpoint)).json();
  assert.equal((await result(worker.endpoint, first.jobId)).status, "created");
});
