import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
const TARGET = Object.freeze({ project: "hsr-currency-war-worker", zone: "us-central1-a", instance: "hsr-worker-standby" });
const root = config => `https://www.googleapis.com/compute/v1/projects/${config.project}/zones/${config.zone}`;
const flags = config => [`--account=${config.account}`, `--project=${config.project}`, `--zone=${config.zone}`, "--format=json", "--quiet"];
const projectFlags = config => flags(config).filter(flag => !flag.startsWith("--zone="));
const describe = (config, run) => run(["compute", "instances", "describe", config.instance, ...flags(config)]);

export function validateStandbyConfig(config) {
  const pin = config?.approvedTarget;
  if (!config || !/^[^\s@]+@[^\s@]+$/.test(config.account ?? "")
    || Object.entries(TARGET).some(([key, value]) => config[key] !== value)
    || !pin || ["account", "project", "zone", "instance"].some(key => pin[key] !== config[key])
    || !/^[1-9][0-9]*$/.test(pin.instanceId ?? "") || !/^[1-9][0-9]*$/.test(pin.diskId ?? "")
    || typeof pin.instanceId !== "string" || typeof pin.diskId !== "string"
    || !Number.isInteger(config.maxRunSeconds) || config.maxRunSeconds < 300 || config.maxRunSeconds > 3600) {
    throw new Error("Exact approved account/project/zone/existing VM and disk IDs, and 300-3600s limit required");
  }
}

function validateIdentity(config, vm) {
  validateStandbyConfig(config);
  if (vm?.id !== config.approvedTarget.instanceId || vm?.name !== config.instance
    || vm?.selfLink !== `${root(config)}/instances/${config.instance}`) throw new Error("Pinned existing VM identity mismatch");
  return vm;
}

function approveIpv4(config, { allowTemporaryIpv4 = false, now = () => new Date(), remainingSeconds = 0 } = {}) {
  const approval = config.temporaryIpv4Approval;
  const remaining = Date.parse(approval?.expiresAt) - now().getTime();
  if (allowTemporaryIpv4 !== true || approval?.approved !== true || approval?.nonZeroCostAccepted !== true
    || !Number.isFinite(remaining) || remaining <= 0 || remaining < remainingSeconds * 1000 || remaining > 86400000) {
    throw new Error("Explicit unexpired temporary IPv4 approval accepting non-zero cost is required");
  }
}

export function validateStandbyInstance(config, vm, options = {}) {
  validateIdentity(config, vm);
  if (vm.machineType !== `${root(config)}/machineTypes/e2-micro`
    || vm.labels?.purpose !== "hsr-worker-standby" || vm.labels?.mode !== "synthetic"
    || (vm.serviceAccounts ?? []).length !== 0) throw new Error("Only the labelled synthetic e2-micro without VM credentials is allowed");
  if (!Array.isArray(vm.disks) || vm.disks.length !== 1 || vm.disks[0].boot !== true
    || vm.disks[0].type !== "PERSISTENT" || vm.disks[0].autoDelete !== false
    || vm.disks[0].source !== `${root(config)}/disks/${config.instance}`) throw new Error("One retained, pinned persistent boot disk required");
  if (!Array.isArray(vm.networkInterfaces) || vm.networkInterfaces.length !== 1) throw new Error("One explicit network interface required");
  const nic = vm.networkInterfaces[0], ipv4 = nic.accessConfigs ?? [];
  if (!Array.isArray(ipv4) || !Array.isArray(nic.ipv6AccessConfigs ?? [])) throw new Error("Invalid network readback");
  if (ipv4.length) {
    approveIpv4(config, options);
    if (ipv4.length !== 1 || ipv4[0].type !== "ONE_TO_ONE_NAT" || !["IPV4_ONLY", "IPV4_IPV6"].includes(nic.stackType)) throw new Error("Only one temporary direct IPv4 configuration is allowed");
  } else if (nic.stackType !== "IPV4_IPV6" || !(nic.ipv6AccessConfigs ?? []).some(a => a.externalIpv6)) {
    throw new Error("External IPv6 or explicitly approved temporary IPv4 required");
  }
  return vm;
}

async function authenticated(config, run) {
  const accounts = await run(["auth", "list", ...projectFlags(config)]);
  if (!Array.isArray(accounts) || !accounts.some(a => a.account === config.account)) throw new Error("Pinned Google account is not authenticated");
}

export async function inspectStandby({ config, run, ...options }) {
  validateStandbyConfig(config);
  await authenticated(config, run);
  const vm = validateStandbyInstance(config, await describe(config, run), options);
  const disk = await run(["compute", "disks", "describe", config.instance, ...flags(config)]);
  const size = Number(disk?.sizeGb);
  if (disk?.id !== config.approvedTarget.diskId || disk.selfLink !== vm.disks[0].source
    || disk.name !== config.instance || disk.type !== `${root(config)}/diskTypes/pd-standard`
    || disk.status !== "READY" || !Number.isInteger(size) || size < 20 || size > 30) throw new Error("Actual retained boot disk must be the pinned READY pd-standard 20-30GB disk");
  const address = vm.networkInterfaces[0].accessConfigs?.[0]?.natIP;
  if (address) {
    const reserved = await run(["compute", "addresses", "list", ...projectFlags(config)]);
    if (!Array.isArray(reserved) || reserved.some(a => a.address === address)) throw new Error("Reserved/static IPv4 is outside temporary staging authority");
  }
  return vm;
}

function stopPolicy(config, vm) {
  if (vm.scheduling?.instanceTerminationAction !== "STOP" || vm.scheduling?.automaticRestart !== false
    || Number(vm.scheduling?.maxRunDuration?.seconds) !== config.maxRunSeconds) throw new Error("Provider STOP/no-restart limit readback failed");
}

function requireStagingReadiness(config, now) {
  const ready = config.stagingReadiness;
  const age = now().getTime() - Date.parse(ready?.verifiedAt);
  const health = new URL(config.approvedHealthUrl);
  if (ready?.httpsReady !== true || ready?.vercelReady !== true || ready.vercelEnvironment !== "preview"
    || typeof config.approvedVercelProjectId !== "string" || !/^prj_[a-zA-Z0-9]+$/.test(config.approvedVercelProjectId)
    || ready.vercelProjectId !== config.approvedVercelProjectId || ready.healthUrl !== config.approvedHealthUrl
    || config.healthUrl !== config.approvedHealthUrl || health.protocol !== "https:" || health.username || health.password
    || health.pathname !== "/health" || health.search || health.hash
    || !Number.isFinite(age) || age < 0 || age > 86400000) throw new Error("Fresh approved staging HTTPS and exact Vercel Preview readiness required before VM start");
}

// Cleanup deliberately needs only the immutable identity: expired cost approval or
// guard drift must not prevent stopping an experiment that we already launched.
export async function stopStandby({ config, run, authorised = false }) {
  validateStandbyConfig(config);
  if (authorised !== true) throw new Error("Explicit staging stop authorisation required");
  await authenticated(config, run);
  const vm = validateIdentity(config, await describe(config, run));
  if (vm.status !== "TERMINATED") {
    await run(["compute", "instances", "stop", config.instance, ...flags(config)]);
    const after = validateIdentity(config, await describe(config, run));
    if (after.status !== "TERMINATED") throw new Error("VM stop not confirmed");
  }
  return { name: config.instance, status: "TERMINATED", bootDiskRetained: true };
}

export async function startStandby({ config, run, authorised = false, now = () => new Date(), allowTemporaryIpv4 = false }) {
  validateStandbyConfig(config);
  if (authorised !== true) throw new Error("Explicit synthetic staging start authorisation required");
  requireStagingReadiness(config, now);
  const age = now().getTime() - Date.parse(config.costEvidence?.verifiedAt);
  if (config.costEvidence?.freeTierAvailable !== true || config.costEvidence?.budgetsVerified !== true
    || !Number.isFinite(age) || age < 0 || age > 86400000) throw new Error("Fresh cost and aggregate free-tier eligibility evidence required; budgets are not hard caps");
  const options = { config, run, now, allowTemporaryIpv4, remainingSeconds: config.maxRunSeconds };
  const before = await inspectStandby(options);
  if (before.status !== "TERMINATED") throw new Error("VM must already be stopped; never extend a running experiment");
  await run(["compute", "instances", "set-scheduling", config.instance, `--max-run-duration=${config.maxRunSeconds}s`,
    "--instance-termination-action=STOP", "--no-restart-on-failure", ...flags(config)]);
  const scheduled = await inspectStandby(options);
  stopPolicy(config, scheduled);
  if (scheduled.status !== "TERMINATED") throw new Error("VM changed power state before start; do not reset or start again");
  try {
    await run(["compute", "instances", "start", config.instance, ...flags(config)]);
    const after = await inspectStandby({ config, run, now, allowTemporaryIpv4 });
    stopPolicy(config, after);
    if (after.status !== "RUNNING") throw new Error("VM start not confirmed");
    return { name: after.name, status: after.status, providerStopSeconds: config.maxRunSeconds };
  } catch {
    try { await stopStandby({ config, run, authorised: true }); }
    catch { throw new Error("Start failed and cleanup stop not confirmed; inspect the pinned VM immediately"); }
    throw new Error("Start verification failed; the pinned VM was stopped");
  }
}

// A pure procedure-order checker, never a receipt proving a real restore.
export function createRestorePlan({ mode, direction }) {
  if (!((mode === "synthetic-staging-dry-run" && direction === "staging-restore")
    || (mode === "production-procedure" && ["cutover", "rollback"].includes(direction)))) throw new Error("Explicit synthetic dry run or production procedure required");
  return { mode, direction, phase: "awaiting-quiescence", evidence: "operator-supplied-unverified", cloudMutations: false,
    productionStateVerified: false, sourceAuthority: mode === "synthetic-staging-dry-run" ? "synthetic-fixture"
      : direction === "rollback" ? "latest-gcp-production-state" : "latest-azure-production-state" };
}

export function advanceRestorePlan(plan, event) {
  const canonical = createRestorePlan(plan);
  if (Object.entries(canonical).some(([key, value]) => key !== "phase" && plan[key] !== value)) throw new Error("Invalid procedure identity");
  let next;
  if (plan.phase === "awaiting-quiescence" && event?.type === "quiescence-reviewed") {
    if (event.submissionsDisabled !== true || event.queued !== 0 || event.running !== 0 || event.ambiguous !== 0
      || event.sourceStopped !== true || event.destinationStopped !== true || event.profileOwners !== 0) throw new Error("Drain, reconcile and stop every writer before state work");
    next = "awaiting-archive";
  } else if (plan.phase === "awaiting-archive" && event?.type === "archive-reviewed") {
    if (event.kind !== (plan.mode === "synthetic-staging-dry-run" ? "synthetic" : "production")
      || event.completeThreeFileSet !== true || event.integrityChecked !== true || event.latestAuthoritative !== true) throw new Error("Latest authoritative complete verified state required; synthetic is not production");
    next = "awaiting-isolated-restore";
  } else if (plan.phase === "awaiting-isolated-restore" && event?.type === "isolated-restore-reviewed") {
    if (event.newDirectory !== true || event.exactBytesCompared !== true || event.mappingsJobsQuotaPolicySecurityCompared !== true
      || event.credentialsCopied !== false) throw new Error("Exclusive isolated restore, exact complete state comparison and no credential transfer required");
    next = "procedure-review-required";
  } else throw new Error("Out-of-order or unsupported operation; no publisher, production write or cutover is executable here");
  return { ...canonical, phase: next };
}

async function main() {
  const [action, configPath, ...switches] = process.argv.slice(2);
  if (!configPath || !["preflight", "start", "stop", "verify", "restore-plan"].includes(action)
    || switches.some(s => !["--authorise-staging", "--authorise-temporary-ipv4"].includes(s))) throw new Error("Explicit supported action and private configuration required");
  const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
  if (action === "restore-plan") {
    const input = config.restorePlan;
    const result = (input.events ?? []).reduce(advanceRestorePlan, createRestorePlan(input));
    console.log(JSON.stringify(result)); return;
  }
  validateStandbyConfig(config);
  const run = async args => {
    const prefix = config.gcloudScriptPath ? [config.gcloudScriptPath] : [];
    const { stdout } = await exec(config.gcloudPath ?? "gcloud", [...prefix, ...args], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  };
  const options = { config, run, authorised: switches.includes("--authorise-staging"), allowTemporaryIpv4: switches.includes("--authorise-temporary-ipv4") };
  let result;
  if (action === "start") result = await startStandby(options);
  else if (action === "stop") result = await stopStandby(options);
  else {
    const vm = await inspectStandby(options);
    if (action === "verify") {
      stopPolicy(config, vm);
      const url = new URL(config.healthUrl);
      if (vm.status !== "RUNNING" || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || url.pathname !== "/health" || url.href !== config.approvedHealthUrl) throw new Error("Exact approved staging HTTPS health endpoint required");
      const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
      const health = await response.json();
      if (!response.ok || health.status !== "ok" || health.mode !== "hsr-synthetic-worker") throw new Error("Synthetic staging HTTPS health failed");
      result = { name: vm.name, vmStatus: vm.status, httpsHealth: true, authenticatedJobsVerified: false, productionStateVerified: false };
    } else result = { name: vm.name, status: vm.status, machine: "e2-micro", disk: "pd-standard-20-30GB",
      ipv4Configured: Boolean(vm.networkInterfaces[0].accessConfigs?.length), cloudMutations: false, costIsHardCap: false };
  }
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("Standby operation failed; no cloud success is claimed. Inspect the pinned VM and ensure STOPPED when idle; never create a replacement or print private diagnostics.");
  process.exitCode = 1;
});
