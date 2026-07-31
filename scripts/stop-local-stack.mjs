import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

for (const pid of [state.websitePid, state.workerPid]) {
  if (!Number.isInteger(pid)) continue;
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
}

await rm(statePath, { force: true });
console.log("Currency War local stack stopped.");
