import test from 'node:test';
import assert from 'node:assert/strict';
import {notifyBackupFailure} from '../scripts/infrastructure/backup-failure-notify.mjs';
test('backup failure notification never represents skipped destinations as verified or starts recovery',async()=>{
  let event;
  await notifyBackupFailure({config:{service:'example.service'},readMonitor:async input=>{assert.equal(input.recovered,false);return {journal:{phase:'stopping',originalAdmission:true}};},recordStatus:async value=>{event=value;return {status:'success'};}});
  assert.equal(event.result,'failure');
  for(const v of Object.values(event.perDest)){assert.equal(v.status,'skipped');assert.equal(v.transportVerified,false);}
  assert.equal(event.snapshot.journal.phase,'stopping');
});
