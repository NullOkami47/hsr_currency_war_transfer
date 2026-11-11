import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const exec=promisify(execFile);

export function validateStandbyConfig(config) {
  if(!config || !/^[^\s@]+@[^\s@]+$/.test(config.account) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project)
    || !/^(us-central1|us-west1|us-east1)-[a-z]$/.test(config.zone)
    || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(config.instance)
    || !Number.isInteger(config.maxRunSeconds) || config.maxRunSeconds<300 || config.maxRunSeconds>7200) throw new Error("Explicit account, project, eligible US zone, valid VM and 300-7200s limit required");
}

export function validateStandbyInstance(config,vm) {
  validateStandbyConfig(config);
  if(vm?.name!==config.instance || !vm.machineType?.endsWith("/machineTypes/e2-micro")
    || vm.labels?.purpose!=="hsr-worker-standby" || vm.labels?.mode!=="synthetic") throw new Error("Only the explicitly labelled synthetic e2-micro standby is allowed");
  if(!Array.isArray(vm.networkInterfaces) || vm.networkInterfaces.length!==1
    || vm.networkInterfaces.some(n=>(n.accessConfigs??[]).length>0)
    || vm.networkInterfaces[0].stackType!=="IPV4_IPV6"
    || !(vm.networkInterfaces[0].ipv6AccessConfigs??[]).some(n=>n.externalIpv6)) throw new Error("External IPv6 and no external IPv4 required; paid networking needs separate approval");
  if(!Array.isArray(vm.disks) || vm.disks.length!==1 || !vm.disks[0].boot
    || vm.disks[0].type!=="PERSISTENT" || Number(vm.disks[0].diskSizeGb)>30 || Number(vm.disks[0].diskSizeGb)<1) throw new Error("One bounded persistent boot disk required; verify pd-standard separately");
  return vm;
}

const flags=config=>[`--account=${config.account}`,`--project=${config.project}`,`--zone=${config.zone}`,"--format=json","--quiet"];
const describe=(config,run)=>run(["compute","instances","describe",config.instance,...flags(config)]);

export async function startStandby({config,run,authorised=false,now=()=>new Date()}) {
  validateStandbyConfig(config);
  if(!authorised)throw new Error("Explicit synthetic staging start authorisation required");
  const cost=config.costEvidence;
  const age=now().getTime()-Date.parse(cost?.verifiedAt);
  if(!cost?.freeTierAvailable || !cost?.budgetsVerified || !Number.isFinite(age) || age<0 || age>86400000)throw new Error("Fresh cost and aggregate free-tier eligibility evidence required; budgets are alerts, not hard caps");
  const before=validateStandbyInstance(config,await describe(config,run));
  if(before.status!=="TERMINATED")throw new Error("VM must already be stopped; do not extend or reset a running experiment");
  await run(["compute","instances","set-scheduling",config.instance,`--max-run-duration=${config.maxRunSeconds}s`,"--instance-termination-action=STOP",...flags(config)]);
  const scheduled=validateStandbyInstance(config,await describe(config,run));
  if(scheduled.scheduling?.instanceTerminationAction!=="STOP" || Number(scheduled.scheduling?.maxRunDuration?.seconds)!==config.maxRunSeconds)throw new Error("Provider STOP limit readback failed");
  await run(["compute","instances","start",config.instance,...flags(config)]);
  const after=validateStandbyInstance(config,await describe(config,run));
  if(after.status!=="RUNNING")throw new Error("VM start not confirmed; inspect the same VM without launching another");
  return {name:after.name,status:after.status,providerStopSeconds:config.maxRunSeconds};
}

async function main(){
  const [action,configPath,authority]=process.argv.slice(2);
  if(!configPath || !["preflight","start","stop","verify"].includes(action))throw new Error("Usage: node gcp-standby.mjs preflight|start|stop|verify /private/config.json [--authorise-staging]");
  const config=JSON.parse((await readFile(configPath,"utf8")).replace(/^\uFEFF/,""));validateStandbyConfig(config);
  const run=async args=>{const{stdout}=await exec(config.gcloudPath??"gcloud",args,{timeout:120000,maxBuffer:2*1024*1024});return stdout.trim()?JSON.parse(stdout):{};};
  const accounts=await run(["auth","list",`--filter=account=${config.account}`,"--format=json"]);
  if(!Array.isArray(accounts) || !accounts.some(a=>a.account===config.account))throw new Error("Correct explicitly selected Google account is not authenticated");
  const vm=validateStandbyInstance(config,await describe(config,run));
  const boot=await run(["compute","disks","describe",vm.disks[0].source.split("/").at(-1),...flags(config)]);
  if(!boot.type?.endsWith("/diskTypes/pd-standard") || Number(boot.sizeGb)>30)throw new Error("Actual boot disk is not bounded pd-standard");
  if(action==="start")console.log(JSON.stringify(await startStandby({config,run,authorised:authority==="--authorise-staging"})));
  else if(action==="stop"){
    if(authority!=="--authorise-staging")throw new Error("Scoped staging stop flag required");
    await run(["compute","instances","stop",config.instance,...flags(config)]);
    const after=await describe(config,run);if(after.status!=="TERMINATED")throw new Error("VM stopped state is not verified");
    console.log(JSON.stringify({name:vm.name,status:after.status,bootDiskRetained:true}));
  }else if(action==="verify"){
    const endpoint=new URL(config.healthUrl);
    if(endpoint.protocol!=="https:" || endpoint.username || endpoint.password)throw new Error("Verified HTTPS origin required");
    const response=await fetch(endpoint,{signal:AbortSignal.timeout(10000),redirect:"error"});
    const health=await response.json();if(!response.ok || health.status!=="ok")throw new Error("Worker HTTPS health failed");
    console.log(JSON.stringify({name:vm.name,httpsHealth:true,vmStatus:vm.status,authenticatedJobsVerified:false}));
  }else console.log(JSON.stringify({name:vm.name,status:vm.status,account:config.account,project:config.project,zone:config.zone,machine:"e2-micro",disk:"pd-standard",ipv4:false,ipv6:true,providerScheduling:vm.scheduling,costProtection:"requires fresh billing/free-tier evidence; not a hard cap"}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("Standby command failed; no cloud success is claimed. Check the same account, project and VM via gcloud; do not provision a duplicate or paid fallback.");process.exitCode=1;});
