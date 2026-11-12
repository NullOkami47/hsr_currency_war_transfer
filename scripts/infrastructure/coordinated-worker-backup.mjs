import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertSystemdStopped } from "./worker-state-backup.mjs";
const run = promisify(execFile);

function dashboard(value) {
  if (typeof value?.settings?.publicSubmissionsEnabled !== "boolean"
      || !Number.isInteger(value?.stats?.queued) || value.stats.queued < 0
      || !Number.isInteger(value?.stats?.running) || value.stats.running < 0) throw new Error("Invalid dashboard evidence");
  return value;
}

// This changes production admission and service state only after separate authority.
// A successful return proves a consistent encrypted LOCAL spool, not off-VM delivery.
export async function coordinatedBackup({ operations: ops, authorised = false, maxPolls = 120 }) {
  if (!authorised) throw new Error("Explicit production pause authorisation required");
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 600) throw new Error("Invalid bounded drain limit");
  let locked = false, disabled = false, stopAttempted = false, stoppedVerified = false, originalEnabled;
  try {
    await ops.acquire(); locked = true;
    const initial = dashboard(await ops.dashboard());
    originalEnabled = initial.settings.publicSubmissionsEnabled;
    disabled = true;
    await ops.setSubmissions(false);
    let drained = false;
    for (let i=0;i<maxPolls;i++) {
      const state = dashboard(await ops.dashboard());
      if (state.stats.queued === 0 && state.stats.running === 0) { drained = true; break; }
      if (i+1<maxPolls) await ops.sleep();
    }
    if (!drained) throw new Error("Queue did not drain within the allowed window; no service stop attempted");
    stopAttempted = true;
    await ops.stop();
    await ops.assertStopped();
    stoppedVerified = true;
    return await ops.snapshot({ publicSubmissionsEnabledBeforePause: originalEnabled });
  } finally {
    try {
      if (stopAttempted) {
        if (!stoppedVerified) throw new Error("Service stop/exclusive ownership is unverified; publishing remains paused for manual recovery");
        await ops.assertStopped();
        await ops.start();
        await ops.health();
      }
      if (disabled) await ops.setSubmissions(originalEnabled);
    } finally { if (locked) await ops.release(); }
  }
}

async function protectedFile(path) {
  const stat=await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== 0) throw new Error("Configuration and environment files must be root-owned 0600 regular files");
  return readFile(path,"utf8");
}

async function main() {
  const [configPath, flag] = process.argv.slice(2);
  if (!configPath || flag !== "--authorise-service-pause" || process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Linux root and separately approved --authorise-service-pause required");
  const config=JSON.parse(await protectedFile(configPath));
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(config.service)) throw new Error("Invalid service");
  const base=new URL(config.endpoint);
  if (!['http:'].includes(base.protocol) || base.hostname !== "127.0.0.1" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("Only a loopback worker endpoint is accepted");
  const env=await protectedFile(config.environmentFile);
  let token=env.split(/\r?\n/).find(line=>line.startsWith("CURRENCY_WAR_WORKER_TOKEN="))?.slice("CURRENCY_WAR_WORKER_TOKEN=".length).trim();
  if (token?.startsWith('"') && token.endsWith('"') || token?.startsWith("'") && token.endsWith("'")) token=token.slice(1,-1);
  if (!token || !/^[\x21-\x7e]{24,256}$/.test(token)) throw new Error("Unsupported worker-token environment value; do not evaluate shell contents");
  const request=async (path,method="GET",body) => {
    const response=await fetch(new URL(path,base),{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000),redirect:"error"});
    if(!response.ok) throw new Error("Worker maintenance request failed");
    return response.json();
  };
  const lock="/run/hsr-worker-backup.lock";
  const ops={
    acquire:()=>mkdir(lock,{mode:0o700}), release:()=>rmdir(lock),
    dashboard:()=>request("/admin"), setSubmissions:enabled=>request("/admin","PUT",{publicSubmissionsEnabled:enabled}),
    stop:()=>run("systemctl",["stop",config.service],{timeout:30000}),
    assertStopped:()=>assertSystemdStopped(config.service),
    start:()=>run("systemctl",["start",config.service],{timeout:30000}),
    health:async()=>{for(let i=0;i<20;i++){try{await request("/health");return;}catch{await new Promise(r=>setTimeout(r,500));}}throw new Error("Worker did not recover health; submissions remain disabled");},
    snapshot:async maintenance=>{const {stdout}=await run(process.execPath,[resolve(import.meta.dirname,"worker-state-backup.mjs"),"snapshot",configPath],{timeout:30000,maxBuffer:32768,env:{...process.env,HSR_BACKUP_ORIGINAL_SUBMISSIONS:maintenance.publicSubmissionsEnabledBeforePause?"1":"0"}});return JSON.parse(stdout);},
    sleep:()=>new Promise(r=>setTimeout(r,1000)),
  };
  console.log(JSON.stringify({localSnapshot:await coordinatedBackup({operations:ops,authorised:true}),offVmDeliveryVerified:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("Coordinated backup failed. Check service health and admission locally; never assume a backup or service recovery succeeded.");process.exitCode=1;});
