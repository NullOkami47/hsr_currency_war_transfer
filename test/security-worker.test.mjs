import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JsonWorkerJobStore, createWorkerHandler, DEFAULT_WORKER_SETTINGS } from "../src/worker.mjs";
import { JsonSecurityStore } from "../src/security-state.mjs";
import { REQUEST_BUDGETS } from "../src/request-budget.mjs";
import { createTransfersHandler, submitTransferToWorker, getTransferFromWorker } from "../src/http.mjs";

const SOURCE = "6a56fe3021253d0e1a9f4761";
const TOKEN = "synthetic-worker-token-for-tests";
const source = index => index.toString(16).padStart(24, "0");
const publicContext = { public: true, clientKey: "synthetic-client" };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "hsr-security-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "jobs.json"), securityPath: join(dir, "security.json") };
}
function response() {
  return { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = JSON.parse(body); } };
}
async function call(handler, request) {
  const res = response();
  await handler({ headers: { authorization: `Bearer ${TOKEN}` }, ...request }, res);
  return res;
}

for (const initial of [false, true]) {
  test(`F2 bootstrap persists the first decision (${initial}) and ignores all restart flags`, async t => {
    const { path } = await fixture(t);
    await new JsonWorkerJobStore(path).initialise(initial ? { publicSubmissionsEnabled: true } : {});
    const restarted = new JsonWorkerJobStore(path);
    await restarted.initialise({ publicSubmissionsEnabled: !initial, sourceBlacklistEnabled: false });
    const state = await restarted.dashboard();
    assert.equal(state.settings.publicSubmissionsEnabled, initial);
    assert.equal(state.settings.sourceBlacklistEnabled, true);
  });
}

test("F2 an administrator's initial disable decision is persisted even when it equals defaults", async t => {
  const { path } = await fixture(t);
  await new JsonWorkerJobStore(path).updateSettings({ publicSubmissionsEnabled: false });
  await new JsonWorkerJobStore(path).initialise({ publicSubmissionsEnabled: true });
  assert.equal(JSON.parse(await readFile(path, "utf8")).settings.publicSubmissionsEnabled, false);
});

test("F2 malformed state fails closed and is never overwritten by bootstrap", async t => {
  const { path } = await fixture(t);
  await writeFile(path, "{corrupt");
  await assert.rejects(() => new JsonWorkerJobStore(path).initialise({ publicSubmissionsEnabled: true }));
  assert.equal(await readFile(path, "utf8"), "{corrupt");
});

test("F3 retained history cannot reduce dashboard accounting", async t => {
  const { path } = await fixture(t);
  const store = new JsonWorkerJobStore(path);
  await store.updateSettings({ publicSubmissionsEnabled: true, maxStoredJobs: 5, perIpLimit: 20, dailyAccountQuota: 8 });
  for (let i = 0; i < 7; i++) {
    const { job } = await store.createOrGetActive(source(i), publicContext);
    await store.update(job.id, { status: i % 2 ? "failed" : "completed" });
  }
  const dashboard = await new JsonWorkerJobStore(path).dashboard();
  assert.equal(dashboard.jobs.length, 5);
  assert.equal(dashboard.stats.jobsToday, 7);
  assert.equal(dashboard.stats.remainingDailyQuota, 1);
});

test("F3 quota windows expire on time but a UTC day change does not reset client quota", async t => {
  const { path } = await fixture(t);
  let time = Date.parse("2026-11-09T23:59:00Z");
  const now = () => new Date(time);
  let store = new JsonWorkerJobStore(path, { now });
  await store.updateSettings({ publicSubmissionsEnabled: true, perIpLimit: 1, dailyAccountQuota: 1, perIpWindowMinutes: 60 });
  const first = await store.createOrGetActive(source(1), publicContext);
  await store.update(first.job.id, { status: "completed" });
  time += 60_000;
  store = new JsonWorkerJobStore(path, { now });
  await assert.rejects(() => store.createOrGetActive(source(2), publicContext), e => e.code === "rate_limited");
  assert.equal((await store.dashboard()).stats.remainingDailyQuota, 1);
  time += 59 * 60_000;
  assert.equal((await store.createOrGetActive(source(2), publicContext)).created, true);
});

test("F3 increasing a client window cannot resurrect quota erased under a shorter window", async t => {
  const { path } = await fixture(t);
  let time = Date.parse("2026-11-09T10:00:00Z");
  const now = () => new Date(time);
  const store = new JsonWorkerJobStore(path, { now });
  await store.updateSettings({ publicSubmissionsEnabled: true, perIpLimit: 1, perIpWindowMinutes: 1 });
  const { job } = await store.createOrGetActive(source(1), publicContext);
  await store.update(job.id, { status: "failed" });
  time += 120_000;
  await store.updateSettings({ perIpWindowMinutes: 60 });
  await assert.rejects(() => store.createOrGetActive(source(2), publicContext), e => e.code === "rate_limited");
});

test("F3 existing legacy files recover fail-closed when pruned evidence cannot be reconstructed", async t => {
  const { path } = await fixture(t);
  let time = Date.parse("2026-11-09T10:00:00Z");
  const now = () => new Date(time);
  await writeFile(path, JSON.stringify({ version: 3, settings: { ...DEFAULT_WORKER_SETTINGS, publicSubmissionsEnabled: true }, jobs: {} }));
  const store = new JsonWorkerJobStore(path, { now });
  await store.initialise({ publicSubmissionsEnabled: true });
  await assert.rejects(() => store.createOrGetActive(SOURCE, publicContext), e => e.code === "quota_migration_cooldown");
  const expiry = (await store.dashboard()).stats.quotaRecoveryUntil;
  time += 23 * 3_600_000;
  const restarted = new JsonWorkerJobStore(path, { now });
  await restarted.initialise({ publicSubmissionsEnabled: true });
  assert.equal((await restarted.dashboard()).stats.quotaRecoveryUntil, expiry);
  await assert.rejects(() => restarted.createOrGetActive(SOURCE, publicContext), e => e.code === "quota_migration_cooldown");
  time += 3_600_000;
  assert.equal((await restarted.createOrGetActive(SOURCE, publicContext)).created, true);
});

test("F3 simultaneous store clients cannot oversubscribe the last publishing slot", async t => {
  const { path } = await fixture(t);
  const store = new JsonWorkerJobStore(path);
  await store.updateSettings({ publicSubmissionsEnabled: true, dailyAccountQuota: 1 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    new JsonWorkerJobStore(path).createOrGetActive(source(i), publicContext)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason.code === "daily_quota_reached"));
});

for (const kind of ["submit", "poll"]) {
  test(`F4 durable ${kind} request budget survives restart and recovers at window expiry`, async t => {
    const { securityPath } = await fixture(t);
    let security = new JsonSecurityStore(securityPath);
    const time = Date.parse("2026-11-09T10:00:00Z");
    for (let i = 0; i < REQUEST_BUDGETS[kind].limit; i++) assert.equal((await security.consume(kind, "one", time)).allowed, true);
    security = new JsonSecurityStore(securityPath);
    assert.equal((await security.consume(kind, "one", time + 1)).allowed, false);
    assert.equal((await security.consume(kind, "two", time + 1)).allowed, true);
    assert.equal((await security.consume(kind, "one", time + 60_000)).allowed, true);
  });
}

test("F4 global worker budget bounds identity churn and rejected calls do not rewrite state", async t => {
  const { securityPath } = await fixture(t);
  const security = new JsonSecurityStore(securityPath);
  for (let i = 0; i < REQUEST_BUDGETS.submit.globalLimit; i++) assert.equal((await security.consume("submit", String(i), 0)).allowed, true);
  const before = await readFile(securityPath, "utf8");
  const metadata = await stat(securityPath);
  assert.equal((await security.consume("submit", "new-client", 1)).allowed, false);
  assert.equal(await readFile(securityPath, "utf8"), before);
  assert.equal((await stat(securityPath)).mtimeMs, metadata.mtimeMs);
});

test("F4 multiple public API instances share the worker budget across worker restarts", async t => {
  const { path, securityPath } = await fixture(t);
  const store = new JsonWorkerJobStore(path);
  let submissions = 0;
  const queue = { submit: async () => { submissions++; return { status: "queued", jobId: "job-1" }; }, get: async () => ({ status: "queued", jobId: "job-1" }) };
  let worker = createWorkerHandler({ store, queue, token: TOKEN, securityStore: new JsonSecurityStore(securityPath) });
  const fetchFn = async (url, options) => {
    const res = await call(worker, { method: options.method, url: new URL(url).pathname, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.body };
  };
  function api() {
    const options = { workerUrl: "http://127.0.0.1/jobs", workerToken: TOKEN, fetchFn };
    return createTransfersHandler({
      clientKeyFn: () => "shared-client",
      submitTransferFn: (id, context) => submitTransferToWorker(id, { ...options, ...context }),
      getTransferFn: (id, context) => getTransferFromWorker(id, { ...options, ...context }),
    });
  }
  const submit = handler => call(handler, { method: "POST", url: "/api/transfers", body: { source: SOURCE } });
  for (let i = 0; i < REQUEST_BUDGETS.submit.limit; i++) assert.equal((await submit(api())).statusCode, 202);
  worker = createWorkerHandler({ store, queue, token: TOKEN, securityStore: new JsonSecurityStore(securityPath) });
  const rejected = await submit(api());
  assert.equal(rejected.statusCode, 429);
  assert.ok(rejected.headers["retry-after"] > 0);
  assert.equal(submissions, REQUEST_BUDGETS.submit.limit);
  for (let i = 0; i < REQUEST_BUDGETS.poll.limit; i++) assert.equal((await call(api(), { method: "GET", url: "/api/transfers?jobId=job-1" })).statusCode, 200);
  worker = createWorkerHandler({ store, queue, token: TOKEN, securityStore: new JsonSecurityStore(securityPath) });
  assert.equal((await call(api(), { method: "GET", url: "/api/transfers?jobId=job-1" })).statusCode, 429);
});

test("F4 worker concurrency rejects overload before storage and releases after failure", async () => {
  let release, accesses = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const worker = createWorkerHandler({ token: TOKEN, maxConcurrent: 1,
    queue: { get: async () => { await blocked; throw new Error("private-path"); } },
    securityStore: { consume: async () => { accesses++; return { allowed: true }; } },
  });
  const first = call(worker, { method: "GET", url: "/jobs/one" });
  assert.equal((await call(worker, { method: "GET", url: "/jobs/two" })).statusCode, 429);
  assert.equal(accesses, 1);
  release();
  const failed = await first;
  assert.equal(failed.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(failed.body), /private-path/);
  assert.equal((await call(worker, { method: "GET", url: "/jobs/one" })).statusCode, 500);
  assert.equal(accesses, 2);
});

test("F4 failed budget persistence never queues a publishing job", async () => {
  let submissions = 0;
  const worker = createWorkerHandler({ token: TOKEN,
    queue: { submit: async () => { submissions++; } },
    securityStore: { consume: async () => { throw new Error("sensitive-storage-error"); } },
  });
  const res = await call(worker, { method: "POST", url: "/jobs", body: { sourceId: SOURCE } });
  assert.equal(res.statusCode, 500);
  assert.equal(submissions, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /sensitive-storage/);
});

test("F4 unauthenticated and malformed worker requests do not touch security state", async () => {
  let accesses = 0;
  const worker = createWorkerHandler({ token: TOKEN, queue: {}, securityStore: { consume: async () => { accesses++; } } });
  assert.equal((await call(worker, { method: "POST", url: "/jobs", headers: {}, body: { sourceId: SOURCE } })).statusCode, 401);
  assert.equal((await call(worker, { method: "POST", url: "/jobs", body: { sourceId: "bad" } })).statusCode, 400);
  assert.equal((await call(worker, { method: "GET", url: "/jobs/one?nonce=1" })).statusCode, 400);
  assert.equal(accesses, 0);
});

test("F2 actual worker process restart honours an administrator disable despite bootstrap environment", async t => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const { once } = await import("node:events");
  const { path, dir } = await fixture(t);
  const portFinder = createServer();
  portFinder.listen(0, "127.0.0.1");
  await once(portFinder, "listening");
  const port = portFinder.address().port;
  await new Promise(resolve => portFinder.close(resolve));
  async function start() {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL("../scripts/worker-server.mjs", import.meta.url))], {
      env: {
        ...globalThis.process.env,
        CURRENCY_WAR_WORKER_TOKEN: TOKEN,
        CURRENCY_WAR_WORKER_HOST: "127.0.0.1",
        CURRENCY_WAR_WORKER_PORT: String(port),
        CURRENCY_WAR_JOB_STATE_PATH: path,
        CURRENCY_WAR_STATE_PATH: join(dir, "mapping.json"),
        CURRENCY_WAR_PROFILE_DIR: join(dir, "unused-profile"),
        CURRENCY_WAR_PUBLIC_SUBMISSIONS: "1",
        CURRENCY_WAR_SESSION_KEEPALIVE_MINUTES: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(process, "exit");
    let errors = "";
    process.stderr.on("data", chunk => { errors += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Isolated worker startup timed out")), 8000);
      process.stdout.on("data", chunk => {
        if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(); }
      });
      process.once("exit", () => { clearTimeout(timer); reject(new Error(`Isolated worker failed: ${errors}`)); });
      process.once("error", reject);
    });
    return async () => { process.kill(); await exited; };
  }
  let stop;
  try {
    stop = await start();
    assert.equal((await new JsonWorkerJobStore(path).dashboard()).settings.publicSubmissionsEnabled, true);
    const response = await fetch(`http://127.0.0.1:${port}/admin`, {
      method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ publicSubmissionsEnabled: false }),
    });
    assert.equal(response.status, 200);
    await response.json();
    await stop(); stop = null;
    stop = await start();
    assert.equal((await new JsonWorkerJobStore(path).dashboard()).settings.publicSubmissionsEnabled, false);
  } finally { if (stop) await stop(); }
});

test("F2 a JSON null file is corrupt state, not permission to bootstrap", async t => {
  const { path } = await fixture(t);
  await writeFile(path, "null");
  await assert.rejects(() => new JsonWorkerJobStore(path).initialise({ publicSubmissionsEnabled: true }));
  assert.equal(await readFile(path, "utf8"), "null");
});
