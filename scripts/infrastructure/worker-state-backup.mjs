import { constants } from "node:fs";
import { open, readFile, writeFile, lstat, mkdir, readdir, rm, chown } from "node:fs/promises";
import { createHash, createCipheriv, createDecipheriv, createPublicKey, publicEncrypt, privateDecrypt, randomBytes, constants as cryptoConstants } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT = "hsr-worker-backup/v1";
const AAD = Buffer.from(FORMAT);
const ROLES = ["transfers", "jobs", "security"];
const NAMES = { transfers: "transfers.json", jobs: "jobs.json", security: "jobs.json.security.json" };
const MAX_FILE = 8 * 1024 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const runFile = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const object = x => x && typeof x === "object" && !Array.isArray(x);

function checkPaths(paths) {
  if (!object(paths) || Object.keys(paths).sort().join() !== [...ROLES].sort().join()
      || ROLES.some(role => typeof paths[role] !== "string" || !isAbsolute(paths[role]))
      || new Set(ROLES.map(role => resolve(paths[role]))).size !== 3
      || paths.security !== paths.jobs + ".security.json") {
    throw new Error("Three distinct absolute paths and the exact jobs companion path are required");
  }
}

function validateFiles(files) {
  if (!object(files) || Object.keys(files).sort().join() !== [...ROLES].sort().join()) throw new Error("Invalid state file allowlist");
  const state = Object.fromEntries(ROLES.map(role => [role, JSON.parse(files[role].toString("utf8"))]));
  if (state.transfers?.version !== 1 || !object(state.transfers.transfers)
      || state.jobs?.version !== 4 || !object(state.jobs.settings) || !object(state.jobs.jobs)
      || !object(state.jobs.quota) || !Array.isArray(state.jobs.quota.events)
      || !Number.isFinite(state.jobs.quota.blockedUntil)
      || state.jobs.quota.events.some(e => !object(e) || !Number.isFinite(e.at) || typeof e.clientKey !== "string")
      || state.security?.version !== 1 || !object(state.security.requests) || !object(state.security.sessions)) {
    throw new Error("Invalid or unsupported worker state schema; never substitute missing security/quota state");
  }
  for (const job of Object.values(state.jobs.jobs)) {
    if (!object(job) || !["completed", "failed"].includes(job.status)) {
      throw new Error("Drain queued jobs and reconcile running/ambiguous jobs before snapshot or restore");
    }
  }
}

async function quiescence(check) {
  if (typeof check !== "function") throw new Error("An explicit quiescence check is required");
  await check();
}

async function readSource(path, maximumBytes = MAX_FILE) {
  if ((await lstat(path)).isSymbolicLink()) throw new Error("Source symlink is forbidden");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("State file is not a bounded regular file");
    return await file.readFile();
  } finally { await file.close(); }
}

export async function assertSystemdStopped(service) {
  if (process.platform !== "linux" || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(service)) throw new Error("Linux and an explicit systemd service are required");
  const { stdout } = await runFile("systemctl", ["show", service, "--property=LoadState,ActiveState,SubState,MainPID"], { timeout: 10000 });
  const properties = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
  if (properties.LoadState !== "loaded" || properties.ActiveState !== "inactive"
      || properties.SubState !== "dead" || properties.MainPID !== "0") throw new Error("Worker service must be explicitly stopped and inactive/dead with MainPID=0");
  // Fail closed if another supported command could be writing state outside systemd.
  for (const pid of (await readdir("/proc")).filter(name => /^\d+$/.test(name))) {
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (args.some(arg => /(?:^|\/)(?:worker-server|transfer|adopt-mapping)\.mjs$/.test(arg))) throw new Error("A worker or manual state writer is still active");
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
}

export async function createStateBackup({ paths, publicKey, assertQuiescent, maintenance = null, now = () => new Date() }) {
  checkPaths(paths);
  await quiescence(assertQuiescent);
  try { await lstat(paths.transfers + ".lock"); throw new Error("Transfer lock exists; investigate before backup"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const files = Object.fromEntries(await Promise.all(ROLES.map(async role => [role, await readSource(paths[role])])));
  await quiescence(assertQuiescent);
  validateFiles(files);
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 3072) throw new Error("RSA public key of at least 3072 bits required");
  const createdAt = now().toISOString();
  if (maintenance !== null && (typeof maintenance?.publicSubmissionsEnabledBeforePause !== "boolean"
      || Object.keys(maintenance).length !== 1)) throw new Error("Invalid maintenance metadata");
  const manifest = { format: FORMAT, createdAt, paths, maintenance, files: Object.fromEntries(ROLES.map(role => [role, { bytes: files[role].length, sha256: sha256(files[role]) }])) };
  const content = Buffer.from(JSON.stringify({ manifest, files: Object.fromEntries(ROLES.map(role => [role, files[role].toString("base64")])) }));
  const symmetricKey = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", symmetricKey, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
    const encryptedKey = publicEncrypt({ key, oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING }, symmetricKey);
    const encrypted = Buffer.from(JSON.stringify({ format: FORMAT, encryptedKey: encryptedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }) + "\n");
    return { encrypted, receipt: { format: FORMAT, createdAt, sha256: sha256(encrypted), bytes: encrypted.length, recipient: sha256(key.export({ type: "spki", format: "der" })) } };
  } finally { symmetricKey.fill(0); content.fill(0); for (const file of Object.values(files)) file.fill(0); }
}

export function verifyStateBackup(encrypted, privateKey, receipt) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length > MAX_ARCHIVE) throw new Error("Invalid bounded encrypted backup");
  if (!receipt || receipt.format !== FORMAT || receipt.sha256 !== sha256(encrypted) || receipt.bytes !== encrypted.length) throw new Error("Backup receipt checksum mismatch");
  const envelope = JSON.parse(encrypted.toString("utf8"));
  if (envelope.format !== FORMAT) throw new Error("Unsupported backup format");
  const key = privateDecrypt({ ...(object(privateKey) && Object.hasOwn(privateKey, "key") ? privateKey : { key: privateKey }), oaepHash: "sha256", padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.encryptedKey, "base64"));
  let plain;
  try {
    const iv = Buffer.from(envelope.iv, "base64"), tag = Buffer.from(envelope.tag, "base64");
    if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encryption parameters");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    const decoded = JSON.parse(plain.toString("utf8"));
    if (decoded.manifest?.format !== FORMAT || decoded.manifest.createdAt !== receipt.createdAt) throw new Error("Invalid backup manifest");
    checkPaths(decoded.manifest.paths);
    if (!object(decoded.files) || Object.keys(decoded.files).sort().join() !== [...ROLES].sort().join()) throw new Error("Invalid state file allowlist");
    const files = Object.fromEntries(ROLES.map(role => [role, Buffer.from(decoded.files[role], "base64")]));
    for (const role of ROLES) {
      const expected = decoded.manifest.files[role];
      if (files[role].length > MAX_FILE || expected?.bytes !== files[role].length || expected.sha256 !== sha256(files[role])) throw new Error("State file checksum mismatch");
    }
    validateFiles(files);
    return { manifest: decoded.manifest, files };
  } finally { key.fill(0); plain?.fill(0); }
}

export async function restoreStateBackup({ encrypted, privateKey, receipt, directory, assertQuiescent }) {
  await quiescence(assertQuiescent);
  const { manifest, files } = verifyStateBackup(encrypted, privateKey, receipt);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 }); // Exclusive: never overwrite even an empty destination.
    created = true;
    for (const role of ROLES) {
      const handle = await open(join(directory, NAMES[role]), "wx", 0o600);
      try { await handle.writeFile(files[role]); await handle.sync(); } finally { await handle.close(); }
    }
    await quiescence(assertQuiescent);
    await writeFile(join(directory, "restore-receipt.json"), JSON.stringify({ createdAt: manifest.createdAt, backupSha256: receipt.sha256, maintenance: manifest.maintenance, files: manifest.files }) + "\n", { mode: 0o600, flag: "wx" });
    return { createdAt: manifest.createdAt, backupSha256: receipt.sha256, directory };
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { for (const file of Object.values(files)) file.fill(0); }
}

export async function pruneBackups({ directory, privateKey, now = () => new Date(), retentionDays = 7 }) {
  if (retentionDays !== 7) throw new Error("This policy requires seven-day retention");
  const verified = [];
  for (const name of await readdir(directory)) {
    if (!/^hsr-state-[a-zA-Z0-9_-]+\.enc\.json$/.test(name)) continue;
    const path = join(directory, name), receiptPath = path.replace(/\.enc\.json$/, ".receipt.json");
    try {
      if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink() || (await lstat(receiptPath)).isSymbolicLink()) continue;
      const bytes = await readSource(path, MAX_ARCHIVE), receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      const decoded = verifyStateBackup(bytes, privateKey, receipt);
      for (const file of Object.values(decoded.files)) file.fill(0);
      const time = Date.parse(receipt.createdAt);
      if (!Number.isFinite(time) || time > now().getTime()) continue;
      verified.push({ name, path, receiptPath, time });
    } catch { /* Unverified or incomplete backups are never automatically deleted. */ }
  }
  const cutoff = now().getTime() - retentionDays * 86400000;
  if (!verified.some(backup => backup.time >= cutoff)) return [];
  const removed = [];
  for (const backup of verified.filter(backup => backup.time < cutoff).sort((a, b) => a.name.localeCompare(b.name))) {
    await rm(backup.path);
    await rm(backup.receiptPath);
    removed.push(backup.name);
  }
  return removed;
}

async function main() {
  const [action, configPath] = process.argv.slice(2);
  if (!configPath || !["snapshot", "verify", "restore", "prune"].includes(action)) throw new Error("Usage: node worker-state-backup.mjs snapshot|verify|restore|prune /absolute/private-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const assertQuiescent = () => assertSystemdStopped(config.service);
  if (action === "snapshot") {
    const backup = await createStateBackup({ paths: config.paths, publicKey: await readFile(config.publicKeyPath), assertQuiescent,
      maintenance: process.env.HSR_BACKUP_ORIGINAL_SUBMISSIONS === undefined ? null : {
        publicSubmissionsEnabledBeforePause: process.env.HSR_BACKUP_ORIGINAL_SUBMISSIONS === "1",
      },
    });
    await mkdir(config.backupDirectory, { recursive: true, mode: 0o700 });
    const spool = await lstat(config.backupDirectory);
    if (!spool.isDirectory() || spool.isSymbolicLink() || (spool.mode & 0o077) !== 0) throw new Error("Protected spool directory required");
    let backupUid;
    if (config.backupUser) {
      if (process.getuid?.() !== 0 || !/^[a-z_][a-z0-9_-]*$/.test(config.backupUser)) throw new Error("Root and valid collector username required");
      const { stdout } = await runFile("id", ["-u", config.backupUser], { timeout: 5000 });
      if (!/^\d+\s*$/.test(stdout)) throw new Error("Cannot resolve backup owner");
      backupUid = Number(stdout.trim());
      if (backupUid === 0) throw new Error("Use a non-root SSH collector");
      await chown(config.backupDirectory, backupUid, -1);
    }
    const stem = join(config.backupDirectory, "hsr-state-" + backup.receipt.createdAt.replace(/[:.]/g, "-"));
    await writeFile(stem + ".enc.json", backup.encrypted, { flag: "wx", mode: 0o600 });
    await writeFile(stem + ".receipt.json", JSON.stringify(backup.receipt) + "\n", { flag: "wx", mode: 0o600 });
    if (backupUid !== undefined) {
      await chown(stem + ".enc.json", backupUid, -1);
      await chown(stem + ".receipt.json", backupUid, -1);
    }
    console.log(JSON.stringify({ ...backup.receipt, file: stem + ".enc.json", receiptFile: stem + ".receipt.json" }));
    return;
  }
  const privateKey = { key: await readFile(config.privateKeyPath), passphrase: process.env.HSR_BACKUP_KEY_PASSPHRASE };
  if (action === "prune") { console.log(JSON.stringify({ removed: await pruneBackups({ directory: config.backupDirectory, privateKey }) })); return; }
  const encrypted = await readFile(config.backupPath), receipt = JSON.parse(await readFile(config.receiptPath, "utf8"));
  if (action === "verify") {
    const result = verifyStateBackup(encrypted, privateKey, receipt);
    for (const file of Object.values(result.files)) file.fill(0);
    console.log(JSON.stringify({ verified: true, ...receipt }));
  } else console.log(JSON.stringify(await restoreStateBackup({ encrypted, privateKey, receipt, directory: config.restoreDirectory, assertQuiescent })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("Backup operation failed; no recovery success is claimed. Inspect protected diagnostics locally; do not print state or keys.");
  process.exitCode = 1;
});
