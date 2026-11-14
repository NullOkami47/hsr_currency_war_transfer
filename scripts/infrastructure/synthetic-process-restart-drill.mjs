import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Actual OS-process stop/start with persistent synthetic JSON and real Chrome.
// Run as non-root Linux. No production configuration, credential or profile.
if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Non-root Linux required");
const directory = await mkdtemp(join(tmpdir(), "hsr-process-restart-"));
const token = randomBytes(32).toString("base64url");
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const sourceId = "c".repeat(24);
let child, stderr = "", starts = 0, stdout = "";
async function launch({ pause = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CURRENCY_WAR_") && !key.startsWith("HSR_SYNTHETIC_")));
  Object.assign(env, { HSR_SYNTHETIC_ONLY: "1", HSR_SYNTHETIC_TOKEN: token, HSR_SYNTHETIC_STATE_DIR: directory, HSR_SYNTHETIC_PORT: String(port), HSR_SYNTHETIC_BROWSER_CHANNEL: "chrome", HSR_SYNTHETIC_PAUSE_BEFORE_TRANSFER: pause ? "1" : "0" });
  child = spawn(process.execPath, [resolve(import.meta.dirname, "synthetic-worker-server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  starts++;
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-2048); });
  stdout = "";
  child.stdout.on("data", bytes => { stdout = (stdout + bytes).slice(-4096); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Synthetic child exited before readiness");
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      if (response.ok && health.mode === "hsr-synthetic-worker") return health;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Synthetic child readiness timed out");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  const exited = new Promise((done, reject) => { current.once("error", reject); current.once("exit", (code, signal) => done({ code, signal })); });
  current.kill("SIGTERM");
  let timeout;
  try {
    const outcome = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Synthetic graceful shutdown timed out")), 25000); })]);
    assert.equal(outcome.code, 0);
  } finally { clearTimeout(timeout); }
}
async function completion(jobId) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const response = await fetch(`${base}/jobs/${jobId}`, { headers, signal: AbortSignal.timeout(2000) });
    const job = await response.json();
    if (job.status !== "queued") { assert.equal(job.status, "created"); assert.equal(job.synthetic, true); return job; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Synthetic Chrome job timed out");
}
try {
  const firstHealth = await launch();
  assert.equal((await fetch(`${base}/jobs`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await fetch(`${base}/jobs`, { method: "POST", body: JSON.stringify({ sourceId: "invalid" }), headers })).status, 400);
  const response = await fetch(`${base}/jobs`, { method: "POST", body: JSON.stringify({ sourceId, clientKey: "synthetic-drill" }), headers });
  assert.equal(response.status, 202);
  const first = await response.json();
  await completion(first.jobId);
  const before = JSON.parse(await readFile(join(directory, "jobs.json"), "utf8"));
  const securityBefore = JSON.parse(await readFile(join(directory, "jobs.json.security.json"), "utf8"));
  const mapBefore = await readFile(join(directory, "transfers.json"));
  await stop();
  const secondHealth = await launch();
  assert.equal(secondHealth.syntheticStateId, firstHealth.syntheticStateId);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "jobs.json"), "utf8")), before);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "jobs.json.security.json"), "utf8")), securityBefore);
  assert.deepEqual(await readFile(join(directory, "transfers.json")), mapBefore);
  await completion(first.jobId);
  const repeated = await fetch(`${base}/jobs`, { method: "POST", headers, body: JSON.stringify({ sourceId, clientKey: "synthetic-drill" }) });
  assert.equal(repeated.status, 202);
  await completion((await repeated.json()).jobId);
  assert.deepEqual(await readFile(join(directory, "transfers.json")), mapBefore);
  await stop();
  await launch({ pause: true });
  const interruptedResponse = await fetch(base + "/jobs", { method: "POST", headers, body: JSON.stringify({ sourceId: "d".repeat(24), clientKey: "synthetic-drill" }) });
  assert.equal(interruptedResponse.status, 202);
  const interrupted = await interruptedResponse.json();
  for (let attempt = 0; !stdout.includes("synthetic_transfer_waiting") && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(stdout.includes("synthetic_transfer_waiting"), "No crash before the intended synthetic transfer boundary");
  const beforeCrash = JSON.parse(await readFile(join(directory, "jobs.json"), "utf8"));
  assert.equal(beforeCrash.jobs[interrupted.jobId].status, "running");
  const killed = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGKILL");
  assert.equal((await killed).signal, "SIGKILL");
  await launch();
  await completion(interrupted.jobId);
  const afterCrash = JSON.parse(await readFile(join(directory, "jobs.json"), "utf8"));
  assert.deepEqual(afterCrash.quota, beforeCrash.quota);
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory, "transfers.json"), "utf8")).transfers).length, 2);
  await stop();
  assert.ok(!stderr.includes(token));
  console.log(JSON.stringify({ synthetic: true, verifiedAt: new Date().toISOString(), realProcessStarts: starts, gracefulStops: 3, interruptedProcessKills: 1, runningJobRecovered: true, crashRecoveryQuotaUnchanged: true, browserRuntime: "real Chrome synthetic probe", health: true, unauthorisedRejected: true, invalidPayloadRejected: true, mappingsPersisted: true, jobsPersisted: true, quotaAndPolicyPersisted: true, securityPersisted: true, duplicateMappingUnchanged: true, productionPublishing: false, systemdVerified: false, gcpVerified: false }));
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
