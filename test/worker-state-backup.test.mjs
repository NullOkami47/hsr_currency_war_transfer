import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createStateBackup, verifyStateBackup, restoreStateBackup, pruneBackups } from "../scripts/infrastructure/worker-state-backup.mjs";

const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const at = "2026-11-12T01:00:00.000Z";
const sourceId = "6a56fe3021253d0e1a9f4761";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hsr-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { transfers: join(root, "custom-map.json"), jobs: join(root, "custom-jobs.json") };
  paths.security = paths.jobs + ".security.json";
  const state = {
    transfers: { version: 1, transfers: { [sourceId]: { shareCode: "synthetic-global-code", status: "created" } } },
    jobs: { version: 4, settings: { publicSubmissionsEnabled: false, dailyAccountQuota: 25, sourceBlacklist: [sourceId] }, jobs: { syntheticJob: { id: "syntheticJob", sourceId, status: "completed", result: { shareCode: "synthetic-global-code" } } }, quota: { events: [{ at: Date.parse(at), clientKey: "synthetic-client" }], blockedUntil: Date.parse(at) + 3600000 } },
    security: { version: 1, requests: { submit: { count: 2, resetAt: Date.parse(at) + 60000, clients: { synthetic: 2 } } }, sessions: { syntheticSession: Date.parse(at) + 60000 } },
  };
  for (const name of Object.keys(paths)) await writeFile(paths[name], JSON.stringify(state[name]) + "\n");
  await writeFile(join(root, ".env"), "SECRET=must-never-enter-archive");
  await mkdir(join(root, "browser-profile"));
  await writeFile(join(root, "browser-profile", "Cookies"), "never-copy-cookie");
  return { root, paths, state };
}

async function archive(f, extra = {}) {
  return createStateBackup({ paths: f.paths, publicKey, assertQuiescent: async () => {}, now: () => new Date(at), ...extra });
}

test("backup round trip preserves all three exact configured files and restores quotas, mappings, policy and security", async t => {
  const f = await fixture(t);
  const backup = await archive(f);
  assert.equal(backup.receipt.createdAt, at);
  assert.match(backup.receipt.sha256, /^[a-f0-9]{64}$/);
  for (const secret of ["synthetic-global-code", "syntheticSession", "must-never-enter-archive", "never-copy-cookie"]) assert.ok(!backup.encrypted.toString().includes(secret));
  const verified = verifyStateBackup(backup.encrypted, privateKey, backup.receipt);
  assert.deepEqual(Object.keys(verified.files).sort(), ["jobs", "security", "transfers"]);
  assert.equal(verified.manifest.paths.jobs, f.paths.jobs);
  const destination = join(f.root, "restored");
  await restoreStateBackup({ encrypted: backup.encrypted, privateKey, receipt: backup.receipt, directory: destination, assertQuiescent: async () => {} });
  for (const role of ["transfers", "jobs", "security"]) {
    const name = { transfers: "transfers.json", jobs: "jobs.json", security: "jobs.json.security.json" }[role];
    assert.deepEqual(await readFile(join(destination, name)), await readFile(f.paths[role]));
  }
});

test("snapshot checks service quiescence before and after reading and refuses active or ambiguous jobs", async t => {
  const f = await fixture(t);
  let checks = 0;
  await archive(f, { assertQuiescent: async () => { checks++; } });
  assert.equal(checks, 2);
  await assert.rejects(archive(f, { assertQuiescent: async () => { throw new Error("worker active"); } }), /worker active/);
  await assert.rejects(archive(f, { assertQuiescent: undefined }), /quiescence/i);
  for (const status of ["queued", "running"]) {
    f.state.jobs.jobs.syntheticJob.status = status;
    await writeFile(f.paths.jobs, JSON.stringify(f.state.jobs));
    await assert.rejects(archive(f), /drain|ambiguous/i);
  }
});

test("missing security state, repeated paths and transfer locks fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(archive(f, { paths: { ...f.paths, security: f.paths.jobs } }), /distinct|companion/i);
  await writeFile(f.paths.transfers + ".lock", "synthetic-lock");
  await assert.rejects(archive(f), /lock/i);
  await rm(f.paths.transfers + ".lock");
  await rm(f.paths.security);
  await assert.rejects(archive(f), /ENOENT|missing/i);
});

test("tampering, wrong keys and receipt hash mismatches never create restore files", async t => {
  const f = await fixture(t);
  const backup = await archive(f);
  const value = JSON.parse(backup.encrypted);
  value.ciphertext = "A" + value.ciphertext.slice(1);
  const tampered = Buffer.from(JSON.stringify(value));
  assert.throws(() => verifyStateBackup(tampered, privateKey, backup.receipt), /checksum/i);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => verifyStateBackup(backup.encrypted, other.privateKey, backup.receipt));
  const directory = join(f.root, "bad-restore");
  await assert.rejects(restoreStateBackup({ encrypted: tampered, privateKey, receipt: backup.receipt, directory, assertQuiescent: async () => {} }));
  await assert.rejects(readFile(join(directory, "jobs.json")), /ENOENT/);
});

test("restore refuses any existing destination and refuses absent quiescence proof", async t => {
  const f = await fixture(t);
  const backup = await archive(f);
  const directory = join(f.root, "existing");
  await mkdir(directory);
  await writeFile(join(directory, "sentinel"), "keep");
  await assert.rejects(restoreStateBackup({ ...backup, privateKey, directory, assertQuiescent: async () => {} }), /exist/i);
  assert.equal(await readFile(join(directory, "sentinel"), "utf8"), "keep");
  await assert.rejects(restoreStateBackup({ ...backup, privateKey, directory: join(f.root, "missing-proof") }), /quiescence/i);
});

test("seven-day retention removes only verified expired backup pairs after a newer successful verification", async t => {
  const f = await fixture(t);
  const backups = join(f.root, "backups");
  await mkdir(backups);
  for (const [name, date] of [["old", "2026-11-01T01:00:00.000Z"], ["fresh", at]]) {
    const backup = await archive(f, { now: () => new Date(date) });
    await writeFile(join(backups, `hsr-state-${name}.enc.json`), backup.encrypted);
    await writeFile(join(backups, `hsr-state-${name}.receipt.json`), JSON.stringify(backup.receipt));
  }
  await writeFile(join(backups, "private-key.pem"), "never-prune");
  await writeFile(join(backups, "hsr-state-unverified.enc.json"), "keep");
  const removed = await pruneBackups({ directory: backups, privateKey, now: () => new Date(at) });
  assert.deepEqual(removed, ["hsr-state-old.enc.json"]);
  assert.equal(await readFile(join(backups, "private-key.pem"), "utf8"), "never-prune");
  assert.equal(await readFile(join(backups, "hsr-state-unverified.enc.json"), "utf8"), "keep");
  assert.ok(await readFile(join(backups, "hsr-state-fresh.enc.json")));
});

test("POSIX source symlinks are rejected rather than reading an unintended file", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  const target = f.paths.transfers + ".real";
  await writeFile(target, await readFile(f.paths.transfers));
  await rm(f.paths.transfers);
  await symlink(target, f.paths.transfers);
  await assert.rejects(archive(f), /symbolic|symlink|ELOOP/i);
});

test("GCM rejects altered ciphertext even with a matching outer receipt and supports encrypted private-key custody", async t => {
  const f=await fixture(t);
  const backup=await archive(f);
  const { createHash }=await import("node:crypto");
  const envelope=JSON.parse(backup.encrypted);
  const content=Buffer.from(envelope.ciphertext,"base64");content[content.length-1]^=1;envelope.ciphertext=content.toString("base64");
  const bytes=Buffer.from(JSON.stringify(envelope));
  const receipt={...backup.receipt,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  assert.throws(()=>verifyStateBackup(bytes,privateKey,receipt));
  const protectedKey=keys.privateKey.export({type:"pkcs8",format:"pem",cipher:"aes-256-cbc",passphrase:"synthetic-test-only"});
  assert.equal(verifyStateBackup(backup.encrypted,{key:protectedKey,passphrase:"synthetic-test-only"},backup.receipt).manifest.createdAt,at);
  assert.throws(()=>verifyStateBackup(backup.encrypted,{key:protectedKey,passphrase:"incorrect"},backup.receipt));
});

test("retention never removes the last successful archive when no recent verified backup exists",async t=>{
  const f=await fixture(t);const backups=join(f.root,"only-old");await mkdir(backups);
  const backup=await archive(f,{now:()=>new Date("2026-10-01T01:00:00.000Z")});
  await writeFile(join(backups,"hsr-state-last.enc.json"),backup.encrypted);
  await writeFile(join(backups,"hsr-state-last.receipt.json"),JSON.stringify(backup.receipt));
  assert.deepEqual(await pruneBackups({directory:backups,privateKey,now:()=>new Date(at)}),[]);
  assert.ok(await readFile(join(backups,"hsr-state-last.enc.json")));
});

test("encrypted maintenance metadata retains the pre-pause submission policy without reopening it on restore",async t=>{
  const f=await fixture(t);const backup=await archive(f,{maintenance:{publicSubmissionsEnabledBeforePause:true}});
  const decoded=verifyStateBackup(backup.encrypted,privateKey,backup.receipt);
  assert.equal(decoded.manifest.maintenance.publicSubmissionsEnabledBeforePause,true);
  assert.equal(JSON.parse(decoded.files.jobs).settings.publicSubmissionsEnabled,false);
});
