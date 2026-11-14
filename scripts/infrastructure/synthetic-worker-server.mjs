// Synthetic staging service. No publisher/HoYoLAB client is imported or invoked.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { open, mkdir, readdir, lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonTransferStore } from "../../src/store.mjs";
import { JsonWorkerJobStore, TransferJobQueue, createWorkerHandler } from "../../src/worker.mjs";
import { writePrivateJson } from "../../src/private-json.mjs";
import { probeBrowser } from "./gcp-browser-probe.mjs";

const MARKER = ".hsr-synthetic-state.json";
const OWNER = ".hsr-synthetic-owner.json";
const ALLOWED = new Set([MARKER, OWNER, "jobs.json", "jobs.json.security.json", "transfers.json", "transfers.json.lock"]);

export function validateSyntheticEnvironment(env) {
  if (env.HSR_SYNTHETIC_ONLY !== "1") throw new Error("Explicit synthetic-only mode is required");
  if (Object.keys(env).some(key => key.startsWith("CURRENCY_WAR_"))) throw new Error("Production CURRENCY_WAR environment settings are forbidden in this service");
  if ((env.HSR_SYNTHETIC_HOST ?? "127.0.0.1") !== "127.0.0.1") throw new Error("Bind synthetic worker to loopback behind a verified TLS proxy");
  if (!env.HSR_SYNTHETIC_STATE_DIR || !isAbsolute(env.HSR_SYNTHETIC_STATE_DIR)) throw new Error("An explicit absolute synthetic state directory is required");
  if (typeof env.HSR_SYNTHETIC_TOKEN !== "string" || !/^[\x21-\x7e]{32,256}$/.test(env.HSR_SYNTHETIC_TOKEN)) throw new Error("A separate 32-256 character synthetic bearer token is required");
  const port = Number(env.HSR_SYNTHETIC_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Unprivileged synthetic worker port required");
  return { directory: env.HSR_SYNTHETIC_STATE_DIR, token: env.HSR_SYNTHETIC_TOKEN, port };
}

async function prepare(directory) {
  if (!isAbsolute(directory) || resolve(directory) === resolve("/")) throw new Error("An isolated absolute synthetic directory is required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Synthetic state cannot be a symlink");
  let entries = await readdir(directory);
  if (!entries.length) {
    const marker = { format: "hsr-synthetic-only/v1", id: randomUUID(), createdAt: new Date().toISOString() };
    const file = await open(join(directory, MARKER), "wx", 0o600);
    try { await file.writeFile(JSON.stringify(marker) + "\n"); await file.sync(); } finally { await file.close(); }
    entries = [MARKER];
  }
  if (!entries.includes(MARKER) || entries.some(name => !ALLOWED.has(name))) throw new Error("Refusing unmarked or foreign non-synthetic state (including any browser profile)");
  for (const name of entries) if ((await lstat(join(directory, name))).isSymbolicLink()) throw new Error("Synthetic state symlinks are forbidden");
  const marker = JSON.parse(await readFile(join(directory, MARKER), "utf8"));
  if (marker.format !== "hsr-synthetic-only/v1" || !/^[a-f0-9-]{36}$/.test(marker.id)) throw new Error("Invalid synthetic state marker");
  return marker;
}

async function claim(directory) {
  const path = join(directory, OWNER);
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Invalid synthetic owner lock");
    const owner = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid synthetic owner PID");
    try { process.kill(owner.pid, 0); throw new Error("Synthetic state is already owned by a live process"); }
    catch (probeError) { if (probeError.code !== "ESRCH") throw probeError; }
    const after = await lstat(path);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new Error("Synthetic owner changed; retry after investigating");
    await unlink(path);
    file = await open(path, "wx", 0o600);
  }
  await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
  await file.sync();
  return async () => { await file.close(); await unlink(path); };
}

async function removeDeadSyntheticTransferLock(directory) {
  const path = join(directory, "transfers.json.lock");
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Invalid synthetic transfer lock");
  const raw = (await readFile(path, "utf8")).trim();
  if (!/^[1-9]\d{0,9}$/.test(raw)) throw new Error("Invalid synthetic writer lock");
  try { process.kill(Number(raw), 0); throw new Error("A synthetic transfer writer is still alive"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  const after = await lstat(path);
  if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new Error("Synthetic writer lock changed");
  await unlink(path);
}

export async function startSyntheticWorker({ directory, token, port = 0, browserCheck = () => probeBrowser({ browserChannel: process.env.HSR_SYNTHETIC_BROWSER_CHANNEL || "chrome", browserExecutablePath: process.env.HSR_SYNTHETIC_BROWSER_EXECUTABLE_PATH }), beforeTransfer = async () => {} }) {
  if (typeof token !== "string" || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error("Invalid synthetic token");
  const marker = await prepare(directory);
  const release = await claim(directory);
  let server;
  try {
    await removeDeadSyntheticTransferLock(directory);
    const transfers = new JsonTransferStore(join(directory, "transfers.json"));
    const store = new JsonWorkerJobStore(join(directory, "jobs.json"));
    await store.initialise({ publicSubmissionsEnabled: true });
    if (!(await readdir(directory)).includes("transfers.json")) await writePrivateJson(transfers.path, { version: 1, transfers: {} });
    if (!(await readdir(directory)).includes("jobs.json.security.json")) await writePrivateJson(store.path + ".security.json", { version: 1, requests: {}, sessions: {} });
    const queue = new TransferJobQueue({ store, transferFn: sourceId => transfers.withTransferLock(async () => {
      const existing = await transfers.get(sourceId);
      if (existing) return existing;
      await beforeTransfer(sourceId);
      const browser = await browserCheck();
      if (browser?.synthetic !== true) throw new Error("Synthetic browser proof required");
      const result = { status: "created", synthetic: true, sourceId, shareCode: "SYNTHETIC-" + sourceId.slice(0, 12), ignored: [] };
      await transfers.set(sourceId, result);
      return result;
    }) });
    await queue.start();
    const handler = createWorkerHandler({ queue, store, token });
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ status: "ok", mode: "hsr-synthetic-worker", syntheticStateId: marker.id }));
      } else handler(request, response);
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 10000;
    await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
    let closing;
    return { endpoint: `http://127.0.0.1:${server.address().port}`, store, queue,
      close() {
        if (closing) return closing;
        closing = (async () => {
          await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
          const deadline = Date.now() + 20000;
          while (queue.running || queue.pending.length) {
            if (Date.now() >= deadline) throw new Error("Synthetic queue did not stop; retain ownership until supervisor terminates the process");
            await new Promise(done => setTimeout(done, 20));
          }
          await release();
        })();
        return closing;
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise(done => server.close(done));
    await release();
    throw error;
  }
}

async function main() {
  const options = validateSyntheticEnvironment(process.env);
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Run the real staging service as a non-root Linux user");
  const worker = await startSyntheticWorker({ ...options,
    beforeTransfer: process.env.HSR_SYNTHETIC_PAUSE_BEFORE_TRANSFER === "1"
      ? async () => { console.log(JSON.stringify({ event: "synthetic_transfer_waiting" })); await new Promise(() => {}); }
      : undefined,
  });
  console.log(JSON.stringify({ event: "synthetic_worker_ready", endpoint: worker.endpoint, productionPublishing: false }));
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    try { await worker.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
    finally { process.exit(); }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("Synthetic worker failed. Do not replace the directory with production state or disable browser sandboxing.");
  process.exitCode = 1;
});
