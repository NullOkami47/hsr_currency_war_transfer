import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const PHASES = new Set(['prepared','closing_admission','draining','stopping','stopped','snapshotting','starting','restoring_admission','complete']);
async function secureDirectory(directory) {
  const stat=await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Protected control directory required');
}
async function readRecord(directory,name) {
  await secureDirectory(directory);
  const path=join(directory,name); let file;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Control record symlink forbidden');
    file=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat=await file.stat();
    if (!stat.isFile() || stat.size>16384 || (process.platform !== 'win32' && (stat.uid!==process.getuid() || (stat.mode & 0o077)))) throw new Error('Invalid control record');
    return JSON.parse(await file.readFile('utf8'));
  } catch(error) { if(error.code==='ENOENT') return null; throw error; }
  finally { if(file) await file.close(); }
}
async function durableWrite(directory,name,value) {
  await secureDirectory(directory);
  const temp=join(directory,`.${name}.${randomUUID()}.tmp`); let handle;
  try {
    handle=await open(temp,'wx',0o600);
    await handle.writeFile(JSON.stringify(value)+'\n'); await handle.sync(); await handle.close(); handle=null;
    await rename(temp,join(directory,name));
    if (process.platform !== 'win32') { const dir=await open(directory,'r'); try {await dir.sync();} finally {await dir.close();} }
  } finally { if(handle) await handle.close(); try {await unlink(temp);} catch(error) {if(error.code!=='ENOENT') throw error;} }
}
export function createJournal({directory,service}) {
  let record;
  async function check() {
    const old=await readRecord(directory,'journal.json');
    if (old===null) return;
    if (old.version!==1 || old.service!==service || typeof old.originalAdmission!=='boolean' || !PHASES.has(old.phase)
        || typeof old.runId!=='string' || typeof old.updatedAt!=='string') throw new Error('Invalid journal; manual reconciliation required');
    if(old.phase!=='complete') throw new Error('Unfinished journal; manual reconciliation required');
  }
  return {
    check,
    async begin(originalAdmission) {
      if(typeof originalAdmission!=='boolean' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(service)) throw new Error('Invalid journal data');
      await check();
      record={version:1,runId:randomUUID(),service,originalAdmission,phase:'prepared',updatedAt:new Date().toISOString()};
      await durableWrite(directory,'journal.json',record);
    },
    async phase(phase) {
      if(!record || !PHASES.has(phase) || phase==='prepared' || phase==='complete') throw new Error('Invalid journal phase');
      record={...record,phase,updatedAt:new Date().toISOString()}; await durableWrite(directory,'journal.json',record);
    },
    async complete() {
      if(!record || record.phase!=='restoring_admission') throw new Error('Recovery was not verified');
      record={...record,phase:'complete',updatedAt:new Date().toISOString()}; await durableWrite(directory,'journal.json',record);
    },
  };
}
export function createStatusStore({directory}) {
  let state;
  return {
    async start(at) {
      const previous=await readRecord(directory,'status.json');
      if(previous!==null && (previous.version!==1 || !['running','success','failure'].includes(previous.result))) throw new Error('Invalid status record');
      state={version:1,result:'running',lastAttemptAt:at,lastSuccessAt:previous?.lastSuccessAt ?? null,lastFailureAt:previous?.lastFailureAt ?? null,stage:'coordinator',workerHealth:'unknown',transportVerified:false,restoreVerified:false};
      await durableWrite(directory,'status.json',state);
    },
    async recovered() { if(!state)throw new Error('Status not started'); state={...state,stage:'delivery',workerHealth:'confirmed'}; await durableWrite(directory,'status.json',state); },
    async success(at) { if(!state)throw new Error('Status not started'); state={...state,result:'success',lastSuccessAt:at,stage:'complete',workerHealth:'confirmed',transportVerified:true}; await durableWrite(directory,'status.json',state); },
    async failure(at,stage,workerHealth) { if(!state)throw new Error('Status not started'); if(!['coordinator','delivery'].includes(stage)||!['unknown','confirmed'].includes(workerHealth)) throw new Error('Invalid status failure'); state={...state,result:'failure',lastFailureAt:at,stage,workerHealth,transportVerified:false}; await durableWrite(directory,'status.json',state); },
  };
}
