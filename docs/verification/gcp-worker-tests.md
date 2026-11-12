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

### Synthetic standby service development

Adds an executable synthetic service, process-restart drill and transient systemd drill. Test evidence is recorded only after actual execution; the scripts' existence does not prove GCP, Chrome, systemd or crash recovery. New HTTP tests first failed for missing module, then caught cleanup ordering and stale lock admission; corrected implementations pass. All fixtures remain synthetic, production credentials/profile rejected. No production changes or GCP resources.

### 6060ecd real-process check caught a browser selection bug

Fresh Box checkout6060ecdd232c331c32e5ca47dddfb036326f8960 installed cleanly and passed277/277tests, but the actual child-process Chrome job failed; exit1. The systemd stage did not run because the command stopped at the failed process drill. Root cause: probeBrowser accepted explicit channel/executable parameters, but its launch block still read only CURRENCY_WAR environment settings. The synthetic service correctly refuses that production namespace, so the requested Chrome was ignored. Added a launch-boundary regression, observed it fail, and corrected the options. This is a failed verification, not evidence for GCP or restart readiness. Log: `gcp/box-6060ecd.txt` outside Git.

### 68b3a6d: process PASS, systemd FAIL, diagnosis retained

Independent fresh Box checkout68b3a6d136e9f9e25b1dbf35ef483cefeaf3f385:278/278tests pass. Actual OS-process drill PASS at2026-11-12T01:05:22.876Z:4starts,3graceful stops,1intentional SIGKILL at the synthetic running boundary; recovery completed with unchanged quota, persisted three-file state and no duplicate mapping. This is Box process verification, not GCP/systemd.

Actual transient systemd test then FAILED because ProtectHome hid Chrome's writable HOME/config location (crashpad database error). Diagnostic adjustment to a writable synthetic HOME resolved startup but exposed TasksMax128 thread exhaustion (pthread_create EAGAIN). Raising the finite task limit to256 allowed Chrome, then restart correctly rejected Chrome config/cache mixed into the JSON-only state directory. The fix separates sibling browser-home and synthetic-state directories, preserving strict state allowlisting and all browser/systemd sandbox settings. A diagnostic execution with those fixes passed Chrome, real systemd crash-restart, exact state persistence and final stop at2026-11-12T01:15:31.609Z; this diagnostic used a modified development checkout and is **not exact-commit independent evidence**. Final committed revision must be tested separately. All transient units are scoped hsr-synthetic-drill-<random>, bounded180s, and cleanup targets only that identity.

### Final independent standby runtime verification

Exact implementation **66f0211e3e6d4e2787b607eedd98e70d75be3ee1** was cloned into a new Box checkout, followed by clean npmci --ignore-scripts. Linuxx64 uid1000, Node24.21.0/npm11.19.0, Chrome157.0.8103.38. npmci exit0/audit0; **278/278tests pass,0fail,0skip**, exit0. Windows same implementation:278total/276pass/0fail/2POSIXskips, exit0. Full log `D:/CodexWork/free-worker-migration-evidence/gcp/box-66f0211.txt`.

Actual `synthetic-process-restart-drill.mjs` PASS at **2026-11-12T01:18:01.827Z** (09:18:01 +08):4OSprocess starts,3graceful stops,1intentional SIGKILL at a synthetic running-job boundary. Real Chrome job completed, health and auth/payload checks passed, mappings/jobs/quota/policy/security persisted, duplicate did not alter mapping, interrupted running work completed after restart without extra quota. No real account or upstream strategy used.

Actual `synthetic-systemd-drill.mjs` PASS at **2026-11-12T01:18:06.623Z** (09:18:06 +08): transient unit `hsr-synthetic-drill-ee1d38f421c7.service`,180s runtime bound, PID10616 changed to10909 after deliberate main-process SIGKILL; NRestarts1. Real Chrome job completed before crash, exact persisted files matched after supervisor restart, final service stopped/inactive/MainPID0. Final list of running hsr-synthetic-drill-* units was empty. Overall remote command exit0.

Observed service properties: NoNewPrivileges=yes, ProtectSystem=strict, PrivateTmp=yes, KillMode=control-group, TasksMax256. Before restart, cgroup MemoryPeak253,816,832bytes (about242.06MiB), MemoryCurrent95,784,960bytes after browser closed, CPUUsageNSec3,450,839,000. After restart counters were separately recorded; not added to prior peak. These are Box cgroup observations for a minimal synthetic page, not full HoYoLAB memory requirements or GCP e2-micro acceptance. Requested Chrome sandbox remained enabled.

This verifies the committed test/runtime tools on independent Linux and systemd. **GCP_STANDBY_PARTIAL**, **E2_MICRO_PENDING**, **IPV6_END_TO_END_PENDING**, real GCP origin/TLS/Vercel and HoYoLAB authentication still unverified. Azure remains production; no production backup/pause/schedule or cloud resource provisioning performed. Project form remains hidden in Chrome, pending visible user interaction; separate backup destination/maintenance approval is still pending.

GitHub Actions43133413282 and existing CircleCI checks passed on exact66f0211. The following documentation-only evidence commit has no executable changes; check its own CI separately.

## 2026-11-12 帳戶與網路前置作業更新（尚未建立 VM）

本段取代較早「專案 ID、billing linkage、project budgets 未確認」的狀態。使用官方 Google Cloud CLI 593.0.0，以本次 OAuth 明確登入原指定 ChingG 帳戶；CLI 與受限設定目錄位於 D:/CodexWork/gcp-tools，credential/code 未放入 repo 或聊天。

- 已建立並從 dashboard 與 Resource Manager CLI 讀回專案 `hsr-currency-war-worker`，編號 `282550645630`，ACTIVE、無組織。
- `billing projects describe` 確認連結原有效付費帳戶，billingEnabled=true；帳戶幣別由 API 確認 HKD。舊 closed 帳戶未使用。
- Credits 頁仍顯示 Free Credit HK$2,353.66，2027-02-10 到期；七筆 Developer 月信用額各 HK$78.46、100%。報表存在延遲；沒有實際 transaction 證明誰先扣款。優先序 UNKNOWN。
- 已啟用 Compute API 與 Billing Budgets API。已存檔並用 budgets list 獨立讀回：`hsr-project-gross-warning` HK$30/month、EXCLUDE_ALL_CREDITS、actual 50/75/90/100% 與 forecast100%；`hsr-project-net-warning` HK$1/month、INCLUDE_ALL_CREDITS、actual1/50/100%。HK$30 是本次選定的保守門檻，不宣稱是已驗證匯率換算的 US$5。帳戶既有 HK$0.10 net 警示保留。default IAM recipients 未停用；未實測寄信，未成功列出收件人 role membership。Budget 是警示，不是付款硬上限。
- 已建立 `hsr-worker-vpc`（custom）、`hsr-worker-us-central1`（10.42.0.0/24），只允許 IAP 35.235.240.0/20 對標籤 hsr-worker-standby 的 TCP22。沒有公開 worker/VNC/CDP/HTTPS ingress、NAT、負載平衡器或 static address。
- `us-central1-a` e2-micro API 回傳 2 guest CPUs、1024 MB RAM；Ubuntu image `ubuntu-2404-noble-amd64-v20261105` READY/x86_64。這不證明建立時有實際容量或 Chrome 可運行。
- 新專案 instance/disks list 均空；同有效 billing account 僅此專案與原 gcp-pay 專案，後者 Compute API 未啟用。當前零資源不能證明整月 shared Free Tier 未曾使用。

### IPv4 出口門檻

Google DoH 與 Cloudflare DoH 即時 AAAA 查詢：`sg-act-public-api.hoyolab.com`、`act.hoyolab.com` 只有 CNAME，沒有 AAAA；A 查詢均有位址。`github.com` 亦無 AAAA。npm、Node、Google 下載站具有 AAAA 不足以令整個 worker 相容。這是外部 DNS 證據，尚未冒稱在 GCP VM 上測過連線。

原純 IPv6 direct-egress 方案不能直接連這些 IPv4-only 端點。候選改為同一 e2-micro、20GB pd-standard、臨時 external IPv4、無 VM service account、IAP SSH、Google maxRunDuration=1h / STOP；建立前需使用者核准 IPv4 及非零費用風險。停止會釋放 ephemeral IPv4，但保留 boot disk。既有 `gcp-standby.mjs` 明確拒絕 IPv4；不能繞過它或造假的 costEvidence。得到核准後須以明確的 IPv4 staging 操作與 readback 驗證，或先更新並測試控制工具。

官方 IPv4 定價 US$0.005/hour，monthly first hour allowance 是 billing-account shared；持續開機720h時 IPv4部分約US$3.60/月（扣一小時後US$3.595），不含其他資源或出站。Credit 可能抵扣符合資格費用，不能保證指定抵扣順序、永久免費或零現金支出。Public NAT 另有 gateway、處理流量與 IP 費，沒有部署。

已備妥 guarded provisioning 腳本於本次工作目錄 work/gcp-online/New-GcpStandby.ps1，明確要求 -AuthoriseTemporaryIPv4，且若專案已有 VM 就拒絕重複建立。尚未執行。**GCP 尚未上線，VM final state N/A；等待 IPv4／費用邊界確認。** Azure 與 Vercel production 未切換。

來源：Google 官方 [IPv4 定價](https://cloud.google.com/vpc/network-pricing)、[Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features)、[VM 時限](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime)、[budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets)。實際 JSON 收據與 DNS 查詢位於本次工作目錄 work/gcp-online，非帳單延遲結算保證。
## 2026-11-12 已核准的 GCP IPv4 實機測試與最終待命狀態

使用者於本對話對「單台 e2-micro、臨時 IPv4、最長一小時且 Google 端自動 STOP」明確回覆 ok。此核准不包含常駐付費 IPv4、延長測試、正式 cutover、真實 HoYoLAB 發布或 Azure 除役。

### 實際資源與安全邊界

- 專案 `hsr-currency-war-worker`，`us-central1-a`，VM `hsr-worker-standby`；Ubuntu `ubuntu-2404-noble-amd64-v20261105` x86_64，e2-micro API 1024MB，OS MemTotal 953MiB。
- 單顆 20GB `pd-standard`，autoDelete=false，保留 boot disk。專用 VPC 與 IAP TCP22規則；沒有公開 worker、VNC、CDP入口、Cloud NAT、負載平衡器或 static address。
- 建立使用 `--no-service-account --no-scopes`，最終完整 VM 讀回沒有 serviceAccounts。OS Login、阻擋project SSH keys、Shielded Secure Boot/vTPM/integrity均設定。
- `maxRunDuration.seconds=3600`、`instanceTerminationAction=STOP`、automaticRestart=false 均在 RUNNING與TERMINATED狀態重新讀回。沒有重設時限；本次手動提早停止，不宣稱已實測自動到時STOP。
- 實際執行 **2026-11-12 14:57:14.551～15:52:04.463 +08**，約54分50秒。最終 **TERMINATED**；20GB磁碟 **READY**；無配置中external IPv4、無static address。
- IAP最初因本機連線問題逾時；官方CLI為generic archive，在Windows用bundled Python呼叫，沒有原生gcloud ssh支援。以本機獨立IPv4解析launcher及Windows OpenSSH經IAP連線成功；未改官方SDK碼。SSH host ED25519由Google序列console取得，再StrictHostKeyChecking=yes核對。臨時OSLogin key TTL1h，私鑰留D槽受限目錄，未上傳VM。IAP程序已停止。

### 精確來源與安裝

測試原碼 **5940d2fd969347a227231ef1a9384c60cda2dfe5**，程式相對2886e9f無差異，5940d2f只有文件。由Git archive提供**公開原碼**，不含.env、browser profile、正式state或token。

首次Windows archive帶CRLF造成既有 `caddy-file-metadata.sh` shell測試失敗。讀取Git blob確認原始LF；以 `git -c core.autocrlf=false archive` 重新封存同一SHA，部署後全套通過，未修改測試以掩蓋錯誤。LF tar SHA-256 `a8650e3fb6aeae23fc8689c925e5a136118cbff48840d1be23c3e3577a787f66`；VM讀回一致。

Node **v24.22.3**／npm **11.19.1**，官方Node SHASUMS256核對成功；Google簽名apt來源安裝 Chrome **157.0.8103.78**。程式root-owned `/opt/hsr-transfer-worker-staging`，非root `hsr-worker`，獨立0700state/home，root0600 `/etc/hsr-worker-synthetic.env`，只存新生成synthetic token。正式publisher未啟動。

### GCP實際驗證

- `npm ci --ignore-scripts` 成功、audit0；非root `node --test`：**278/278 pass、0fail、0skip**，10.72秒。這是精確公開原碼在真實GCP主機驗證；不是獨立審查人員的遠端二次驗證。
- `measure-browser-memory.mjs`：兩次Chrome persistent-context啟動/close/reopen成功、合成cookie保留、chromiumSandbox=true；未使用no-sandbox。PSS peak459,374,592bytes（約438.09MiB），RSS peak1,003,577,344bytes（共享頁重複計算），109samples／107完整PSS samples，sampled swap0。不是HoYoLAB登入頁記憶體。
- `synthetic-process-restart-drill.mjs`於15:41:14.909+08通過：4OS程序啟動、3graceful stop、1running synthetic工作SIGKILL，工作恢復／quota不變／mapping、jobs、security跨restart保留、duplicate不改mapping、401/400安全拒絕。沒有real publishing。
- `synthetic-systemd-drill.mjs`於15:41:19.878+08通過：真實transient unit，PID6260→6511、NRestarts1，Chrome合成工作完成、三檔保留、最後inactive/MainPID0。sandbox NoNewPrivileges=yes、ProtectSystem=strict、PrivateTmp=yes、TasksMax256。工作cgroup MemoryPeak238,678,016bytes（227.62MiB）；CPU3.50s。通用測試輸出仍寫gcpVerified=false，因工具不自我判定平台；本節平台證據來自實際GCE身份／SSH／控制平面readback，未改寫原始log。
- 已安裝 `hsr-worker-synthetic.service` 的實際smoke於15:44:38.578+08通過：loopback127.0.0.1:8788，未授權POST401，授權Chrome合成工作成功。MemoryPeak370,782,208bytes（353.61MiB），MemoryCurrent234,676,224bytes，CPU4.52s；之後stop並核對inactive/MainPID0。非正式service測試與正式worker隔離。
- 公開唯讀HTTPS：HoYoLAB活動精確URL `https://act.hoyolab.com/sr/event/currency-wars/index.html` HTTP200/TLSverify0；sg-act-public-api根路徑HTTP404/TLSverify0，HEAD405屬根端點回應，不能當API授權驗證；GitHub/npm根HTTP200。**未登入HoYoLAB、未發真實策略、未測兩次authenticated read-only API。**
- 後續memory.events補充收集未取得完整收據：IAP連線在最終stop前關閉。不得宣稱OOM counter=0；原browser-sizing oneshot結束卸載後cgroup欄位not set也不是測量值。以上有效峰值來自執行中的systemd restart與installed-service收據。

原始失敗與成功證據封存在 `D:/CodexWork/free-worker-migration-evidence/gcp/gcp-actual-e2micro-evidence-20261112.tar.gz`，SHA-256 `240890f2f3f91af4726fd0f0471f47b44525f46eae3598885661b79fc518cebc`；download已核對，解壓於同目錄actual-e2micro-20261112。最終控制平面readback見本次work/gcp-online/final-vm-summary.json。

### 成本／正式切換

先前HK$30 gross／HK$1 net專案預算及HK$0.10帳戶net預算仍保留。15:55+08重讀credits頁，Free Credit仍顯示2,353.66、七筆Developer各78.46、八筆均100%；**報表延遲未消除，不能據此宣稱本次免費、先扣哪筆或零現金帳單。** IPv4位址本次不到1h；每billing account首小時能否全額適用未獲結算證據。已停止VM且無external IPv4；保留20GB標準PD仍受shared free-tier餘額影響。

Azure已另行完成自動Blob備份與VM外還原驗證；GCP本次不搬正式state/profile或recovery key。Azure VM最後讀回running，Vercel Production/DNS未切換。備份工具在獨立 `/opt/hsr-backup`，不是本次GCP公開原碼版本的生產部署證明。

狀態：**GCP_STANDBY_BASELINE_VERIFIED**、**E2_MICRO_SYNTHETIC_PASS**、**IPV4_EGRESS_BASELINE_PASS**、**E2E_PENDING**、**PRODUCTION_CUTOVER_BLOCKED**、**AZURE_FALLBACK_PRESERVED**。下一階段仍需核准staging hostname/TLS、實際Vercel測試入口、新HoYoLAB登入/MFA、兩次授權唯讀及明確批准的live transfer；驗收後才可請求Production GO。不得把本次一小時核准當成常駐付費IPv4或正式切換授權。