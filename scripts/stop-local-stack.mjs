import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { localInstanceMatches } from "../src/local-instance.mjs";

const statePath = join(import.meta.dirname, "..", "var", "local-stack.json");

let state;
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("Currency War local stack is not running.");
    process.exit(0);
  }
  throw error;
}

const processes = [
  {
    pid: state.websitePid,
    healthUrl: "http://127.0.0.1:4173/__local/health",
  },
  {
    pid: state.workerPid,
    healthUrl: "http://127.0.0.1:8787/health",
  },
];
let stopped = 0;
for (const { pid, healthUrl } of processes) {
  if (!Number.isInteger(pid)) continue;
  if (!await localInstanceMatches(healthUrl, state.instanceId)) {
    console.warn(`Skipped stale or unverified local process PID ${pid}.`);
    continue;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
  stopped += 1;
}

await rm(statePath, { force: true });
console.log(`Currency War local stack stopped (${stopped} verified processes).`);
