// Loopback-only worker handler with a synthetic transfer and temporary state.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerHandler, JsonWorkerJobStore, TransferJobQueue } from "../../src/worker.mjs";

const directory = await mkdtemp(join(tmpdir(), "hsr-oracle-http-"));
const token = "synthetic-staging-token-not-a-secret";
const sourceId = "6a56fe3021253d0e1a9f4761";
const store = new JsonWorkerJobStore(join(directory, "jobs.json"));
let calls = 0;
const queue = new TransferJobQueue({ store, transferFn: async (id) => {
  calls += 1;
  return { status: "created", sourceId: id, shareCode: "synthetic", ignored: [] };
} });
const server = createServer(createWorkerHandler({ queue, store, token }));
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const unauthorised = await fetch(`${base}/jobs`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId, clientKey: "synthetic" }) });
  assert.equal(unauthorised.status, 401);
  assert.equal(calls, 0);
  assert.equal(Object.keys((await store.readState()).jobs).length, 0);
  await store.updateSettings({ publicSubmissionsEnabled: true });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const submitted = await fetch(`${base}/jobs`, { method: "POST", headers,
    body: JSON.stringify({ sourceId, clientKey: "synthetic" }) });
  assert.equal(submitted.status, 202);
  const { jobId } = await submitted.json();
  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/jobs/${jobId}`, { headers });
    assert.equal(response.status, 200);
    job = await response.json();
    if (job.status === "created") break;
    if (job.status === "failed") throw new Error("Synthetic transfer failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job?.status, "created");
  assert.equal(job.shareCode, "synthetic");
  assert.equal(calls, 1);
  const restored = await new JsonWorkerJobStore(join(directory, "jobs.json")).get(jobId);
  assert.equal(restored.status, "completed");
  assert.deepEqual(restored.result, { status: "created", sourceId, shareCode: "synthetic", ignored: [] });
} finally {
  try {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log("PASS: loopback health, unauthorised rejection, synthetic job and persisted result");
