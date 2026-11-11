import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
const run = promisify(execFile);

// Read-only discovery. Never dumps /proc environ or EnvironmentFile contents.
export async function discoverWorker(service = "hsr-transfer-worker.service") {
  if (process.platform !== "linux" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(service)) throw new Error("Linux and a valid service required");
  const { stdout } = await run("systemctl", ["show", service, "--property=LoadState,ActiveState,SubState,MainPID,User,WorkingDirectory,FragmentPath,EnvironmentFiles"], { timeout: 10000 });
  const info = Object.fromEntries(stdout.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0,i), line.slice(i+1)]; }));
  if (info.LoadState !== "loaded" || !/^[1-9]\d*$/.test(info.MainPID)) throw new Error("A running service is required for actual process environment discovery");
  const environment = Object.fromEntries((await readFile(`/proc/${info.MainPID}/environ`, "utf8")).split("\0").filter(x => x.includes("=")).map(x => { const i=x.indexOf("="); return [x.slice(0,i),x.slice(i+1)]; }));
  if (!environment.HOME) throw new Error("Service HOME is absent; explicitly discover its passwd home before proceeding");
  const base = resolve(environment.HOME, ".hsr-currency-war-transfer");
  const cwd = info.WorkingDirectory;
  const paths = {
    transfers: resolve(cwd, environment.CURRENCY_WAR_STATE_PATH ?? resolve(base, "transfers.json")),
    jobs: resolve(cwd, environment.CURRENCY_WAR_JOB_STATE_PATH ?? resolve(base, "jobs.json")),
  };
  paths.security = paths.jobs + ".security.json";
  return { observedAt: new Date().toISOString(), service, ...info, paths,
    profileExcluded: resolve(cwd, environment.CURRENCY_WAR_PROFILE_DIR ?? resolve(base,"browser-profile")),
    endpoint: `http://${environment.CURRENCY_WAR_WORKER_HOST ?? "127.0.0.1"}:${environment.CURRENCY_WAR_WORKER_PORT ?? "8787"}`,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) discoverWorker(process.argv[2]).then(x => console.log(JSON.stringify(x,null,2))).catch(() => { console.error("Discovery failed; use privileged read-only process inspection without printing secrets."); process.exitCode=1; });
