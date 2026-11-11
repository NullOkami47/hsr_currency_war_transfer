import assert from "node:assert/strict";
import test from "node:test";
import { validateStandbyConfig, validateStandbyInstance, startStandby } from "../scripts/infrastructure/gcp-standby.mjs";
const config={account:"operator@example.invalid",project:"hsr-staging-123",zone:"us-central1-a",instance:"hsr-worker-standby",maxRunSeconds:3600};
const vm={name:config.instance,status:"TERMINATED",machineType:"zones/us-central1-a/machineTypes/e2-micro",labels:{purpose:"hsr-worker-standby",mode:"synthetic"},scheduling:{instanceTerminationAction:"STOP",maxRunDuration:{seconds:"3600"}},networkInterfaces:[{stackType:"IPV4_IPV6",accessConfigs:[],ipv6AccessConfigs:[{externalIpv6:"2600:1900::1234"}]}],disks:[{boot:true,type:"PERSISTENT",diskSizeGb:"30"}]};
test("standby configuration refuses non-free regions, wrong resources and unbounded experiments",()=>{
  assert.doesNotThrow(()=>validateStandbyConfig(config));
  for(const patch of [{zone:"asia-east1-a"},{maxRunSeconds:0},{maxRunSeconds:7201},{instance:"../../production"}])assert.throws(()=>validateStandbyConfig({...config,...patch}));
});
test("actual VM preflight refuses paid machine shapes, external IPv4 and non-synthetic resources",()=>{
  assert.doesNotThrow(()=>validateStandbyInstance(config,vm));
  for(const patch of [{machineType:"zones/us-central1-a/machineTypes/e2-small"},{labels:{}},{networkInterfaces:[{accessConfigs:[{natIP:"192.0.2.1"}]}]}])assert.throws(()=>validateStandbyInstance(config,{...vm,...patch}));
});
test("start requires fresh budget/free-tier evidence, provider-side STOP and separately enabled staging authority",async()=>{
  const calls=[];const run=async args=>{calls.push(args);return vm;};
  await assert.rejects(startStandby({config,run}),/authoris/);
  await assert.rejects(startStandby({config,run,authorised:true}),/cost|free-tier/i);
  assert.equal(calls.length,0);
});
test("start configures and reads back provider STOP before starting and verifies RUNNING",async()=>{
  const calls=[];let describes=0;
  const run=async args=>{calls.push(args);if(args.includes("describe")){describes++;return {...vm,status:describes>2?"RUNNING":"TERMINATED"};}return {};};
  const now=new Date();
  const result=await startStandby({config:{...config,costEvidence:{verifiedAt:now.toISOString(),freeTierAvailable:true,budgetsVerified:true}},run,authorised:true,now:()=>now});
  assert.equal(result.status,"RUNNING");
  assert.ok(calls[1].includes("set-scheduling"));assert.ok(calls[1].includes("--instance-termination-action=STOP"));
  assert.ok(calls[3].includes("start"));
});
test("missing provider STOP readback cannot launch a VM",async()=>{
  const calls=[];let count=0;const now=new Date();
  const run=async args=>{calls.push(args);return ++count===1?vm:{...vm,scheduling:{}};};
  await assert.rejects(startStandby({config:{...config,costEvidence:{verifiedAt:now.toISOString(),freeTierAvailable:true,budgetsVerified:true}},run,authorised:true,now:()=>now}),/STOP|limit/);
  assert.ok(!calls.some(args=>args.includes("start")));
});
