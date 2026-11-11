import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonWorkerJobStore } from "../../src/worker.mjs";
import { JsonTransferStore } from "../../src/store.mjs";
import { JsonSecurityStore } from "../../src/security-state.mjs";
import { createStateBackup, restoreStateBackup } from "./worker-state-backup.mjs";

// Portable synthetic restore drill: no credentials, browser or cloud access.
export async function syntheticRestoreDrill() {
  const directory=await mkdtemp(join(tmpdir(),"hsr-restore-drill-"));
  try {
    const paths={transfers:join(directory,"custom-mappings.json"),jobs:join(directory,"custom-queue.json")};paths.security=paths.jobs+".security.json";
    const now=new Date();
    const sourceId="6a56fe3021253d0e1a9f4761";
    const jobs=new JsonWorkerJobStore(paths.jobs,{now:()=>now});
    await jobs.initialise({publicSubmissionsEnabled:true,dailyAccountQuota:25});
    const {job}=await jobs.createOrGetActive(sourceId,{public:true,clientKey:"synthetic-only"},now);
    await jobs.update(job.id,{status:"completed",result:{status:"created",sourceId,shareCode:"synthetic-only"}},now);
    const mappings=new JsonTransferStore(paths.transfers);
    await mappings.set(sourceId,{status:"created",shareCode:"synthetic-only"});
    const security=new JsonSecurityStore(paths.security);
    await security.consume("submit","synthetic-only",now.getTime());
    await security.register("s".repeat(32),now.getTime()+60000,now.getTime());
    const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:3072});
    const backup=await createStateBackup({paths,publicKey:publicKey.export({type:"spki",format:"pem"}),assertQuiescent:async()=>{}});
    const restored=join(directory,"restored");
    await restoreStateBackup({ ...backup,privateKey,directory:restored,assertQuiescent:async()=>{} });
    const restoredJobs=new JsonWorkerJobStore(join(restored,"jobs.json"),{now:()=>now});
    const before=await jobs.dashboard(),after=await restoredJobs.dashboard();
    assert.deepEqual(after,before);
    assert.deepEqual(await new JsonTransferStore(join(restored,"transfers.json")).get(sourceId),await mappings.get(sourceId));
    assert.deepEqual(await new JsonSecurityStore(join(restored,"jobs.json.security.json")).readState(),await security.readState());
    for(const [role,name]of Object.entries({transfers:"transfers.json",jobs:"jobs.json",security:"jobs.json.security.json"}))assert.deepEqual(await readFile(paths[role]),await readFile(join(restored,name)));
    return {synthetic:true,verifiedAt:new Date().toISOString(),backupSha256:backup.receipt.sha256,exactFiles:3,mappingsPreserved:true,jobResultsPreserved:true,quotasAndPolicyPreserved:true,securityPreserved:true,productionStateRead:false,cloudRestore:false};
  } finally { await rm(directory,{recursive:true,force:true}); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await syntheticRestoreDrill()));
