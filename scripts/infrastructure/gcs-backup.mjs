import { createHash, randomUUID } from 'node:crypto';
import { boundedRequest, managedIdentityToken, validateEncryptedBackup } from './azure-blob-backup.mjs';

export const GCS_BUCKET='hsr-worker-backups-282550645630';
export const GCS_AUDIENCE='//iam.googleapis.com/projects/282550645630/locations/global/workloadIdentityPools/hsr-azure-backup/providers/azure-vm';
const STS='https://sts.googleapis.com/v1/token';
const TOKEN_TYPE='urn:ietf:params:oauth:token-type:access_token';
const PHASES=new Set(['prepared','closing_admission','draining','stopping','stopped','snapshotting','starting','restoring_admission','complete']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function failure(code,message) {const error=new Error(message);error.code=code;return error;}

// No keys, credential paths, alternate endpoints or arbitrary destinations are accepted.
// The deployed provider binds tenant c01f176e-0e1f-436b-bba2-69960d035166 (issuer with trailing slash)
// and MI subject/oid dca98784-4e77-461d-a956-8be8beee4596. STS verifies the Azure JWT.
export function validateGcsConfiguration(config) {
  const gcs=config?.gcs;
  if (gcs===undefined) return false;
  if (!gcs || typeof gcs!=='object' || Array.isArray(gcs) || typeof gcs.enabled!=='boolean'
      || Object.keys(gcs).some(k=>!['enabled','bucket','audience'].includes(k))
      || (gcs.bucket!==undefined&&gcs.bucket!==GCS_BUCKET) || (gcs.audience!==undefined&&gcs.audience!==GCS_AUDIENCE)) throw failure('GCS_CONFIG','Invalid GCS destination configuration');
  return gcs.enabled;
}

// Each delivery has one absolute deadline; retries never reset it. A separate bounded
// status budget allows a failed/timed-out delivery to report its outcome.
function budget(timeoutMs,shouldAbort) {
  if (!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>240000) throw failure('GCS_CONFIG','Invalid GCS deadline configuration');
  const end=performance.now()+timeoutMs;
  return {
    remaining() {
      if (shouldAbort()) throw failure('GCS_INTERRUPTED','Backup interrupted');
      const left=Math.ceil(end-performance.now());
      if (left<=0) throw failure('GCS_DEADLINE','GCS deadline exceeded');
      return left;
    },
    async wait(operation,limit) {
      const left=Math.min(this.remaining(),limit);let timer;
      try {return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('GCS_DEADLINE','GCS deadline exceeded')),left);})]);}
      finally {clearTimeout(timer);}
    },
  };
}
async function retryRequest(request,url,options,clock) {
  for(let attempt=0;attempt<3;attempt++) {
    clock.remaining();
    try {
      const timeoutMs=Math.min(clock.remaining(),options.timeoutMs??60000);
      const response=await clock.wait(()=>request(url,{...options,timeoutMs}),timeoutMs);
      clock.remaining();
      if (!Number.isInteger(response?.status)||!Buffer.isBuffer(response.body)||response.body.length>options.maxBytes) throw failure('GCS_TRANSPORT','Invalid bounded GCS response');
      if (response.status!==408&&response.status!==429&&response.status<500) return response;
    } catch(error) {
      if (error.code==='GCS_INTERRUPTED'||error.code==='GCS_DEADLINE') throw error;
    }
    if (attempt===2) throw failure('GCS_TRANSPORT','GCS transport retries exhausted');
    await clock.wait(()=>new Promise(resolve=>setTimeout(resolve,100*(attempt+1))),300);
  }
}

function statusEvent({result,stage,mode,perDest,snapshot}) {
  const final=result==='success'?'success':'failure';
  const destinations={};
  for (const name of ['azure','gcs']) {
    const state=perDest?.[name]?.status;
    destinations[name]={status:['success','failure','skipped'].includes(state)?state:'skipped',transportVerified:state==='success',restoreVerified:false};
  }
  return {version:1,runId:randomUUID(),at:new Date().toISOString(),result:final,
    stage:['coordinator','validation','delivery','complete'].includes(stage)?stage:'coordinator',mode:mode==='resend'?'resend':'scheduled',perDest:destinations,
    snapshot:{runStatus:final,workerHealth:snapshot?.workerHealth==='confirmed'?'confirmed':'unknown',
      admission:typeof snapshot?.admission==='boolean'?snapshot.admission:'unknown',
      journal:{phase:PHASES.has(snapshot?.journal?.phase)?snapshot.journal.phase:'unknown',
        originalAdmission:typeof snapshot?.journal?.originalAdmission==='boolean'?snapshot.journal.originalAdmission:null}},
    restoreVerified:false};
}

// One client per run caches only a short-lived federated access token (including an
// authentication rejection). It never writes a token, key, plaintext or directory copy.
export function createGcsBackupClient({config,request=boundedRequest,shouldAbort=()=>false,timeoutMs=180000}) {
  if (!validateGcsConfiguration(config)) throw failure('GCS_CONFIG','GCS configuration must be explicitly enabled');
  budget(timeoutMs,shouldAbort);
  let authentication;
  const authenticate=clock=>authentication??=(async()=>{
    try {
      const subject=await managedIdentityToken({request:(url,options)=>retryRequest(request,url,options,clock)});
      const body=new URLSearchParams({audience:GCS_AUDIENCE,grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type:TOKEN_TYPE,subject_token_type:'urn:ietf:params:oauth:token-type:jwt',subject_token:subject,
        scope:'https://www.googleapis.com/auth/devstorage.read_write'}).toString();
      const response=await retryRequest(request,STS,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,timeoutMs:10000,maxBytes:65536},clock);
      if (response.status!==200) throw failure('GCS_AUTH','GCS federation unavailable');
      const value=JSON.parse(response.body.toString('utf8'));
      if (value.token_type!=='Bearer'||value.issued_token_type!==TOKEN_TYPE||!Number.isInteger(value.expires_in)||value.expires_in<1||value.expires_in>3600
          || typeof value.access_token!=='string'||!/^[\x21-\x7e]{1,16384}$/.test(value.access_token)) throw failure('GCS_AUTH','Invalid GCS federation response');
      return value.access_token;
    } catch(error) {
      if (error.code==='GCS_DEADLINE'||error.code==='GCS_INTERRUPTED') throw error;
      throw failure('GCS_AUTH','GCS federation unavailable');
    }
  })();
  async function immutable(name,bytes,token,clock) {
    const headers={authorization:`Bearer ${token}`};
    const readUrl=`https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(name)}?alt=media`;
    // Error JSON for a missing object may be larger than a small receipt/marker.
    const readOptions={method:'GET',headers,timeoutMs:60000,maxBytes:Math.max(bytes.length,65536)};
    const matches=response=>response.status===200&&response.body.length===bytes.length&&digest(response.body)===digest(bytes);
    // Known-name readback avoids needing overwrite/delete permission for an existing
    // baseline (including a held object). This is never a bucket listing.
    const existing=await retryRequest(request,readUrl,readOptions,clock);
    if (existing.status===200) {
      if (!matches(existing)) throw failure('GCS_CHECKSUM','GCS read-back checksum collision or mismatch');
      return;
    }
    if (existing.status!==404) throw failure('GCS_READ','GCS existing-object read failed');
    const upload=new URL(`https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o`);
    upload.search=new URLSearchParams({uploadType:'media',name,ifGenerationMatch:'0'}).toString();
    const response=await retryRequest(request,upload.href,{method:'POST',headers:{...headers,'content-type':'application/json','content-length':String(bytes.length)},body:bytes,timeoutMs:60000,maxBytes:65536},clock);
    if (![200,201,412].includes(response.status)) throw failure('GCS_UPLOAD','GCS immutable upload failed');
    // A 412 is success only if the existing bytes match exactly. Never overwrite/delete.
    const readback=await retryRequest(request,readUrl,readOptions,clock);
    if (!matches(readback)) throw failure('GCS_CHECKSUM','GCS read-back checksum collision or mismatch');
  }
  return {
    async deliver(snapshot) {
      const clock=budget(timeoutMs,shouldAbort);
      const {name,ciphertext,receiptBytes,receipt}=await validateEncryptedBackup({config,snapshot});
      const token=await authenticate(clock);
      await immutable('hsr-state/'+name,ciphertext,token,clock);
      await immutable('hsr-state/'+name.replace(/\.enc\.json$/,'.receipt.json'),receiptBytes,token,clock);
      clock.remaining();
      return {transportVerified:true,restoreVerified:false,createdAt:receipt.createdAt,sha256:receipt.sha256,bucket:GCS_BUCKET,objectPrefix:'hsr-state/'};
    },
    async recordStatus(state) {
      // Reporting interruption is allowed; state delivery still honours shouldAbort.
      const clock=budget(Math.min(timeoutMs,30000),()=>false),event=statusEvent(state);
      const token=await authenticate(clock),name=`monitor/events/${event.at.replace(/[:.]/g,'-')}-${event.runId}.json`;
      await immutable(name,Buffer.from(JSON.stringify(event)+'\n'),token,clock);
      return {status:'success',transportVerified:true,object:name};
    },
  };
}
