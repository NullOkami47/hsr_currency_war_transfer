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
