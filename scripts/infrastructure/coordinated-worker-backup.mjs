import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertSystemdStopped } from "./worker-state-backup.mjs";
import { createJournal } from "./backup-control-state.mjs";
const run = promisify(execFile);

function dashboard(value) {
  if (typeof value?.settings?.publicSubmissionsEnabled !== "boolean"
      || !Number.isInteger(value?.stats?.queued) || value.stats.queued < 0
      || !Number.isInteger(value?.stats?.running) || value.stats.running < 0) throw new Error("Invalid dashboard evidence");
  return value;
}

// This changes production admission and service state only after separate authority.
// A successful return proves a consistent encrypted LOCAL spool, not off-VM delivery.
export async function coordinatedBackup({ operations: ops, authorised = false, maxPolls = 120, shouldAbort = () => false }) {
  if (!authorised) throw new Error("Explicit production pause authorisation required");
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 600) throw new Error("Invalid bounded drain limit");
  let locked = false, journalStarted = false, disabled = false, stopAttempted = false, stoppedVerified = false, originalEnabled, admissionUncertain = false;
  const checkAbort = () => { if (shouldAbort()) throw new Error('Backup interrupted; recovery or manual reconciliation required'); };
  const closed = value => {
    const state = dashboard(value);
    if (state.settings.publicSubmissionsEnabled !== false) { admissionUncertain = true; throw new Error('Admission reopened during backup'); }
    return state;
  };
  try {
    await ops.acquire(); locked = true;
    await ops.checkJournal();
    const initial = dashboard(await ops.dashboard());
    originalEnabled = initial.settings.publicSubmissionsEnabled;
    checkAbort();
    await ops.beginJournal(originalEnabled); journalStarted = true;
    await ops.phaseJournal('closing_admission');
    checkAbort();
    disabled = true;
    await ops.setSubmissions(false);
    await ops.phaseJournal('draining');
    let drained = false;
    for (let i=0;i<maxPolls;i++) {
      checkAbort();
      let state;
      try { state = closed(await ops.dashboard()); } catch (error) { admissionUncertain = true; throw error; }
      if (state.stats.queued === 0 && state.stats.running === 0) { drained = true; break; }
      if (i+1<maxPolls) await ops.sleep();
    }
    if (!drained) throw new Error("Queue did not drain within the allowed window; no service stop attempted");
    checkAbort();
    await ops.phaseJournal('stopping');
    checkAbort();
    let finalState;
    try { finalState = closed(await ops.dashboard()); } catch (error) { admissionUncertain = true; throw error; }
    if (finalState.stats.queued !== 0 || finalState.stats.running !== 0) throw new Error('Queue changed before stop');
    checkAbort();
    stopAttempted = true;
    await ops.stop();
    await ops.assertStopped();
    stoppedVerified = true;
    await ops.phaseJournal('stopped');
    checkAbort();
    await ops.phaseJournal('snapshotting');
    const result = await ops.snapshot({ publicSubmissionsEnabledBeforePause: originalEnabled });
    checkAbort();
    return result;
  } finally {
    try {
      if (admissionUncertain) throw new Error('Admission state is uncertain; manual reconciliation required');
      if (stopAttempted) {
        if (!stoppedVerified) throw new Error("Service stop/exclusive ownership is unverified; publishing remains paused for manual recovery");
        await ops.assertStopped();
        await ops.phaseJournal('starting');
        await ops.start();
        await ops.health();
      }
      if (disabled) {
        // A failed mutation or interrupted drain must not silently overwrite another administrator.
        if (!stopAttempted) await ops.health();
        closed(await ops.dashboard());
        await ops.phaseJournal('restoring_admission');
        await ops.setSubmissions(originalEnabled);
        const restored = dashboard(await ops.dashboard());
        if (restored.settings.publicSubmissionsEnabled !== originalEnabled) throw new Error('Admission restoration unverified');
      }
      if (journalStarted) await ops.completeJournal();
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
  if (!configPath || flag !== "--authorise-service-pause" || process.platform !== "linux" || process.getuid?.() !== 0 || process.env.HSR_BACKUP_FLOCK_HELD !== '1') throw new Error("Linux root, flock wrapper and separately approved --authorise-service-pause required");
  let interrupted=false;
  process.on('SIGTERM',()=>{interrupted=true;}); process.on('SIGINT',()=>{interrupted=true;});
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
  const journal=createJournal({directory:'/var/lib/hsr-worker-backup-control',service:config.service});
  const ops={
    acquire:async()=>{}, release:async()=>{},
    checkJournal:journal.check, beginJournal:journal.begin, phaseJournal:journal.phase, completeJournal:journal.complete,
    dashboard:()=>request("/admin"), setSubmissions:enabled=>request("/admin","PUT",{publicSubmissionsEnabled:enabled}),
    stop:()=>run("systemctl",["stop",config.service],{timeout:30000}),
    assertStopped:()=>assertSystemdStopped(config.service),
    start:()=>run("systemctl",["start",config.service],{timeout:30000}),
    health:async()=>{for(let i=0;i<20;i++){try{await request("/health");return;}catch{await new Promise(r=>setTimeout(r,500));}}throw new Error("Worker did not recover health; submissions remain disabled");},
    snapshot:async maintenance=>{const {stdout}=await run(process.execPath,[resolve(import.meta.dirname,"worker-state-backup.mjs"),"snapshot",configPath],{timeout:30000,maxBuffer:32768,env:{...process.env,HSR_BACKUP_ORIGINAL_SUBMISSIONS:maintenance.publicSubmissionsEnabledBeforePause?"1":"0"}});return JSON.parse(stdout);},
    sleep:()=>new Promise(r=>setTimeout(r,1000)),
  };
  console.log(JSON.stringify({localSnapshot:await coordinatedBackup({operations:ops,authorised:true,shouldAbort:()=>interrupted}),offVmDeliveryVerified:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("Coordinated backup failed. Check service health and admission locally; never assume a backup or service recovery succeeded.");process.exitCode=1;});
