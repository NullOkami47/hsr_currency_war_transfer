import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGcsBackupClient} from './gcs-backup.mjs';
import {readMonitorSnapshot} from './azure-blob-backup.mjs';

export async function notifyBackupFailure({config,recordStatus,readMonitor=readMonitorSnapshot}) {
  const unknown=()=>({status:'skipped',transportVerified:false,restoreVerified:false});
  const snapshot=await readMonitor({service:config.service,recovered:false});
  return recordStatus({result:'failure',stage:'coordinator',mode:'scheduled',perDest:{azure:unknown(),gcs:unknown()},snapshot});
}
async function main(){
  if(process.platform!=='linux'||process.getuid?.()!==0||process.argv.length!==2)throw new Error('Root and fixed configuration required');
  const path='/etc/hsr-backup/backup.json',st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o077))throw new Error('Protected configuration required');
  const config=JSON.parse(await readFile(path,'utf8')),client=createGcsBackupClient({config,timeoutMs:30000});
  console.log(JSON.stringify(await notifyBackupFailure({config,recordStatus:client.recordStatus})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Failure notification could not be exported; independent missed-schedule monitoring remains required.');process.exitCode=1;});
