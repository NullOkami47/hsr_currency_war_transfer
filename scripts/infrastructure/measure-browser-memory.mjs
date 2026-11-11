import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { probeBrowser } from "./gcp-browser-probe.mjs";
const run=promisify(execFile);
if(process.platform!=="linux")throw new Error("Linux process-tree sampling required");
let peakTreeRssBytes=0,samples=0,peakProcesses=0,stopped=false;
async function sample(){
  const {stdout}=await run("ps",["-e","-o","pid=,ppid=,rss="],{timeout:5000,maxBuffer:2*1024*1024});
  const rows=stdout.trim().split("\n").map(line=>line.trim().split(/\s+/).map(Number));
  const pids=new Set([process.pid]);let changed;
  do{changed=false;for(const[pid,ppid]of rows)if(pids.has(ppid)&&!pids.has(pid)){pids.add(pid);changed=true;}}while(changed);
  const matching=rows.filter(([pid])=>pids.has(pid));
  peakTreeRssBytes=Math.max(peakTreeRssBytes,matching.reduce((sum,[,,rss])=>sum+rss*1024,0));
  peakProcesses=Math.max(peakProcesses,matching.length);samples++;
}
const loop=(async()=>{while(!stopped){await sample();await new Promise(resolve=>setTimeout(resolve,100));}})();
let result;
try{result=await probeBrowser();}
finally{stopped=true;await loop;}
console.log(JSON.stringify({...result,peakSampledProcessTreeRssBytes:peakTreeRssBytes,peakProcesses,samples,samplingIntervalMs:100,rssCaveat:"Sum of RSS double-counts shared pages and sampling can miss peaks; this is not cgroup memory. Record GCP memory.peak and OOM events separately.",meminfo:await readFile("/proc/meminfo","utf8")}));
