import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { probeBrowser } from "./gcp-browser-probe.mjs";
const run = promisify(execFile);
if (process.platform !== "linux") throw new Error("Linux process-tree sampling required");
let peakTreeRssBytes = 0, samples = 0, peakProcesses = 0;
let peakTreePssBytes = 0, peakTreeSwapBytes = 0, pssCompleteSamples = 0, stopped = false;
async function sample() {
  const command = run("ps", ["-e", "-o", "pid=,ppid=,rss="], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const { stdout } = await command;
  const rows = stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([process.pid]);
  let changed;
  do {
    changed = false;
    for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); changed = true; }
  } while (changed);
  const matching = rows.filter(([pid]) => pids.has(pid) && pid !== command.child.pid);
  peakTreeRssBytes = Math.max(peakTreeRssBytes, matching.reduce((sum, [, , rss]) => sum + rss * 1024, 0));
  peakProcesses = Math.max(peakProcesses, matching.length);
  samples++;
  let pss = 0, swap = 0, complete = true;
  for (const [pid] of matching) {
    try {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      const pssValue = rollup.match(/^Pss:\s+(\d+) kB$/m), swapValue = rollup.match(/^Swap:\s+(\d+) kB$/m);
      if (!pssValue) { complete = false; continue; }
      pss += Number(pssValue[1]) * 1024;
      swap += Number(swapValue?.[1] ?? 0) * 1024;
    } catch { complete = false; }
  }
  if (complete) {
    pssCompleteSamples++;
    peakTreePssBytes = Math.max(peakTreePssBytes, pss);
    peakTreeSwapBytes = Math.max(peakTreeSwapBytes, swap);
  }
}
const loop = (async () => { while (!stopped) { await sample(); await new Promise(resolve => setTimeout(resolve, 100)); } })();
let result;
try { result = await probeBrowser(); }
finally { stopped = true; await loop; }
console.log(JSON.stringify({
  ...result, peakSampledProcessTreeRssBytes: peakTreeRssBytes, peakProcesses, samples,
  peakSampledProcessTreePssBytes: pssCompleteSamples ? peakTreePssBytes : null,
  peakSampledProcessTreeSwapBytes: pssCompleteSamples ? peakTreeSwapBytes : null,
  pssCompleteSamples, samplingIntervalMs: 100,
  rssCaveat: "RSS double-counts shared pages. PSS is proportional and complete samples may be unavailable when Chrome sandboxes restrict /proc. Sampling can miss peaks. Neither is isolated cgroup memory; record GCP memory.peak and OOM events separately.",
  meminfo: await readFile("/proc/meminfo", "utf8"),
}));
