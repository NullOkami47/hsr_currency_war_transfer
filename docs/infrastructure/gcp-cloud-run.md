# GCP migration implementation and validation

Date: 2026-11-12 (Asia/Hong_Kong).

## Current decision

GCP is the selected provider. `CLOUD_RUN_BLOCKED`: financial protection and cloud runtime acceptance are incomplete. No Cloud Run service, Compute Engine instance, database, bucket or registry was provisioned by this task. Azure remains the approved production fallback. Oracle and Uppcoder results remain historical; no further experiments there are planned.

## Actual source and compatibility constraints

The migration branch retains the existing browser-channel/executable overrides. It merged main `7dfc705` via `39898a383158af55b4eca4221b546daf171a571b`, preserving the recent spotlight transformation and verification fixes. The current worker responds to submissions and drains an in-process queue after the response; its jobs, mappings and security ledger are separate local JSON files. `TransferJobQueue.start()` requeues recoverable work. A local file lock protects transfers on one filesystem, not across disposable instances.

A direct deployment of `scripts/worker-server.mjs` to request-billed Cloud Run is not accepted: background CPU after response, ephemeral files, overlapping revisions, profile locking and ambiguous upstream writes are unresolved. Maximum instances 1 alone is not an exclusive distributed lock.

Google documents headless Playwright and interactive desktop/VNC streaming on Cloud Run, but that is platform capability, not proof that this application's authenticated lifecycle works. Sources: https://docs.cloud.google.com/run/docs/browser-automation and https://docs.cloud.google.com/run/docs/configuring/billing-settings.

## Implemented synthetic compatibility gate

- `scripts/infrastructure/gcp-browser-probe.mjs`: GET `/health`; bearer-protected, empty-body POST `/probe`; no `/jobs`, no user-supplied URLs, no production publisher imports.
- Creates a fresh temporary synthetic profile; explicitly requests Chromium sandbox; runs as non-root Linux; verifies a fixed page and a synthetic cookie across two browser launches; closes and deletes the profile before reporting success.
- Simultaneous probes receive 429; failures return a redacted 503. The gate has no durable state or distributed ownership and is not a publishing worker.
- `scripts/infrastructure/Dockerfile.gcp-probe`: official Node 24.18.0 Debian base, package-lock installation, official Playwright browser/dependencies, non-root runtime. No privileged flags or `--no-sandbox` fallback.
- `.dockerignore` allows only the manifest, lockfile and probe source/Dockerfile. Real profiles, credentials and production state are excluded from build context.
- Browser request interception is diagnostic hygiene, not a network firewall. The probe opens only synthetic content, and Chromium background networking may still occur. Never place real sessions into this image.

Build when Docker is available:

```sh
docker build -f scripts/infrastructure/Dockerfile.gcp-probe -t hsr-gcp-probe .
```

Use a newly generated ephemeral `HSR_PROBE_TOKEN` (32–256 characters), supplied through approved secret delivery. Do not put it on a public command line or commit it. Restrict local published ports to loopback. `/probe` returns browser version, two-launch count and Node RSS; Node RSS does **not** measure the full browser process tree. Docker build and real Cloud Run container launch are currently unverified. A sandbox launch failure is a blocker, never a reason to disable sandboxing.

## Subsequent implementation sequence (not completed)

1. Confirm actual dedicated project ID and active billing linkage; complete gross/net budgets and Cloud Run spend cap. Resolve the cash-charge/credit-order stop condition before billable work.
2. Verify the exact container on GCP using synthetic inputs only: startup, TLS, IAM plus bearer auth, resource/memory peak, cold start, interruption and cleanup. Candidate region `us-central1`; not a selected or deployed region yet. Minimum instances 0, maximum 1, concurrency 1, request-based billing, bounded timeout; size only from measurement. No NAT, public load balancer or fixed IP.
3. Implement a compatible API adapter backed by transactional durable jobs, quota/security state and mapping records. Prefer Firestore and Cloud Tasks only after checking their costs and permissions. Task acknowledgement must follow durable completion, not an in-memory enqueue. Use a transactional outbox or equivalent repair path for commit/enqueue failures.
4. Add account-level exclusive ownership with fencing and a publish-intent journal. A lease expiry cannot prevent a paused old browser from sending an external request; do not automatically hand off an ambiguous in-flight publish. Mark it reconciliation-required and block further account writes until read-only reconciliation proves the result. Never blindly retry upstream creation after timeout/crash. Exactly-once external writes are not guaranteed by Firestore transactions.
5. Fresh interactive login: short-lived IAM-protected admin interface, explicit session expiry and MFA. No public CDP/VNC. Acquire the same exclusive account ownership as publishing. Close Chrome before encrypted/versioned profile snapshot; restore to private ephemeral storage before exclusive use. A mounted object bucket is not a lock-safe Chrome filesystem. Validate device/session continuity across replacement and corruption handling. Never import Azure cookies/profile.
6. Implement and test profile snapshot generation checks, stale-owner rejection, incomplete-upload handling, revocation state, job/quota consistency, recovery and admin APIs. Separate administrator, worker and dispatch identity. No real account use in Box.
7. Run two real read-only authenticated calls, restart and repeat. Then obtain explicit permission for one approved live strategy, re-fetch/compare data and verify duplicate handling. Only after all gates pass prepare cutover GO.

These are concrete remaining implementation gates, not claims of deployed persistence or working login. Cloud Run is not yet rejected technically. Compute Engine has not been evaluated/provisioned further because Cloud Run's critical runtime requirements have not yet failed; switching providers does not resolve the current financial stop.

## Safe deployment, monitoring and rollback boundary

Production remains Vercel plus the existing Azure worker. Do not change `CURRENCY_WAR_WORKER_URL` or its bearer secret until GO. Staging must use separate secrets and synthetic stores. Preserve existing admin security/session-revocation/CSRF/TOTP contracts.

Before cutover: drain submissions, account for queued/running jobs, protect and hash a consistent backup of jobs/mappings/security state, reconcile ambiguous publishes, import state transactionally, validate counts and quota windows, then activate only one publishing owner. Fresh target login only. Keep Azure and its recovery configuration intact.

After GO: change only approved production worker endpoint/secret, test public submissions and `/admin`, monitor queue age, authentication failures, duplicate outcomes, browser failures and billing. Rollback after target writes requires reverse reconciliation/import of new mappings, job and quota/security state before Azure resumes; never restart stale state. Azure decommission is a separate approval.

No rollback rehearsal, live authentication, durable cloud state test or production cutover has occurred.

### GCP independent probe result

The new probe ran successfully on Box from clean checkout `0215ef5acaebe0c57e9a2fb1364cbd96be1c83dc`: Chrome157.0.8103.38, two sandbox-requested launches and synthetic cookie close/reopen persistence; full Linux suite247/247. This was JavaScript against Box Chrome, not an image build or Cloud Run deployment. See the GCP verification record for commands and limits.

The compatibility gate has a 60-second overall deadline in addition to launch timeouts. On deadline it fails closed and the executable exits1; container termination must clean up any remaining browser processes. It never admits another browser after a timeout. This failure path requires a real container restart test before cloud acceptance.
