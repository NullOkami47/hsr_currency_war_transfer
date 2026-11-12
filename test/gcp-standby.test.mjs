import assert from "node:assert/strict";
import test from "node:test";
import * as s from "../scripts/infrastructure/gcp-standby.mjs";
const now = new Date("2026-11-12T08:00:00Z");
const base = "https://www.googleapis.com/compute/v1/projects/hsr-currency-war-worker";
const config = {
  account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a",
  instance: "hsr-worker-standby", maxRunSeconds: 3600,
  approvedTarget: { account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a",
    instance: "hsr-worker-standby", instanceId: "123456789", diskId: "987654321" },
  costEvidence: { verifiedAt: now.toISOString(), freeTierAvailable: true, budgetsVerified: true },
  temporaryIpv4Approval: { approved: true, nonZeroCostAccepted: true, expiresAt: "2026-11-12T09:00:00Z" },
  approvedHealthUrl: "https://staging.example.invalid/health", healthUrl: "https://staging.example.invalid/health",
  approvedVercelProjectId: "prj_test",
  stagingReadiness: { verifiedAt: now.toISOString(), httpsReady: true, vercelReady: true,
    vercelEnvironment: "preview", vercelProjectId: "prj_test", healthUrl: "https://staging.example.invalid/health" },
};
const vm = {
  id: "123456789", name: config.instance, selfLink: `${base}/zones/us-central1-a/instances/${config.instance}`,
  status: "TERMINATED", machineType: `${base}/zones/us-central1-a/machineTypes/e2-micro`,
  labels: { purpose: "hsr-worker-standby", mode: "synthetic" },
  scheduling: { automaticRestart: false, instanceTerminationAction: "STOP", maxRunDuration: { seconds: "3600" } },
  networkInterfaces: [{ stackType: "IPV4_ONLY", accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
  disks: [{ boot: true, type: "PERSISTENT", autoDelete: false, diskSizeGb: "20", source: `${base}/zones/us-central1-a/disks/hsr-worker-standby` }],
};
const disk = { id: "987654321", name: "hsr-worker-standby", selfLink: vm.disks[0].source,
  type: `${base}/zones/us-central1-a/diskTypes/pd-standard`, sizeGb: "20", status: "READY" };
const approved = { allowTemporaryIpv4: true, now: () => now };
function provider({ badDisk, scheduled, after, startError, stopError, addresses = [] } = {}) {
  const calls = []; let started = false; let stopped = false; let configured = false;
  const run = async args => {
    calls.push(args);
    if (args[0] === "auth") return [{ account: config.account }];
    if (args[1] === "disks") return badDisk ?? disk;
    if (args[1] === "addresses") return addresses;
    if (args[2] === "set-scheduling") { configured = true; return {}; }
    if (args[2] === "start") { started = true; if (startError) throw startError; return {}; }
    if (args[2] === "stop") { if (stopError) throw stopError; stopped = true; return {}; }
    if (args[2] === "describe") return structuredClone(stopped ? vm : started ? (after ?? { ...vm, status: "RUNNING" }) : configured ? (scheduled ?? vm) : vm);
    throw new Error("Unexpected provider command");
  };
  return { run, calls };
}
const start = p => s.startStandby({ config, ...approved, run: p.run, authorised: true });
const mutations = p => p.calls.filter(a => ["set-scheduling", "start", "stop"].includes(a[2]));
test("exact target, immutable IDs and one-hour limit are mandatory", () => {
  assert.doesNotThrow(() => s.validateStandbyConfig(config));
  for (const patch of [{ project: "other-project" }, { account: "other@example.invalid" }, { zone: "us-west1-a" },
    { instance: "other-vm" }, { maxRunSeconds: 3601 }, { maxRunSeconds: 299 }, { approvedTarget: undefined },
    { approvedTarget: { ...config.approvedTarget, instanceId: "" } }]) assert.throws(() => s.validateStandbyConfig({ ...config, ...patch }));
});
test("IPv4 requires both explicit flag and unexpired non-zero-cost approval", () => {
  assert.throws(() => s.validateStandbyInstance(config, vm, { now: () => now }));
  assert.doesNotThrow(() => s.validateStandbyInstance(config, vm, approved));
  for (const approval of [undefined, { approved: true }, { ...config.temporaryIpv4Approval, approved: "true" },
    { ...config.temporaryIpv4Approval, expiresAt: now.toISOString() }, { ...config.temporaryIpv4Approval, nonZeroCostAccepted: false }])
    assert.throws(() => s.validateStandbyInstance({ ...config, temporaryIpv4Approval: approval }, vm, approved));
});
test("IPv6-only path remains available without paid IPv4", () => {
  const ipv6 = { ...vm, networkInterfaces: [{ stackType: "IPV4_IPV6", accessConfigs: [], ipv6AccessConfigs: [{ externalIpv6: "2600:1900::1" }] }] };
  assert.doesNotThrow(() => s.validateStandbyInstance(config, ipv6));
  assert.throws(() => s.validateStandbyInstance(config, { ...ipv6, networkInterfaces: [{ stackType: "IPV4_ONLY" }] }));
});
test("VM guard rejects replacement, production, extra disks, credentials and disk auto-delete", () => {
  for (const patch of [{ id: "222" }, { selfLink: vm.selfLink.replace(config.project, "another-project") },
    { machineType: vm.machineType.replace("e2-micro", "e2-small") }, { labels: { mode: "production" } },
    { serviceAccounts: [{ email: "default" }] }, { disks: [...vm.disks, vm.disks[0]] },
    { disks: [{ ...vm.disks[0], autoDelete: true }] }, { disks: [{ ...vm.disks[0], source: "projects/other/disks/boot" }] }])
    assert.throws(() => s.validateStandbyInstance(config, { ...vm, ...patch }, approved));
});
test("direct start verifies actual disk SKU, immutable ID and 20-30GB before mutation", async () => {
  for (const patch of [{ sizeGb: "19" }, { sizeGb: "31" }, { sizeGb: "NaN" }, { id: "replacement" },
    { type: disk.type.replace("pd-standard", "pd-balanced") }, { status: "CREATING" }]) {
    const p = provider({ badDisk: { ...disk, ...patch } }); await assert.rejects(start(p)); assert.equal(mutations(p).length, 0);
  }
});
test("missing authority, stale costs and IPv4 approval shorter than runtime prevent mutation", async () => {
  for (const patch of [{ authorised: false }, { config: { ...config, costEvidence: {} } },
    { config: { ...config, costEvidence: { ...config.costEvidence, freeTierAvailable: "true" } } },
    { config: { ...config, temporaryIpv4Approval: { ...config.temporaryIpv4Approval, expiresAt: "2026-11-12T08:59:59Z" } } }]) {
    const p = provider(); await assert.rejects(s.startStandby({ config, ...approved, run: p.run, authorised: true, ...patch }));
    assert.equal(mutations(p).length, 0);
  }
});
test("provider STOP and no-restart readback precede start; all commands pin account and project", async () => {
  const p = provider(); const result = await start(p); assert.equal(result.status, "RUNNING"); assert.equal(result.providerStopSeconds, 3600);
  const schedule = p.calls.findIndex(a => a[2] === "set-scheduling"), launch = p.calls.findIndex(a => a[2] === "start");
  assert.ok(schedule >= 0 && launch > schedule + 1);
  for (const flag of ["--max-run-duration=3600s", "--instance-termination-action=STOP", "--no-restart-on-failure"]) assert.ok(p.calls[schedule].includes(flag));
  for (const args of p.calls.filter(a => a[0] === "compute")) {
    assert.ok(args.includes(`--account=${config.account}`)); assert.ok(args.includes(`--project=${config.project}`));
  }
  assert.ok(!p.calls.some(a => ["create", "delete", "add-access-config"].includes(a[2])));
});
test("missing STOP, automatic restart or running readback never launches", async () => {
  for (const scheduled of [{ ...vm, scheduling: {} }, { ...vm, status: "RUNNING" }, { ...vm, scheduling: { ...vm.scheduling, automaticRestart: true } }]) {
    const p = provider({ scheduled }); await assert.rejects(start(p)); assert.ok(!p.calls.some(a => a[2] === "start"));
  }
});
test("ambiguous start or post-start guard drift stops the same VM once", async () => {
  for (const options of [{ startError: new Error("secret provider payload") }, { after: { ...vm, status: "RUNNING", labels: {} } }]) {
    const p = provider(options); await assert.rejects(start(p)); assert.equal(p.calls.filter(a => a[2] === "stop").length, 1); assert.equal(p.calls.at(-1)[2], "describe");
  }
});
test("cleanup refuses replacement VM and reports unconfirmed stop", async () => {
  const changed = provider({ after: { ...vm, id: "222", status: "RUNNING" } });
  await assert.rejects(start(changed), /cleanup|stop|identity/i); assert.ok(!changed.calls.some(a => a[2] === "stop"));
  const p = provider({ startError: new Error("private"), stopError: new Error("private") }); await assert.rejects(start(p), /not confirmed|cleanup/i);
});
test("stop is idempotent and remains available after cost approval expires", async () => {
  const p = provider(); const result = await s.stopStandby({ config, run: p.run, authorised: true });
  assert.equal(result.status, "TERMINATED"); assert.equal(mutations(p).length, 0);
});
test("restore planner cannot treat synthetic dry run as production rollback or launch publisher", () => {
  assert.equal(typeof s.createRestorePlan, "function");
  const plan = s.createRestorePlan({ mode: "synthetic-staging-dry-run", direction: "staging-restore" });
  assert.throws(() => s.advanceRestorePlan(plan, { type: "archive-reviewed" }));
  const quiet = s.advanceRestorePlan(plan, { type: "quiescence-reviewed", submissionsDisabled: true, queued: 0, running: 0, ambiguous: 0, sourceStopped: true, destinationStopped: true, profileOwners: 0 });
  assert.throws(() => s.advanceRestorePlan(quiet, { type: "archive-reviewed", kind: "production" }));
  const archived = s.advanceRestorePlan(quiet, { type: "archive-reviewed", kind: "synthetic", completeThreeFileSet: true, integrityChecked: true, latestAuthoritative: true });
  const final = s.advanceRestorePlan(archived, { type: "isolated-restore-reviewed", newDirectory: true, exactBytesCompared: true, mappingsJobsQuotaPolicySecurityCompared: true, credentialsCopied: false });
  assert.equal(final.phase, "procedure-review-required"); assert.equal(final.evidence, "operator-supplied-unverified"); assert.equal(final.productionStateVerified, false);
  assert.throws(() => s.advanceRestorePlan(final, { type: "start-publisher" }));
  assert.throws(() => s.createRestorePlan({ mode: "synthetic-staging-dry-run", direction: "rollback" }));
  const rollback = s.createRestorePlan({ mode: "production-procedure", direction: "rollback" });
  assert.equal(rollback.sourceAuthority, "latest-gcp-production-state"); assert.equal(rollback.cloudMutations, false);
});
test("restore planner blocks live writers, active jobs and incomplete or stale state", () => {
  const plan = s.createRestorePlan({ mode: "production-procedure", direction: "rollback" });
  const event = { type: "quiescence-reviewed", submissionsDisabled: true, queued: 0, running: 0, ambiguous: 0, sourceStopped: true, destinationStopped: true, profileOwners: 0 };
  for (const patch of [{ running: 1 }, { queued: 1 }, { ambiguous: 1 }, { profileOwners: 1 }, { sourceStopped: false }]) assert.throws(() => s.advanceRestorePlan(plan, { ...event, ...patch }));
  const quiet = s.advanceRestorePlan(plan, event);
  const archive = { type: "archive-reviewed", kind: "production", completeThreeFileSet: true, integrityChecked: true, latestAuthoritative: true };
  for (const patch of [{ kind: "synthetic" }, { completeThreeFileSet: false }, { latestAuthoritative: false }]) assert.throws(() => s.advanceRestorePlan(quiet, { ...archive, ...patch }));
});

test("static IPv4 and unauthenticated accounts fail closed before mutation", async () => {
  const p = provider({ after: { ...vm, status: "RUNNING", networkInterfaces: [{ ...vm.networkInterfaces[0], accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "192.0.2.1" }] }] }, addresses: [{ address: "192.0.2.1", status: "IN_USE" }] });
  await assert.rejects(start(p)); assert.equal(p.calls.filter(a => a[2] === "stop").length, 1);
  const q = provider();
  await assert.rejects(s.startStandby({ config, ...approved, authorised: true, run: async args => args[0] === "auth" ? [] : q.run(args) }));
  assert.equal(q.calls.length, 0);
});

test("a running VM is stopped even when labels and IPv4 approval have expired", async () => {
  const calls = []; let stopped = false;
  const run = async args => { calls.push(args); if (args[0] === "auth") return [{ account: config.account }]; if (args[2] === "stop") { stopped = true; return {}; }
    return { ...vm, labels: {}, status: stopped ? "TERMINATED" : "RUNNING" }; };
  const result = await s.stopStandby({ config: { ...config, temporaryIpv4Approval: undefined }, run, authorised: true });
  assert.equal(result.status, "TERMINATED"); assert.equal(calls.filter(a => a[2] === "stop").length, 1);
});

test("HTTPS and Vercel Preview readiness are required before even describing or starting the VM", async () => {
  for (const stagingReadiness of [undefined, { ...config.stagingReadiness, httpsReady: false },
    { ...config.stagingReadiness, vercelReady: false }, { ...config.stagingReadiness, vercelEnvironment: "production" },
    { ...config.stagingReadiness, vercelProjectId: "another-project" }]) {
    const p = provider(); await assert.rejects(s.startStandby({ config: { ...config, stagingReadiness }, ...approved, run: p.run, authorised: true }));
    assert.equal(p.calls.length, 0);
  }
});
