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
