import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Intentionally no store, backup, browser, subprocess, network or provider imports:
// the real stores may chmod, migrate, prune or initialise missing state on reads.
const NAMES = Object.freeze({ transfers: "transfers.json", jobs: "jobs.json", security: "jobs.json.security.json" });
const ROLES = Object.keys(NAMES);
const MAX_FILE = 8 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const finite = x => typeof x === "number" && Number.isFinite(x) && x >= 0;
const text = x => typeof x === "string" && x.length > 0;
const id = x => typeof x === "string" && /^[a-f0-9]{24}$/i.test(x);
class InputRejected extends Error {}
function requireInput(condition) { if (!condition) throw new InputRejected(); }
function rejected() {
  return { classification: "LOCAL_INPUT_REJECTED", runtimeGo: false, authoritativeSourceVerified: false, differences: ["input.invalid_unsafe_or_drifting"] };
}

function decode(bytes) {
  requireInput(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_FILE);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(raw);
  // JSON.parse alone silently accepts duplicate IDs/keys. Scan structural tokens
  // after syntax validation, including escaped key aliases; never echo a token.
  const tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]/g) ?? [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      requireInput(stack.length <= 64);
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(token), keys = stack.at(-1);
      requireInput(keys instanceof Set && !keys.has(key));
      keys.add(key);
    }
  }
  requireInput(tokens.length <= 500_000 && object(value));
  return value;
}

function validate(state) {
  const { transfers: t, jobs: j, security: s } = state;
  requireInput(t.version === 1 && object(t.transfers));
  for (const [source, record] of Object.entries(t.transfers)) {
    requireInput(id(source) && object(record) && id(record.globalId)
      && (record.verificationPending === undefined || typeof record.verificationPending === "boolean")
      && (record.sourceHash === null || typeof record.sourceHash === "string")
      && (record.shareCode === null || typeof record.shareCode === "string"));
  }
  requireInput(j.version === 4 && object(j.jobs) && object(j.settings)
    && object(j.quota) && Array.isArray(j.quota.events) && finite(j.quota.blockedUntil));
  // Match current worker policy ranges without calling its normalising/pruning API.
  const p = j.settings;
  requireInput(typeof p.publicSubmissionsEnabled === "boolean" && typeof p.sourceBlacklistEnabled === "boolean"
    && Array.isArray(p.sourceBlacklist) && p.sourceBlacklist.length <= 500 && p.sourceBlacklist.every(id));
  for (const [key, min, max] of [["perIpLimit", 1, 1000], ["perIpWindowMinutes", 1, 1440], ["dailyAccountQuota", 1, 10000], ["maxPendingJobs", 1, 1000], ["retentionDays", 1, 365], ["maxStoredJobs", 5, 10000]]) {
    requireInput(Number.isInteger(p[key]) && p[key] >= min && p[key] <= max);
  }
  for (const [key, job] of Object.entries(j.jobs)) {
    requireInput(object(job) && text(key) && key === job.id && id(job.sourceId) && text(job.status));
    if (job.result !== null && job.result !== undefined) requireInput(object(job.result));
    if (job.status === "completed") requireInput(object(job.result) && text(job.result.status));
    if (job.result?.sourceId !== undefined) requireInput(job.result.sourceId === job.sourceId);
    if (job.result?.globalId !== undefined) requireInput(id(job.result.globalId));
  }
  for (const event of j.quota.events) requireInput(object(event) && finite(event.at) && typeof event.clientKey === "string");
  requireInput(s.version === 1 && object(s.requests) && object(s.sessions));
  for (const [kind, bucket] of Object.entries(s.requests)) {
    requireInput(["roles", "submit", "poll"].includes(kind) && object(bucket)
      && Number.isInteger(bucket.count) && bucket.count >= 0 && finite(bucket.resetAt)
      && object(bucket.clients) && Object.keys(bucket.clients).length <= 5000
      && Object.values(bucket.clients).every(n => Number.isInteger(n) && n >= 1));
  }
  for (const [key, expiry] of Object.entries(s.sessions)) requireInput(/^[A-Za-z0-9_-]{32,100}$/.test(key) && finite(expiry));
}

function describe(files) {
  requireInput(object(files) && Object.keys(files).sort().join() === [...ROLES].sort().join());
  const state = Object.fromEntries(ROLES.map(role => [role, decode(files[role])]));
  validate(state);
  const jobs = Object.values(state.jobs.jobs);
  const counts = {
    mappings: Object.keys(state.transfers.transfers).length,
    pendingMappings: Object.values(state.transfers.transfers).filter(x => x.verificationPending === true).length,
    jobs: Object.fromEntries(["queued", "running", "completed", "failed", "other"].map(status => [status, jobs.filter(j => status === "other" ? !["queued", "running", "completed", "failed"].includes(j.status) : j.status === status).length])),
    quotaEvents: state.jobs.quota.events.length,
    quotaClientKeys: new Set(state.jobs.quota.events.map(e => e.clientKey)).size,
    requestBuckets: Object.keys(state.security.requests).length,
    requestClients: Object.values(state.security.requests).reduce((n, b) => n + Object.keys(b.clients).length, 0),
    sessions: Object.keys(state.security.sessions).length,
  };
  const blockers = [];
  if (counts.mappings === 0 && jobs.length === 0) blockers.push("empty_or_synthetic_unproven");
  if (counts.pendingMappings) blockers.push("pending_publication_reconciliation");
  if (counts.jobs.queued || counts.jobs.running || counts.jobs.other
    || jobs.some(job => job.status === "completed" && !["created", "updated", "unchanged"].includes(job.result.status))) blockers.push("active_or_ambiguous_jobs");
  if (state.jobs.settings.publicSubmissionsEnabled) blockers.push("admission_not_paused");
  return { state, blockers, summary: {
    schema: { transfers: 1, jobs: 4, security: 1 },
    files: Object.fromEntries(ROLES.map(role => [role, { sha256: hash(files[role]), bytes: files[role].length }])),
    counts,
  } };
}

// Pure byte comparison is separately testable; it provides no filesystem,
// privacy, quiescence, identity or authoritative-source attestation.
export function compareStateFiles(sourceFiles, candidateFiles) {
  try {
    const source = describe(sourceFiles), candidate = describe(candidateFiles), differences = [];
    const fields = { transfers: ["transfers"], jobs: ["jobs", "settings", "quota"], security: ["requests", "sessions"] };
    const labels = { transfers: "records", jobs: "records" };
    for (const role of ROLES) {
      if (source.summary.files[role].sha256 !== candidate.summary.files[role].sha256) differences.push(role + ".bytes");
      for (const key of fields[role]) if (!isDeepStrictEqual(source.state[role][key], candidate.state[role][key])) differences.push(role + "." + (labels[key] ?? key));
      const other = value => Object.fromEntries(Object.entries(value).filter(([key]) => !fields[role].includes(key)));
      if (!isDeepStrictEqual(other(source.state[role]), other(candidate.state[role]))) differences.push(role + ".other");
    }
    const blockers = [...source.blockers.map(code => "source." + code), ...candidate.blockers.map(code => "candidate." + code)];
    return { classification: blockers.length ? "LOCAL_STATE_BLOCKED" : differences.length ? "LOCAL_STATE_DIFFERENCES" : "LOCAL_STATE_MATCH_UNATTESTED",
      runtimeGo: false, authoritativeSourceVerified: false, source: source.summary, candidate: candidate.summary, differences, blockers };
  } catch { return rejected(); }
}

const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
function privateStat(stat, directory) {
  requireInput(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o7777n) === (directory ? 0o700n : 0o600n));
  if (!directory) requireInput(stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(MAX_FILE));
}

async function directoryChain(directory) {
  requireInput(typeof directory === "string" && isAbsolute(directory) && resolve(directory) === directory
    && directory.length <= 4096 && await fs.realpath(directory) === directory);
  const root = parse(directory).root, parts = directory.slice(root.length).split(sep).filter(Boolean);
  requireInput(parts.length > 0 && parts.length <= 64);
  const stamps = [];
  let path = root;
  for (const part of [null, ...parts]) {
    if (part !== null) path = join(path, part);
    const stat = await fs.lstat(path, { bigint: true });
    requireInput(stat.isDirectory() && !stat.isSymbolicLink());
    if (path === directory) privateStat(stat, true);
    else {
      // Root-owned sticky /tmp is safe for an owner-private leaf. Other writable
      // parents are not trusted, even if today's realpath happens to match.
      requireInput(stat.uid === 0n || stat.uid === BigInt(process.getuid()));
      requireInput((stat.mode & 0o022n) === 0n || (stat.uid === 0n && (stat.mode & 0o1000n) !== 0n));
    }
    // Parent mtime changes from unrelated directories do not invalidate evidence;
    // replacement/permissions/owner changes do. Leaf metadata is checked in full.
    stamps.push(path === directory ? stamp(stat) : [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(":"));
  }
  return stamps.join("/");
}

async function noTransferLock(directory) {
  try { await fs.lstat(join(directory, "transfers.json.lock")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new InputRejected();
}

async function readBounded(path) {
  const before = await fs.lstat(path, { bigint: true });
  privateStat(before, false);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    privateStat(opened, false);
    requireInput(stamp(before) === stamp(opened));
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      requireInput(offset === Number(before.size) && stamp(before) === stamp(await handle.stat({ bigint: true }))
        && stamp(before) === stamp(await fs.lstat(path, { bigint: true })));
      return { bytes: Buffer.from(buffer.subarray(0, offset)), stamp: stamp(before) };
    } finally { buffer.fill(0); }
  } finally { await handle.close(); }
}

export async function auditStateDirectories({ sourceDirectory, candidateDirectory } = {}) {
  const first = [], second = [];
  try {
    // NTFS mode bits cannot establish ACL confidentiality/ownership. No opt-out.
    requireInput(process.platform !== "win32" && typeof process.getuid === "function"
      && sourceDirectory !== candidateDirectory);
    const directories = [sourceDirectory, candidateDirectory];
    const chains = await Promise.all(directories.map(directoryChain));
    for (const directory of directories) await noTransferLock(directory);
    for (const directory of directories) for (const role of ROLES) first.push(await readBounded(join(directory, NAMES[role])));
    requireInput(new Set(first.map(entry => entry.stamp.split(":").slice(0, 2).join(":"))).size === 6);
    // A second full pass plus identity/metadata checks detects changes between
    // files/passes, not just an in-place change inside a single read.
    for (const directory of directories) for (const role of ROLES) second.push(await readBounded(join(directory, NAMES[role])));
    requireInput(first.every((entry, i) => entry.stamp === second[i].stamp && entry.bytes.equals(second[i].bytes)));
    for (let i = 0; i < directories.length; i++) {
      requireInput(chains[i] === await directoryChain(directories[i]));
      await noTransferLock(directories[i]);
      for (let k = 0; k < ROLES.length; k++) requireInput(first[i * 3 + k].stamp === stamp(await fs.lstat(join(directories[i], NAMES[ROLES[k]]), { bigint: true })));
    }
    return compareStateFiles(Object.fromEntries(ROLES.map((r, i) => [r, first[i].bytes])), Object.fromEntries(ROLES.map((r, i) => [r, first[i + 3].bytes])));
  } catch { return rejected(); }
  finally { for (const entry of [...first, ...second]) entry.bytes.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const report = args.length === 2 && args.every(arg => !arg.startsWith("-"))
    ? await auditStateDirectories({ sourceDirectory: args[0], candidateDirectory: args[1] }) : rejected();
  console.log(JSON.stringify(report));
  process.exitCode = report.classification === "LOCAL_STATE_MATCH_UNATTESTED" ? 0 : 1;
}
