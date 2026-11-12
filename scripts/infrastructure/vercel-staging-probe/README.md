# Vercel Preview staging connectivity probe

This directory is a standalone, dependency-free Vercel Node.js 24 project.
`api/probe.mjs` is an actual Function entry point using runtime `fetch`, not
a script that simulates Vercel. No deployment is performed by this change.

## Isolation and future deployment

Use a **separate Preview project**, with this directory as its project root:
`scripts/infrastructure/vercel-staging-probe`. Keep it separate from the main
application's Vercel project. Do not deploy or promote it to Production, use
`--prod`, connect the production application's domains, or reuse production
credentials/state. Future deployment requires separate authorisation. The
handler also refuses to run unless Vercel sets `VERCEL_ENV=preview`.

When creating that project later, select Other/no framework, Node.js 24,
no build command and no output directory override. The nested `vercel.json`
sets this Function's `maxDuration` to 60 seconds and enables request cancellation
with `supportsCancellation: true`; the root app's Vercel config
is unrelated. No cron, public custom rate limiter or CI/deploy workflow is
added. Caller authentication is required for this isolated Preview endpoint.

Set the following environment variables **only in that project's Preview
environment** through the approved secret mechanism. Do not commit `.env`
files, credentials, environment exports, platform link metadata or responses
containing worker state. The two tokens should be distinct randomly generated
values of at least 32 printable non-whitespace ASCII characters.

| Variable | Meaning |
| --- | --- |
| `HSR_STAGING_ORIGIN` | Approved ephemeral staging endpoint, exactly `https://gcp-staging.<IPv4>.sslip.io`, with an optional trailing `/`. |
| `HSR_STAGING_WORKER_TOKEN` | Secret bearer token belonging to the synthetic staging worker. |
| `HSR_STAGING_PROBE_KEY` | Secret bearer key required from the probe caller. |

`<IPv4>` must be canonical decimal IPv4 with publicly routable octets. The
handler rejects private, loopback, link-local/metadata, shared, documentation,
benchmark, multicast and reserved ranges; other hostname labels/suffixes,
HTTP, userinfo, ports (including explicit `:443`), paths, query strings and
fragments are rejected before any upstream request. The origin comes only
from the approved environment, never from caller input. Use a valid public
TLS certificate for that exact staging hostname. There is no TLS bypass.

## Invocation and checks

After an authorised Preview deployment, send **POST `/api/probe`** with
`Authorization: Bearer <HSR_STAGING_PROBE_KEY>` and an **empty body**. Do not
send `{}`, `null`, whitespace, a source ID or an origin. Use your approved
secret-aware client; do not put real keys in repository files or shell history.
Caller query parameters are never used for upstream targeting or payloads.
Unauthenticated callers receive 401 without any upstream request. Authenticated
non-POST calls receive 405. Nonempty bodies receive 400.
Emptiness is checked against the raw request bytes; an empty JSON/form request
is accepted even without a `Content-Length` header. Parsed `request.body`
helpers are never used to decide whether the original input was empty.

The fixed sequence is:

1. `GET /health` without credentials. Require HTTP 200, `status === "ok"`
   **and** `mode === "hsr-synthetic-worker"`. Failure stops all job POSTs,
   including the negative authentication checks.
2. `POST /jobs` with no worker token; require exactly HTTP 401.
3. `POST /jobs` with a freshly generated wrong token; require exactly HTTP 401.
4. `POST /jobs` with the staging worker token. All three POSTs use the same
   freshly generated 24-character hexadecimal synthetic `sourceId` and fixed
   `clientKey`. Require HTTP 202, `status === "queued"` and a safe `jobId`.
5. Poll `GET /jobs/<jobId>` with the worker token. Require HTTP 200 and the
   same job ID. Success requires `status === "created"` and the result's
   `synthetic === true`. The current worker flattens its stored result into
   the HTTP response; a nested `result.synthetic` response is also accepted.
   Only `queued` continues polling; failed, partial, malformed or foreign
   responses fail closed.

Every upstream request uses `redirect: "manual"`; all 3xx responses fail,
including redirects on health and either negative auth check. Secrets are
never forwarded to a redirect destination. Requests time out after 5 seconds,
including JSON response body reading. The complete handler has a 45-second
budget including input reading, requests and delays. There are at most eight
polls, with a one-second interruptible delay between polls. The 45-second
deadline takes priority over the poll count.

Timeouts, caller disconnections and interrupted work never produce success.
There is no automatic retry of job creation. An already submitted synthetic
job may still complete after the caller disconnects or the probe times out;
the probe does not claim to cancel or roll back remote work.

## Response contract

The response is always marked `Cache-Control: no-store`. Its fields are:

| Field | Allowed contents |
| --- | --- |
| `ok` | Boolean; true only after every check succeeds. |
| `status` | A fixed probe status such as `passed`, `health_rejected`, `job_rejected`, `redirect_rejected`, `interrupted`, `timed_out` or `poll_exhausted`. |
| `startedAt`, `finishedAt` | Probe-generated ISO timestamps. |
| `checks` | Booleans for health, missing/wrong-token rejection, created and synthetic. |
| `upstream` | Observed HTTP status codes for `health`, `missingToken`, `wrongToken`, `create` and the last `poll`; unreached steps are omitted. |

HTTP 200 means all checks passed; 400/401/403/405 identify input, auth or
Preview guard rejection; 408 means interruption; 503 means invalid/missing
configuration; 502 means an upstream/protocol failure; 504 means timeout or
poll exhaustion. Responses contain no upstream JSON, hostnames, source/job
IDs, share codes, state markers, tokens or error messages. The Function does
not log those values.

## Local unit verification

From the repository root on D drive:

```powershell
node --check scripts/infrastructure/vercel-staging-probe/api/probe.mjs
node --test test/vercel-staging-probe.test.mjs
```

Tests invoke the real handler with **mocked fetch** and synthetic credentials.
They also invoke its default Vercel export, verify the standalone project
configuration, and use mocked timers for 5/45-second deadline cases. They
make no upstream requests. Passing them does **not** prove deployment, real
Vercel egress, DNS, TLS, firewall configuration or live worker connectivity.
Only a separately authorised run from an actual Vercel Preview deployment
can establish those facts. Simular Box was unavailable in this implementation
session (no callable Box execution capability), so verification uses local
Windows/Node; no repository or credentials were uploaded to a third party.
