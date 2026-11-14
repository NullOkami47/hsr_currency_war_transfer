import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compareStateFiles, auditStateDirectories } from "../scripts/infrastructure/cutover-state-audit.mjs";

const sourceId = "6a56fe3021253d0e1a9f4761";
const globalId = "6b56fe3021253d0e1a9f4762";
const sessionId = "s".repeat(32);
const names = { transfers: "transfers.json", jobs: "jobs.json", security: "jobs.json.security.json" };
const sha = value => createHash("sha256").update(value).digest("hex");
function state() {
  return {
    transfers: { version: 1, transfers: { [sourceId]: { globalId, sourceHash: "f".repeat(64), shareCode: "PRIVATE-CODE", updatedAt: "2026-11-13T00:00:00.000Z" } } },
    jobs: { version: 4, settings: { publicSubmissionsEnabled: false, sourceBlacklistEnabled: true, sourceBlacklist: [sourceId], perIpLimit: 5, perIpWindowMinutes: 60, dailyAccountQuota: 25, maxPendingJobs: 20, retentionDays: 30, maxStoredJobs: 1000 }, jobs: {
      "job-1": { id: "job-1", sourceId, status: "completed", result: { status: "created", sourceId, globalId, nested: { id: "PRIVATE-NESTED-ID" }, shareCode: "PRIVATE-CODE" } },
      "job-2": { id: "job-2", sourceId, status: "failed", result: null, error: { code: "expired_source", message: "PRIVATE-ERROR" } },
    }, quota: { events: [{ at: 1794528000000, clientKey: "PRIVATE-CLIENT-HASH" }, { at: 1794528000001, clientKey: "PRIVATE-CLIENT-HASH" }], blockedUntil: 1794614400000 } },
    security: { version: 1, requests: { submit: { count: 2, resetAt: 1794528060000, clients: { "PRIVATE-CLIENT-HASH": 2 } } }, sessions: { [sessionId]: 1794531600000 } },
  };
}
const bytes = s => Object.fromEntries(Object.entries(s).map(([role, value]) => [role, Buffer.from(JSON.stringify(value) + "\n")]));
const compare = (a, b = a) => compareStateFiles(bytes(a), bytes(b));

test("exact raw three-file match is unverified local evidence, never runtime GO", () => {
  const s = state(), report = compare(s);
  assert.equal(report.classification, "LOCAL_STATE_MATCH_UNATTESTED");
  assert.equal(report.runtimeGo, false);
  assert.equal(report.authoritativeSourceVerified, false);
  assert.deepEqual(report.differences, []);
  assert.equal(report.source.files.transfers.sha256, sha(bytes(s).transfers));
  assert.equal(report.source.counts.mappings, 1);
  assert.equal(report.source.counts.jobs.completed, 1);
  assert.equal(report.source.counts.jobs.failed, 1);
  assert.equal(report.source.counts.quotaEvents, 2);
  assert.equal(report.source.counts.quotaClientKeys, 1);
  for (const secret of [sourceId, globalId, sessionId, "PRIVATE-CODE", "PRIVATE-NESTED-ID", "PRIVATE-CLIENT-HASH", "PRIVATE-ERROR"]) assert.ok(!JSON.stringify(report).includes(secret));
});

test("same counts cannot conceal lost mappings or changed nested result IDs", () => {
  const a = state(), b = structuredClone(a);
  b.jobs.jobs["job-1"].result.nested.id = "DIFFERENT";
  b.transfers.transfers[sourceId].globalId = "6c56fe3021253d0e1a9f4763";
  const r = compare(a, b);
  assert.equal(r.classification, "LOCAL_STATE_DIFFERENCES");
  assert.ok(r.differences.includes("transfers.records"));
  assert.ok(r.differences.includes("jobs.records"));
});

test("quota blockedUntil, event times, client identity and event multiplicity are preserved", () => {
  for (const mutate of [s => s.jobs.quota.blockedUntil = 0, s => s.jobs.quota.events[0].at++, s => s.jobs.quota.events[0].clientKey = "other", s => s.jobs.quota.events.pop()]) {
    const a = state(), b = structuredClone(a); mutate(b);
    assert.ok(compare(a, b).differences.includes("jobs.quota"));
  }
});

test("policy, request limits and revoked session absence cannot be replaced by older state", () => {
  for (const [code, mutate] of [
    ["jobs.settings", s => s.jobs.settings.dailyAccountQuota++],
    ["security.requests", s => s.security.requests.submit.clients["PRIVATE-CLIENT-HASH"]--],
    ["security.sessions", s => s.security.sessions["r".repeat(32)] = 1794531600000],
    ["security.sessions", s => delete s.security.sessions[sessionId]],
    ["security.other", s => s.security.futureRevocations = ["private-revoked-id"]],
  ]) {
    const a = state(), b = structuredClone(a); mutate(b);
    assert.ok(compare(a, b).differences.includes(code));
  }
});

test("pending publication ID is compared intact but blocks readiness even when identical", () => {
  const a = state(); a.transfers.transfers[sourceId].verificationPending = true;
  const b = structuredClone(a); b.transfers.transfers[sourceId].globalId = "6c56fe3021253d0e1a9f4763";
  assert.equal(compare(a).classification, "LOCAL_STATE_BLOCKED");
  assert.equal(compare(a).source.counts.pendingMappings, 1);
  assert.ok(compare(a, b).differences.includes("transfers.records"));
});

test("queued, running, ambiguous and unknown jobs block on either side, not normalised away", () => {
  for (const status of ["queued", "running", "ambiguous", "unknown"]) {
    const a = state(), b = structuredClone(a); b.jobs.jobs["job-1"].status = status;
    for (const r of [compare(a, b), compare(b, a), compare(b)]) {
      assert.equal(r.classification, "LOCAL_STATE_BLOCKED");
      assert.equal(r.runtimeGo, false);
    }
  }
  const s = state(); s.jobs.settings.publicSubmissionsEnabled = true;
  assert.equal(compare(s).classification, "LOCAL_STATE_BLOCKED");
});

test("completed label cannot conceal an ambiguous publication result", () => {
  const s = state(); s.jobs.jobs["job-1"].result.status = "ambiguous";
  assert.equal(compare(s).classification, "LOCAL_STATE_BLOCKED");
});

test("empty synthetic pair and empty candidate cannot constitute production migration evidence", () => {
  const empty = state(); empty.transfers.transfers = {}; empty.jobs.jobs = {};
  empty.jobs.quota = { events: [], blockedUntil: 0 }; empty.security = { version: 1, requests: {}, sessions: {} };
  assert.equal(compare(empty).classification, "LOCAL_STATE_BLOCKED");
  assert.equal(compare(state(), empty).classification, "LOCAL_STATE_BLOCKED");
});

test("missing files, unsupported versions, malformed state and duplicate JSON keys fail closed", () => {
  const valid = bytes(state());
  for (const role of Object.keys(names)) {
    const missing = { ...valid }; delete missing[role];
    assert.equal(compareStateFiles(valid, missing).classification, "LOCAL_INPUT_REJECTED");
    const bad = { ...valid, [role]: Buffer.from('{"PRIVATE-SYNTAX-ERROR":') };
    const report = compareStateFiles(valid, bad);
    assert.equal(report.classification, "LOCAL_INPUT_REJECTED");
    assert.ok(!JSON.stringify(report).includes("PRIVATE-SYNTAX-ERROR"));
  }
  for (const mutate of [s => s.jobs.version = 3, s => delete s.jobs.quota, s => s.jobs.quota.events[0].at = null, s => s.jobs.jobs["job-1"].id = "mismatch", s => s.jobs.jobs["job-1"].result = null, s => s.jobs.jobs["job-1"].result.sourceId = globalId, s => s.jobs.jobs["job-1"].result.globalId = {}, s => s.transfers.transfers[sourceId] = null, s => s.security.sessions[sessionId] = "bad", s => s.security.requests.submit.clients = []]) {
    const s = state(); mutate(s);
    assert.equal(compare(s).classification, "LOCAL_INPUT_REJECTED");
  }
  const duplicate = { ...valid, security: Buffer.from('{"version":1,"requests":{},"sessions":{},"sessions":{}}') };
  assert.equal(compareStateFiles(valid, duplicate).classification, "LOCAL_INPUT_REJECTED");
  const escapedDuplicate = { ...valid, security: Buffer.from('{"version":1,"requests":{},"sessions":{},"\\u0073essions":{}}') };
  assert.equal(compareStateFiles(valid, escapedDuplicate).classification, "LOCAL_INPUT_REJECTED");
});

test("byte changes and unknown fields are not silently canonicalised or ignored", () => {
  const a = state(), source = bytes(a), candidate = bytes(a);
  candidate.transfers = Buffer.from(JSON.stringify(a.transfers, null, 2));
  assert.deepEqual(compareStateFiles(source, candidate).differences, ["transfers.bytes"]);
  a.jobs.futureLedger = { nested: { id: "private" } };
  assert.ok(compare(state(), a).differences.includes("jobs.other"));
});

test("bounded input and nesting guard rejects oversized, deep or invalid UTF-8 JSON", () => {
  const valid = bytes(state());
  for (const invalid of [Buffer.alloc(8 * 1024 * 1024 + 1, 32), Buffer.from("[".repeat(100) + "0" + "]".repeat(100)), Buffer.from([0x22, 0xff, 0x22])]) {
    assert.equal(compareStateFiles(valid, { ...valid, security: invalid }).classification, "LOCAL_INPUT_REJECTED");
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "hsr-state-audit-"));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), "hsr-state-audit-"))); await fs.rm(root, { recursive: true, force: true }); });
  const sourceDirectory = join(root, "source"), candidateDirectory = join(root, "candidate");
  for (const dir of [sourceDirectory, candidateDirectory]) {
    await fs.mkdir(dir, { mode: 0o700 });
    for (const [role, content] of Object.entries(bytes(state()))) await fs.writeFile(join(dir, names[role]), content, { mode: 0o600 });
    await fs.writeFile(join(dir, ".env"), "SECRET-NEVER-READ", { mode: 0o600 });
  }
  return { root, sourceDirectory, candidateDirectory };
}
const posix = { skip: process.platform === "win32" ? "POSIX ownership/mode required; run full filesystem tests on D-backed WSL ext4" : false };

test("directory comparison opens only allowlisted files, stays read-only and reproducible", posix, async t => {
  const f = await fixture(t), opened = [], originalOpen = fs.open;
  t.mock.method(fs, "open", async (path, ...args) => { opened.push(path); return originalOpen(path, ...args); });
  const path = join(f.sourceDirectory, names.transfers), before = await fs.stat(path, { bigint: true });
  const a = await auditStateDirectories(f), b = await auditStateDirectories(f);
  assert.equal(a.classification, "LOCAL_STATE_MATCH_UNATTESTED");
  assert.deepEqual(a, b);
  assert.deepEqual(await fs.stat(path, { bigint: true }).then(s => [s.mtimeNs, s.ctimeNs, s.mode, s.uid]), [before.mtimeNs, before.ctimeNs, before.mode, before.uid]);
  assert.ok(opened.every(path => Object.values(names).some(name => path.endsWith("/" + name))));
});

test("canonical private directories, lock absence, mode, owner and all three files are mandatory", posix, async t => {
  const f = await fixture(t);
  for (const overrides of [{ sourceDirectory: "relative" }, { sourceDirectory: f.sourceDirectory + "/../source" }, { candidateDirectory: f.sourceDirectory }]) assert.equal((await auditStateDirectories({ ...f, ...overrides })).classification, "LOCAL_INPUT_REJECTED");
  const target = join(f.candidateDirectory, names.security);
  await fs.chmod(target, 0o644);
  assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
  await fs.chmod(target, 0o600);
  await fs.chmod(f.candidateDirectory, 0o755);
  assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
  await fs.chmod(f.candidateDirectory, 0o700);
  await fs.writeFile(join(f.sourceDirectory, "transfers.json.lock"), "lock", { mode: 0o600 });
  assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
  await fs.unlink(join(f.sourceDirectory, "transfers.json.lock"));
  if (process.getuid() === 0) {
    await fs.chown(target, 65534, 65534);
    assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
    await fs.chown(target, 0, 0);
  }
  await fs.unlink(target);
  assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
});

test("file, directory and ancestor symlinks, hardlinks and oversized files are rejected", posix, async t => {
  const f = await fixture(t), target = join(f.candidateDirectory, names.security);
  await fs.unlink(target); await fs.symlink(join(f.sourceDirectory, names.security), target);
  assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
  await fs.unlink(target); await fs.link(join(f.sourceDirectory, names.security), target);
  assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
  await fs.unlink(target); await fs.writeFile(target, Buffer.alloc(8 * 1024 * 1024 + 1), { mode: 0o600 });
  assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED");
  const alias = join(f.root, "alias"); await fs.symlink(f.sourceDirectory, alias);
  assert.equal((await auditStateDirectories({ ...f, sourceDirectory: alias })).classification, "LOCAL_INPUT_REJECTED");
  const ancestor = join(f.root, "ancestor"); await fs.symlink(f.root, ancestor);
  assert.equal((await auditStateDirectories({ ...f, sourceDirectory: join(ancestor, "source") })).classification, "LOCAL_INPUT_REJECTED");
});

test("in-place drift, atomic file replacement and directory replacement during the read fail closed", posix, async t => {
  for (const mutation of ["write", "replace", "directory"]) {
    const f = await fixture(t), originalOpen = fs.open;
    let triggered = false;
    const mocked = t.mock.method(fs, "open", async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (!triggered && path === join(f.candidateDirectory, names.security)) {
        triggered = true;
        const target = join(f.sourceDirectory, names.transfers);
        if (mutation === "write") await fs.writeFile(target, bytes(state()).transfers);
        if (mutation === "replace") { const tmp = target + ".new"; await fs.writeFile(tmp, bytes(state()).transfers, { mode: 0o600 }); await fs.rename(tmp, target); }
        if (mutation === "directory") { await fs.rename(f.sourceDirectory, f.sourceDirectory + ".old"); await fs.mkdir(f.sourceDirectory, { mode: 0o700 }); }
      }
      return handle;
    });
    assert.equal((await auditStateDirectories(f)).classification, "LOCAL_INPUT_REJECTED", mutation);
    assert.equal(triggered, true);
    mocked.mock.restore();
  }
});

test("CLI has only two local directories, sanitises errors, and uses nonzero on rejection/differences", async t => {
  const script = resolve("scripts/infrastructure/cutover-state-audit.mjs");
  const invalid = spawnSync(process.execPath, [script, "--restore", "PRIVATE-PATH"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, "");
  assert.equal(JSON.parse(invalid.stdout).classification, "LOCAL_INPUT_REJECTED");
  assert.ok(!invalid.stdout.includes("PRIVATE-PATH"));
  if (process.platform === "win32") {
    const r = await auditStateDirectories({ sourceDirectory: "D:/private/source", candidateDirectory: "D:/private/candidate" });
    assert.equal(r.classification, "LOCAL_INPUT_REJECTED");
    return;
  }
  const f = await fixture(t);
  const run = () => spawnSync(process.execPath, [script, f.sourceDirectory, f.candidateDirectory], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const changed = state(); changed.jobs.quota.blockedUntil = 0;
  await fs.writeFile(join(f.candidateDirectory, names.jobs), bytes(changed).jobs);
  const diff = run(); assert.equal(diff.status, 1);
  assert.equal(JSON.parse(diff.stdout).classification, "LOCAL_STATE_DIFFERENCES");
  assert.ok(!diff.stdout.includes(f.root));
  await fs.writeFile(join(f.candidateDirectory, names.security), '{"PRIVATE-CORRUPTION":');
  const corrupt = run();
  assert.equal(corrupt.status, 1);
  assert.equal(corrupt.stderr, "");
  assert.equal(JSON.parse(corrupt.stdout).classification, "LOCAL_INPUT_REJECTED");
  assert.ok(!corrupt.stdout.includes("PRIVATE-CORRUPTION"));
});
