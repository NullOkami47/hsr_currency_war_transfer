import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Real transient systemd unit on a development/test host only. Never targets
// hsr-transfer-worker.service, never uses production paths or bearer credentials.
if (process.platform !== "linux" || process.getuid?.() === 0 || process.env.HSR_SYSTEMD_DRILL_ALLOW_SUDO !== "1") throw new Error("Non-root Linux and explicit development-host sudo permission required");
const run = promisify(execFile);
const unit = "hsr-synthetic-drill-" + randomBytes(6).toString("hex") + ".service";
const root = await mkdtemp(join(tmpdir(), "hsr-systemd-drill-"));
const directory = join(root, "synthetic-state");
await mkdir(directory, { mode: 0o700 });
const browserHome = join(root, "browser-home");
await mkdir(browserHome, { mode: 0o700 });
const token = randomBytes(32).toString("base64url");
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const envfile = join(root, "synthetic.env");
await writeFile(envfile, ["HSR_SYNTHETIC_ONLY=1", "HOME=" + browserHome, "XDG_CONFIG_HOME=" + browserHome + "/.config", "XDG_CACHE_HOME=" + browserHome + "/.cache", `HSR_SYNTHETIC_STATE_DIR=${directory}`, `HSR_SYNTHETIC_TOKEN=${token}`, `HSR_SYNTHETIC_PORT=${port}`, "HSR_SYNTHETIC_BROWSER_CHANNEL=chrome"].join("\n") + "\n", { mode: 0o600 });
const repo = resolve(import.meta.dirname, "../..");
const systemctl = (...args) => run("sudo", ["-n", "systemctl", ...args, unit], { timeout: 35000, maxBuffer: 100000 });
async function properties() {
  const { stdout } = await systemctl("show", "--property=ActiveState,SubState,MainPID,NRestarts,MemoryPeak,MemoryCurrent,TasksCurrent,TasksMax,CPUUsageNSec,Result,NoNewPrivileges,ProtectSystem,PrivateTmp,KillMode,RuntimeMaxUSec");
  return Object.fromEntries(stdout.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
}
async function stopUnit() {
  try { await systemctl("stop"); }
  catch (error) {
    const { stdout } = await run("sudo", ["-n", "systemctl", "show", unit, "--property=LoadState,ActiveState,MainPID"], { timeout: 10000 });
    if (!/LoadState=not-found/.test(stdout) || !/ActiveState=inactive/.test(stdout) || !/MainPID=0/.test(stdout)) throw error;
  }
}
async function ready(oldPid = null) {
  for (let i = 0; i < 100; i++) {
    const state = await properties();
    if (state.ActiveState === "failed") throw new Error("Synthetic transient service failed; sandbox restrictions were not relaxed");
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.mode === "hsr-synthetic-worker" && (!oldPid || state.MainPID !== oldPid)) return { state, health };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Synthetic systemd service readiness timed out");
}
async function completed(id) {
  for (let i = 0; i < 180; i++) {
    const response = await fetch(`${base}/jobs/${id}`, { headers, signal: AbortSignal.timeout(3000) });
    const job = await response.json();
    if (job.status !== "queued") { assert.equal(job.status, "created"); assert.equal(job.synthetic, true); return; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Synthetic Chrome job timed out");
}
let started = false, stopped = false;
try {
  const { stdout: user } = await run("id", ["-un"]), { stdout: group } = await run("id", ["-gn"]);
  started = true; // The unit identity is fixed even if submission has an unknown outcome.
  await run("sudo", ["-n", "systemd-run", "--quiet", "--collect", `--unit=${unit}`, "--service-type=exec",
    `--property=User=${user.trim()}`, `--property=Group=${group.trim()}`, `--property=WorkingDirectory=${repo}`,
    `--property=EnvironmentFile=${envfile}`, "--property=Restart=on-failure", "--property=RestartSec=1",
    "--property=KillMode=control-group", "--property=TimeoutStopSec=25", "--property=RuntimeMaxSec=180",
    "--property=NoNewPrivileges=true", "--property=PrivateTmp=true", "--property=ProtectSystem=strict",
    "--property=ProtectHome=true", `--property=BindReadOnlyPaths=${repo} ${process.execPath}`,
    `--property=BindPaths=${root}`, `--property=ReadWritePaths=${directory} ${browserHome}`, "--property=UMask=0077",
    "--property=MemoryAccounting=true", "--property=CPUAccounting=true", "--property=TasksMax=256",
    process.execPath, join(repo, "scripts/infrastructure/synthetic-worker-server.mjs")], { timeout: 10000, maxBuffer: 10000 });
  const first = await ready();
  assert.equal(first.state.NoNewPrivileges, "yes");
  assert.equal(first.state.ProtectSystem, "strict");
  assert.equal(first.state.KillMode, "control-group");
  assert.equal((await fetch(`${base}/jobs`, { method: "POST", body: "{}" })).status, 401);
  const submission = await fetch(`${base}/jobs`, { method: "POST", headers, body: JSON.stringify({ sourceId: "e".repeat(24), clientKey: "synthetic-systemd" }) });
  assert.equal(submission.status, 202);
  const job = await submission.json();
  await completed(job.jobId);
  const stateBefore = await readFile(join(directory, "jobs.json"));
  const securityBefore = await readFile(join(directory, "jobs.json.security.json"));
  const mapsBefore = await readFile(join(directory, "transfers.json"));
  const browserWorkloadAccounting = await properties();
  await systemctl("kill", "--kill-whom=main", "--signal=SIGKILL");
  const restarted = await ready(first.state.MainPID);
  assert.equal(restarted.health.syntheticStateId, first.health.syntheticStateId);
  assert.ok(Number(restarted.state.NRestarts) >= 1);
  assert.deepEqual(await readFile(join(directory, "jobs.json")), stateBefore);
  assert.deepEqual(await readFile(join(directory, "jobs.json.security.json")), securityBefore);
  assert.deepEqual(await readFile(join(directory, "transfers.json")), mapsBefore);
  await completed(job.jobId);
  const usage = await properties();
  await stopUnit();
  const { stdout: active } = await run("sudo", ["-n", "systemctl", "show", unit, "--property=ActiveState,MainPID"], { timeout: 10000 });
  assert.ok(/ActiveState=inactive/.test(active) && /MainPID=0/.test(active));
  stopped = true;
  console.log(JSON.stringify({ synthetic: true, verifiedAt: new Date().toISOString(), systemdVerified: true, transientUnit: unit,
    chromeJobCompleted: true, systemdCrashRestart: true, restartStatePreserved: true, stopped: true,
    firstPid: first.state.MainPID, restartedPid: restarted.state.MainPID, restarts: restarted.state.NRestarts,
    browserWorkloadAccounting, accountingAfterRestart: usage, gcpVerified: false, productionPublishing: false }));
} finally {
  if (started && !stopped) await stopUnit();
  await rm(root, { recursive: true, force: true });
}
