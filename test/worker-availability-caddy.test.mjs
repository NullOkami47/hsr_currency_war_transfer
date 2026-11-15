import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {buildAvailabilityCaddy} from '../scripts/infrastructure/worker-availability-caddy.mjs';

const baseline='worker.35-223-56-40.sslip.io {\n    @authorised header Authorization "Bearer {$HSR_GCP_WORKER_TOKEN}"\n    handle @authorised {\n        reverse_proxy 127.0.0.1:8787\n    }\n    handle {\n        respond "Unauthorised" 401\n    }\n    header -Server\n}\n';
const sha=value=>createHash('sha256').update(value).digest('hex');
test('adds one exact health route while preserving bearer and deny routes byte for byte',()=>{
 const value=buildAvailabilityCaddy(baseline,sha(baseline));
 const addition='    handle /_hsr/availability {\n        reverse_proxy 127.0.0.1:8790 {\n            transport http {\n                dial_timeout 1s\n                response_header_timeout 3s\n            }\n        }\n    }\n';
 assert.equal(value.replace(addition,''),baseline);
 assert.equal(value.split(addition).length,2);
 assert.ok(value.indexOf(addition)<value.indexOf('    @authorised'));
 assert.equal(value.includes('/_hsr/availability*'),false);
});
test('rejects baseline drift, duplicate routes and ambiguous insertion',()=>{
 assert.throws(()=>buildAvailabilityCaddy(baseline+'# drift',sha(baseline)),/hash/i);
 const duplicate=baseline+'# /_hsr/availability';
 assert.throws(()=>buildAvailabilityCaddy(duplicate,sha(duplicate)),/existing/i);
 const ambiguous=baseline+baseline;
 assert.throws(()=>buildAvailabilityCaddy(ambiguous,sha(ambiguous)),/ambiguous/i);
});
