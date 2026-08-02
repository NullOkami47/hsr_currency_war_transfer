import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { localInstanceMatches } from "../src/local-instance.mjs";

const root = join(import.meta.dirname, "..");
const runtimeDirectory = join(root, "var");
const statePath = join(runtimeDirectory, "local-stack.json");

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function existingStack() {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const servicesMatch = await Promise.all([
      localInstanceMatches(
        "http://127.0.0.1:8787/health",
        state.instanceId,
      ),
      localInstanceMatches(
        "http://127.0.0.1:4173/__local/health",
        state.instanceId,
      ),
    ]);
    return processIsRunning(state.workerPid)
      && processIsRunning(state.websitePid)
      && servicesMatch.every(Boolean)
      ? state
      : null;
  } catch {
    return null;
  }
}

async function waitFor(url, instanceId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (
        response.ok
        && response.headers.get("x-currency-war-instance") === instanceId
      ) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local service did not become ready: ${url}`);
}

const existing = await existingStack();
if (existing) {
  console.log("Currency War local stack is already running.");
  console.log("Website: http://127.0.0.1:4173");
  console.log("Worker health: http://127.0.0.1:8787/health");
  process.exit(0);
}

const token = randomBytes(32).toString("hex");
const adminToken = process.env.CURRENCY_WAR_ADMIN_TOKEN
  ?? randomBytes(32).toString("hex");
if (adminToken.length < 32) {
  throw new Error("CURRENCY_WAR_ADMIN_TOKEN must contain at least 32 characters");
}
const instanceId = randomBytes(24).toString("base64url");
const commonOptions = {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: "ignore",
};
const worker = spawn(process.execPath, ["scripts/worker-server.mjs"], {
  ...commonOptions,
  env: {
    ...process.env,
    CURRENCY_WAR_WORKER_TOKEN: token,
    CURRENCY_WAR_WORKER_HOST: "127.0.0.1",
    CURRENCY_WAR_WORKER_PORT: "8787",
    CURRENCY_WAR_HEADLESS: process.env.CURRENCY_WAR_HEADLESS ?? "1",
    CURRENCY_WAR_LOCAL_INSTANCE_ID: instanceId,
    CURRENCY_WAR_PUBLIC_SUBMISSIONS: "1",
    CURRENCY_WAR_SOURCE_BLACKLIST_ENABLED: "1",
  },
});
const website = spawn(process.execPath, ["scripts/dev-server.mjs"], {
  ...commonOptions,
  env: {
    ...process.env,
    CURRENCY_WAR_WORKER_TOKEN: token,
    CURRENCY_WAR_WORKER_URL: "http://127.0.0.1:8787/jobs",
    CURRENCY_WAR_ADMIN_TOKEN: adminToken,
    CURRENCY_WAR_LOCAL_INSTANCE_ID: instanceId,
  },
});
worker.unref();
website.unref();

try {
  await Promise.all([
    waitFor("http://127.0.0.1:8787/health", instanceId),
    waitFor("http://127.0.0.1:4173/__local/health", instanceId),
  ]);
} catch (error) {
  for (const child of [worker, website]) {
    if (processIsRunning(child.pid)) process.kill(child.pid);
  }
  throw error;
}

await mkdir(runtimeDirectory, { recursive: true });
await writeFile(statePath, `${JSON.stringify({
  workerPid: worker.pid,
  websitePid: website.pid,
  startedAt: new Date().toISOString(),
  instanceId,
}, null, 2)}\n`, "utf8");

console.log("Currency War local stack is ready.");
console.log("Website: http://127.0.0.1:4173");
console.log("Worker health: http://127.0.0.1:8787/health");
console.log("Administrator console: http://127.0.0.1:4173/admin");
console.log(`One-time local administrator token: ${adminToken}`);
console.log("Stop it with: npm run local:stop");
