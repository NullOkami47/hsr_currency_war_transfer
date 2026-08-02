import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkerHandler,
  JsonWorkerJobStore,
  TransferJobQueue,
} from "../src/worker.mjs";

const SOURCE_ID = "6a56fe3021253d0e1a9f4761";

function responseRecorder() {
  return {
    statusCode: 0,
    headers: new Map(),
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    end(value = "") {
      this.body = value;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function waitForResult(queue, jobId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await queue.get(jobId);
    if (result?.status !== "queued") return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Worker job did not finish in time");
}

test("deduplicates active jobs and publishes a persistent partial result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "currency-war-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let releaseTransfer;
  const transferGate = new Promise((resolve) => {
    releaseTransfer = resolve;
  });
  let transferCalls = 0;
  const store = new JsonWorkerJobStore(join(directory, "jobs.json"));
  const queue = new TransferJobQueue({
    store,
    transferFn: async (sourceId) => {
      transferCalls += 1;
      await transferGate;
      return {
        status: "created",
        sourceId,
        globalId: "6a6c694a2a5c4702d0b47b26",
        shareCode: "share-code",
        ignored: [{ type: "role", id: "9999", reason: "unavailable" }],
      };
    },
  });

  const [first, duplicate] = await Promise.all([
    queue.submit(SOURCE_ID),
    queue.submit(SOURCE_ID),
  ]);

  assert.equal(duplicate.jobId, first.jobId);
  for (let attempt = 0; attempt < 20 && transferCalls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(transferCalls, 1);

  releaseTransfer();
  const result = await waitForResult(queue, first.jobId);
  assert.equal(result.status, "partial");
  assert.equal(result.shareCode, "share-code");
  assert.equal(result.ignored[0].id, "9999");

  const reloaded = new JsonWorkerJobStore(join(directory, "jobs.json"));
  assert.equal((await reloaded.get(first.jobId)).status, "completed");
});

test("runs transfer jobs sequentially", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "currency-war-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let active = 0;
  let maximumActive = 0;
  const queue = new TransferJobQueue({
    store: new JsonWorkerJobStore(join(directory, "jobs.json")),
    transferFn: async (sourceId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "created", sourceId, ignored: [] };
    },
  });

  const first = await queue.submit(SOURCE_ID);
  const second = await queue.submit("6a4e123858aa043bf1070a99");
  await Promise.all([
    waitForResult(queue, first.jobId),
    waitForResult(queue, second.jobId),
  ]);

  assert.equal(maximumActive, 1);
});

test("protects worker jobs with a bearer token", async () => {
  const queue = {
    submit: async () => ({ status: "queued", jobId: "job-1" }),
    get: async () => ({ status: "queued", jobId: "job-1" }),
  };
  const handler = createWorkerHandler({
    queue,
    token: "a-long-worker-token-for-tests",
  });
  const unauthorised = responseRecorder();
  await handler(
    { method: "POST", url: "/jobs", headers: {}, body: { sourceId: SOURCE_ID } },
    unauthorised,
  );
  assert.equal(unauthorised.statusCode, 401);

  const authorised = responseRecorder();
  await handler(
    {
      method: "POST",
      url: "/jobs",
      headers: { authorization: "Bearer a-long-worker-token-for-tests" },
      body: { sourceId: SOURCE_ID },
    },
    authorised,
  );
  assert.equal(authorised.statusCode, 202);
  assert.equal(authorised.json().jobId, "job-1");
});

test("keeps public publishing disabled until an administrator enables it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "currency-war-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkerJobStore(join(directory, "jobs.json"));
  const queue = new TransferJobQueue({
    store,
    transferFn: async () => ({ status: "unchanged", shareCode: "code" }),
  });

  await assert.rejects(
    () => queue.submit(SOURCE_ID, { public: true, clientKey: "ip:one" }),
    (error) => error.code === "public_submissions_disabled",
  );

  await store.updateSettings({
    publicSubmissionsEnabled: true,
    sourceBlacklistEnabled: true,
    sourceBlacklist: [],
  });
  const accepted = await queue.submit(
    SOURCE_ID,
    { public: true, clientKey: "ip:one" },
  );
  assert.equal(accepted.status, "queued");
  await waitForResult(queue, accepted.jobId);
});

test("enforces source blacklist, per-IP limit, account quota and queue capacity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "currency-war-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const allowed = [
    SOURCE_ID,
    "6a4e123858aa043bf1070a99",
    "6a4e123858aa043bf1070a98",
  ];
  const store = new JsonWorkerJobStore(join(directory, "jobs.json"));
  await store.updateSettings({
    publicSubmissionsEnabled: true,
    sourceBlacklistEnabled: true,
    sourceBlacklist: ["6a4e123858aa043bf1070a97"],
    perIpLimit: 1,
    perIpWindowMinutes: 60,
    dailyAccountQuota: 2,
    maxPendingJobs: 2,
  });
  const queue = new TransferJobQueue({
    store,
    transferFn: async () => new Promise(() => {}),
  });

  await assert.rejects(
    () => queue.submit(
      "6a4e123858aa043bf1070a97",
      { public: true, clientKey: "ip:blocked" },
    ),
    (error) => error.code === "source_blocked",
  );

  await queue.submit(SOURCE_ID, { public: true, clientKey: "ip:one" });
  await assert.rejects(
    () => queue.submit(allowed[1], { public: true, clientKey: "ip:one" }),
    (error) => error.code === "rate_limited" && error.status === 429,
  );

  await queue.submit(allowed[1], { public: true, clientKey: "ip:two" });
  await assert.rejects(
    () => queue.submit(allowed[2], { public: true, clientKey: "ip:three" }),
    (error) => ["daily_quota_reached", "queue_full"].includes(error.code),
  );
});

test("updates settings and returns bounded administrator records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "currency-war-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkerJobStore(join(directory, "jobs.json"));
  const queue = new TransferJobQueue({
    store,
    transferFn: async (sourceId) => ({
      status: "created",
      sourceId,
      globalId: "6a6c694a2a5c4702d0b47b26",
      shareCode: "share-code",
      ignored: [],
    }),
  });
  const handler = createWorkerHandler({
    queue,
    store,
    token: "a-long-worker-token-for-tests",
  });
  const update = responseRecorder();
  await handler(
    {
      method: "PUT",
      url: "/admin",
      headers: { authorization: "Bearer a-long-worker-token-for-tests" },
      body: {
        publicSubmissionsEnabled: true,
        sourceBlacklistEnabled: false,
        dailyAccountQuota: 12,
        maxStoredJobs: 5,
      },
    },
    update,
  );
  assert.equal(update.statusCode, 200);
  assert.equal(update.json().settings.dailyAccountQuota, 12);

  for (let index = 0; index < 7; index += 1) {
    const sourceId = `6a56fe3021253d0e1a9f${String(index).padStart(4, "0")}`;
    const job = await queue.submit(sourceId);
    await waitForResult(queue, job.jobId);
  }

  const dashboard = responseRecorder();
  await handler(
    {
      method: "GET",
      url: "/admin",
      headers: { authorization: "Bearer a-long-worker-token-for-tests" },
    },
    dashboard,
  );
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.json().settings.maxStoredJobs, 5);
  assert.equal(dashboard.json().jobs.length, 5);
  assert.equal("clientKey" in dashboard.json().jobs[0], false);
});

test("disables public submissions when migrating a legacy allow-list", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "currency-war-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "jobs.json");
  await writeFile(path, JSON.stringify({
    version: 2,
    settings: {
      publicSubmissionsEnabled: true,
      sourceAllowlistEnabled: true,
      sourceAllowlist: [SOURCE_ID],
      perIpLimit: 5,
      perIpWindowMinutes: 60,
      dailyAccountQuota: 25,
      maxPendingJobs: 20,
      retentionDays: 30,
      maxStoredJobs: 1000,
    },
    jobs: {},
  }));

  const dashboard = await new JsonWorkerJobStore(path).dashboard();
  assert.equal(dashboard.settings.publicSubmissionsEnabled, false);
  assert.equal(dashboard.settings.sourceBlacklistEnabled, true);
  assert.deepEqual(dashboard.settings.sourceBlacklist, []);
  assert.equal("sourceAllowlist" in dashboard.settings, false);
});
