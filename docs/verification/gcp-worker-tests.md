# GCP worker verification

Date: 2026-11-12 (Asia/Hong_Kong). **E2E_PENDING; PRODUCTION_CUTOVER_BLOCKED.**

## Source and changes

Resumed `codex/free-worker-migration` / Draft PR #5 at `5e9fd2e9a8e2196742ab0e66983b7e1042cf59cb`. Merged current main `7dfc705` using merge commit `39898a383158af55b4eca4221b546daf171a571b`; no reset. Applied slow-store test fix from isolated subagent commit `930b69a5793ae6b7a3e2201ef08b181e8e0f9d5e` as `24fbdd2`. Only the needed test file was cherry-picked.

The first duplicate test formerly waited at most twenty 2ms sleeps before asserting transfer entry. It now waits for an explicit bounded signal; a one-second delayed running-state store update exercises that boundary, and cleanup waits for queue drain. This is a test timing repair, not a production queue change. Final call-count assertion still verifies one transfer.

## Local synthetic checks

Windows, Node24.18.0. `node --test test/gcp-browser-probe.test.mjs` was run before implementation and failed with missing-module error; after implementation four tests passed. These tests exercise real loopback HTTP admission with an injected synthetic probe, not real Chrome.

`npm test` after integration: **247 total; 246 passed; 0 failed; 1 existing POSIX-only skip**, exit0. Evidence: `D:/CodexWork/free-worker-migration-evidence/gcp/local-tests.txt`. At that point the base was `24fbdd2` plus the uncommitted probe files; exact committed-source independent verification is recorded below when run.

Covered: token rejection, no browser on health/invalid route/input, concurrent probe429, redacted browser errors and admission recovery, full existing application/security/transfer suite. Browser selection changes from the previous migration remain intact.

## Browser and deployment evidence limits

A real official Box CLI read returned Linuxx86_64, non-root uid1000, Node24.21.0, npm11.19.0, Google Chrome157.0.8103.38. Docker was not found by `command -v docker`; no container build success is claimed. Native MCP approval is not required for this task's CLI verification path.

GCP project access has not been verified, and the financial stop condition is active. No Cloud Run container, TLS endpoint, IAM integration, Firestore/Tasks storage, cold-start/replacement recovery, real HoYoLAB login, MFA, live transfer or migration has been tested. The new probe's synthetic cookie across browser restarts does not prove profile survival across container replacement.

Account evidence: actual ChingG badge, active paid billing overview, initial credits, linked project, and saved account warning were read. Project budget/spend cap and notification recipient membership remain unverified. Actual initial credits are recorded in the cost-protection report. No after-staging bill exists because no cloud staging ran.

## Status

- GCP_BILLING_BLOCKED: active paid account/credits confirmed; dedicated project access/linkage incomplete.
- GCP_BUDGET_PROTECTION_PARTIAL: saved account warning; project protections absent.
- DEVELOPER_CREDIT_PRIORITY_UNKNOWN.
- CLOUD_RUN_BLOCKED: financial and runtime/durability/authentication gates.
- COMPUTE_ENGINE_NOT_NEEDED: not provisioned; only reconsider after a critical Cloud Run technical failure.
- E2E_PENDING.
- PRODUCTION_CUTOVER_BLOCKED.
- AZURE_FALLBACK_PRESERVED: no Azure, production Vercel or DNS changes by this task. Current Azure runtime health was not independently revalidated.

## Independent exact-commit Box verification

Verified implementation commit **`0215ef5acaebe0c57e9a2fb1364cbd96be1c83dc`** from a newly created `/tmp/hsr-gcp-verify.*` checkout of the public repository. No local dependencies, production secrets, browser profiles or application state were copied.

Environment: Linux x86_64, uid1000, Node24.21.0, npm11.19.0, Google Chrome157.0.8103.38. Commands:

```sh
git clone --quiet https://github.com/NullOkami47/hsr_currency_war_transfer.git "$work"
cd "$work"
git checkout --detach 0215ef5acaebe0c57e9a2fb1364cbd96be1c83dc
npm ci
npm test
CURRENCY_WAR_BROWSER_CHANNEL=chrome node --input-type=module -e 'const {probeBrowser}=await import("./scripts/infrastructure/gcp-browser-probe.mjs"); console.log(JSON.stringify(await probeBrowser()));'
node scripts/infrastructure/oracle-synthetic-http.mjs
```

Results: npm ci exit0, audit0 vulnerabilities; full suite **247 passed / 247 total, zero failures/skips**, exit0. The real browser probe exit0: Chrome157.0.8103.38, sandbox requested, two launches, synthetic cookie persisted across browser close/reopen, final Node RSS136,011,776 bytes. This RSS excludes Chrome children and is not a Cloud Run RAM sizing measurement. Loopback HTTP/state tool exit0. Overall remote command exit0. Full evidence: `D:/CodexWork/free-worker-migration-evidence/gcp/box-0215ef5.txt`.

This ran the JavaScript on Box's existing Chrome installation, **not the Docker image and not GCP**. It confirms the browser probe logic and Linux regression suite. It does not confirm image build, Cloud Run sandbox support, durable external storage, account login, IAM/TLS ingress or billing.

GitHub Actions run `43062138181` completed success on the same exact head: four required Ubuntu/Windows × Node20/22 checks passed. Existing CircleCI checks also passed; no CI policies were changed. A later evidence-only commit does not alter executable source; its own CI state must still be checked separately.

### Review corrections

Sol/medium review identified an over-broad Docker context exception and missing whole-probe deadline. The context now re-excludes descendants before allowing only the two infrastructure files. The handler enforces a 60-second total probe deadline; on timeout it fails closed, returns503 and marks health unhealthy, refusing further probes. The executable exits1 after a short response flush so the container runtime terminates its process tree. A timeout is not reported as clean shutdown or successful profile cleanup. No production instance has been deployed to test supervisor behaviour. New injected hung-probe regression passed after the fix; before the fix it hung and was manually stopped (exit1).

### Reviewed implementation: final independent verification

Exact implementation **`6f5fbb6a9b5e67114974ecfc4b0315467c8a278e`** was independently cloned into a new `/tmp/hsr-gcp-reviewed.*` directory on Box. Same commands as above with checkout changed to that SHA: npm ci exit0/audit0; **248/248 tests passed, zero skipped/failed**, exit0; real Chrome157.0.8103.38 probe exit0, two launches, synthetic cookie persisted, sandbox requested. Node24.21.0/npm11.19.0/Linuxx64, NodeRSS135,417,856 bytes (not browser-tree memory). Overall exit0. Full log: `D:/CodexWork/free-worker-migration-evidence/gcp/box-6f5fbb6.txt`.

Local reviewed suite:248total/247pass/0fail/1existing POSIXskip, exit0, `gcp/local-reviewed-tests.txt`. Sol/medium read-only follow-up review closed both findings and independently ran the probe HTTP tests5/5, exit0. It did not run Chrome/cloud.

GitHub Actions run43065638614 for the exact6f5fbb6 implementation SHA completed success. This evidence-only follow-up changes documentation; no executable changes after the tested SHA.

## 2026-11-12: Compute Engine standby and Azure backup implementation

Starting source was `35496e3985628254fe6ef64551e5903b39755598`. Fresh GitHub readback confirmed four required Actions checks succeeded for that exact SHA in run43066126680; existing CircleCI checks also passed. No check policy changed.

### Azure read-only evidence

Azure CLI confirms the Azure for Students subscription Enabled and VM `hsr-transfer-worker` running in francecentral. Run Command readback: service active/running, MainPID559799, User azureuser, cwd `/opt/hsr-transfer-worker`, EnvironmentFile `/etc/hsr-transfer-worker.env`.

Privileged process-environment allowlist inspection confirms three actual paths: `/var/lib/hsr-transfer-worker/transfers.json`, `/var/lib/hsr-transfer-worker/jobs.json`, `/var/lib/hsr-transfer-worker/jobs.json.security.json`; each exists and is0600. Separate profile directory is0700 and excluded. No secret environment value, JSON content or Cookie was retrieved. Private discovery receipt: `D:/CodexWork/free-worker-migration-evidence/gcp/azure-state-paths.json`.

SSH failed during banner exchange; management-channel readback succeeded. No service stop/restart, production worker deployment/config change, firewall change, Vercel mutation or strategy operation performed. Storage Account list returned[]; no new storage provisioned. **Production off-VM backup destination: NOT_CONFIGURED. Latest verified production backup: NONE. Daily schedule: NOT_INSTALLED.** Destination/key custody and daily admission/service pause require approval.

Cost Management queried daily ActualCost for2026-11-04..10:7USD rows, sum4.952970565101519, average0.7075672235859313/day; last5days0.4780453412822438/day. Whole-subscription costs, not remaining credit. Sponsorship portal reports no active Sponsorship for current browser identity; balances API returns NotFound. Remaining student credit, expiry and days remaining UNKNOWN. Credit alerts not configured. No long-lived credentials exported.

### Synthetic restore evidence

Windowsx64 Node24.18.0: `node scripts/infrastructure/synthetic-restore-drill.mjs` passed at2026-11-11T17:55:17.592Z (2026-11-12 01:55:17 +08). Real JsonWorkerJobStore/JsonTransferStore/JsonSecurityStore created a synthetic completed job/mapping/quota/policy/request-budget/session set; encrypted, verified, restored and compared all3exact files plus store dashboard. All preserved. Ciphertext SHA256 `7bdd58d234a4840218b1cab43f1de23fe05159ceb85712d18b4562566c2344c7`. Fixture removed; not a retained production archive or cloud restore.

New modules first failed with ERR_MODULE_NOT_FOUND, then implementation passed meaningful refusal, integrity and recovery tests. Tested outer-checksum and GCM ciphertext tampering, wrong encrypted private-key passphrases, missing security, transfer locks, active/ambiguous jobs, no-overwrite restore, seven-day retention and preservation of the last successful archive. Coordinated backup tests cover drain-before-stop, failed snapshot recovery and fail-closed health. These are injected operations, not actual systemd production tests.

Actual SSH collection, DPAPI unlock, installed daily scheduler, protected off-VM archive, production restore and GCP systemd tests remain unverified. Parser/node checks do not prove those operations.

### GCP gates

ChingG account badge reverified. Proposed project dashboard still reports missing resourcemanager.projects.get; resource list lacks HSR. User explicitly authorised project creation. Form filled with requested name and exact proposed ID; OpenCLI returns clicked but page stays unchanged. No creation success without resource/dashboard readback. No VM, network, disk, NAT or other resource provisioned.

GCP_STANDBY_PARTIAL; IPV6_END_TO_END_PENDING; E2_MICRO_PENDING; COST_PROTECTION_PARTIAL; CUTOVER_PROCEDURE_PARTIAL; AZURE_PRODUCTION_PRESERVED. GCP final power state N/A: no VM created. Actual GCP Chrome/process memory, IPv6 ingress/egress, strict origin TLS, Vercel Function connectivity, service persistence/restart and fresh HoYoLAB authentication remain PENDING. No live strategy or production cutover performed.

### Local regression gate before the recovery implementation commit

`npm test` on Windowsx64 Node24.18.0:267total/265pass/0fail/2POSIXskips before the final encrypted maintenance-metadata assertion; the final committed suite result is recorded in the independent verification receipt below. PowerShell AST parsing for both collector and schedule installer succeeded. The daily schedule has not been installed or run.

### Independent Linux verification of recovery baseline

Fresh Box checkout at **b1c6698868c78766ed7349283ef0a76bfb93c0a4**: Linuxx64 uid1000, Node24.21.0, npm11.19.0, Chrome157.0.8103.38. Commands: git clone; checkout exact SHA; npm ci --ignore-scripts; npm test; synthetic-restore-drill; CURRENCY_WAR_BROWSER_CHANNEL=chrome node scripts/infrastructure/measure-browser-memory.mjs. npmci exit0/audit0; **268/268 tests pass,0fail,0skip**, overall exit0. Log: `D:/CodexWork/free-worker-migration-evidence/gcp/box-b1c6698.txt`.

Synthetic restore passed at2026-11-11T18:28:40.072Z, ciphertext hash `ffd3924cf073e395929f5be5080c1f2f76143f074a126342a6a829954cd3e5da`, three exact files and all state classes retained. Real sandbox-requested Chrome launched twice and persisted only a synthetic cookie across restart. Sampled entire Node+Chrome RSS peak1,174,409,216bytes/13processes/31samples. RSS double-counts shared pages and sampling misses instantaneous peaks. Box has about3.79GiB RAM, no swap; **this does not establish e2-micro compatibility**. GCP cgroup peak/OOM evidence remains absent.

GitHub Actions43077980297: four required Ubuntu/Windows Node20/22 jobs succeeded for exactb1c6698. Existing CircleCI Node20/22/24 also succeeded. A later review found unsafe auto-resume after an uncertain stop/exclusive-writer failure; a new regression reproduced it before the fix. The corrected coordinator refuses automatic restart/reopening when ownership is unproven and rechecks stopped state before healthy recovery. Those corrections and optional PSS sampling require their own verification, recorded below.

### Project creation input blocker clarified

Task-scoped OpenCLI2.0.3 installed on D:, official daemon restarted; extension1.0.27 connected. New Chrome window/bound session remains on ChingG's projectcreate page, requested name and proposed ID `hsr-currency-war-worker` filled. Native input explicitly rejected: `Native input requires a visible browser page; input was not dispatched.` Readback reports document hidden. No successful project-create submission or cloud resource is claimed. Making Chrome visible or completing the already authorised Create action is a user-interaction dependency, not a request for new project-creation authority.

### Reviewed recovery implementation: exact-commit evidence

**Implementation commit: 877220027e32b8201a64cb287094b2b03fe2c370.**

- Windowsx64 Node24.18.0: npm test **269total /267pass /0fail /2POSIXskips**, exit0. PowerShell AST parse for collector and task installer exit0. Log `D:/CodexWork/free-worker-migration-evidence/gcp/backup-reviewed-local-tests.txt`.
- Independent Box **fresh checkout** `/tmp/hsr-recovery-reviewed.sNZ0CK`, exact SHA above; Linuxx64 uid1000, Node24.21.0/npm11.19.0, Chrome157.0.8103.38. npmci --ignore-scripts exit0/audit0. npm test **269/269pass,0fail,0skip**, exit0. Overall remote exit0; log `D:/CodexWork/free-worker-migration-evidence/gcp/box-8772200.txt`.
- Real synthetic restore drill PASS at **2026-11-12T00:24:46.913Z** (08:24:46 +08):3exact files, mappings/job results/quota/policy/security all preserved. Ciphertext SHA256 `0a09707d61478ccbc5d2aec89e9c4e2085b4ff88f97ddc043ff8fd5be603b023`. Ephemeral synthetic fixtures removed. This timestamp is **not** a production backup timestamp.
- Real Chrome two-launch persistent-context test PASS, sandbox requested, synthetic cookie preserved. Process-tree sampled RSS peak1,193,951,232bytes; proportional PSS peak457,547,776bytes (about436.35MiB),12processes,19samples/18completePSSsamples,0sampled swap. RSS/PSS sampling is not isolated cgroup sizing; Box has about3.79GiB. **E2_MICRO_PENDING** until actual VM cgroup/OS/workload tests.
- Four required GitHub Actions checks succeeded for exact8772200 in run **43126865381**; existing CircleCI Node20/22/24 checks succeeded. No required CI disabled or extra cloud resource launched.

Azure final health readback: same MainPID559799, active/running, ActiveEnterTimestamp2026-11-11T09:27:57Z, `/health` returned status ok. Later in-VM **aggregate-only, read-only** inspection found transfer schema1 with26mappings, jobs schema4 with6completed/3failed and no active jobs in that observation, quota/policy present, security schema1 with request/session objects. Root-owned EnvironmentFile is0600. These separate live reads are not a consistent backup. `/opt/hsr-transfer-worker` is a deployed directory without `.git`; production source SHA was not inferred from the development branch. No profile, JSON body or credentials left Azure.

Current production backup location/timestamp remain **NOT_CONFIGURED/NONE**. The new code is on the PR branch only. Neither daily schedule nor maintenance pause was enabled. Chrome remains hidden for automated native input; project form prepared but no creation success claimed. A documentation-only follow-up may reference this exact executable commit; its own CI status must be checked separately.
