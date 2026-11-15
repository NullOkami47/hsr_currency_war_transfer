import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,chown,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRestartFile} from '../scripts/infrastructure/restart-control-state.mjs';

test('root preflight configuration accepts only its explicit read-only worker group',{
 skip:process.platform!=='linux'||process.getuid?.()!==0,
},async t=>{
 const root=await mkdtemp(join(tmpdir(),'hsr-restart-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'preflight.json');await writeFile(file,'{"version":1}',{mode:0o640});await chown(file,0,65534);
 const options={owner:0,readOnlyGroup:65534};
 assert.equal(await readRestartFile(file,options),'{"version":1}');
 await assert.rejects(readRestartFile(file,{owner:0}));
 await assert.rejects(readRestartFile(file,{owner:0,readOnlyGroup:65533}));
 for(const mode of [0o660,0o644,0o641,0o2640]){await chmod(file,mode);await assert.rejects(readRestartFile(file,options));}
 await chmod(file,0o640);await chown(file,65534,65534);await assert.rejects(readRestartFile(file,options));
 await chown(file,0,65534);const link=join(root,'link');await symlink(file,link);await assert.rejects(readRestartFile(link,options));
});
