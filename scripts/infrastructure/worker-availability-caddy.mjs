import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Produces a reviewable candidate only. Never installs or reloads Caddy. */
export function buildAvailabilityCaddy(baseline,expectedSha256) {
 if(typeof baseline!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256)
   ||createHash('sha256').update(baseline).digest('hex')!==expectedSha256)throw Error('Caddy baseline hash mismatch');
 if(baseline.includes('/_hsr/availability'))throw Error('An existing availability route requires manual review');
 const anchor='    @authorised header Authorization "Bearer {$HSR_GCP_WORKER_TOKEN}"';
 if(baseline.split(anchor).length!==2||baseline.split('worker.35-223-56-40.sslip.io {').length!==2)throw Error('Ambiguous production Caddy route');
 return baseline.replace(anchor,'    handle /_hsr/availability {\n        reverse_proxy 127.0.0.1:8790 {\n            transport http {\n                dial_timeout 1s\n                response_header_timeout 3s\n            }\n        }\n    }\n'+anchor);
}

async function main(){
 const [input,hash,output,...extra]=process.argv.slice(2);
 if(!input||!hash||!output||extra.length||resolve(input)===resolve(output))throw Error('Usage: input expected-sha256 new-output');
 const candidate=buildAvailabilityCaddy(await readFile(input,'utf8'),hash);
 await writeFile(output,candidate,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({candidateWritten:true,sha256:createHash('sha256').update(candidate).digest('hex'),installed:false,reloaded:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
