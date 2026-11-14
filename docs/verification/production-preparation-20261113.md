# 2026-11-13 Production-preparation verification receipt (Option 1B)

Evaluated executable commit: `9e02fee699f8660efd37a7e72547d79e5c8ed9bf`.
Source branch: `codex/hsr-resilience`, extending Draft PR #8 (`NullOkami47/hsr_currency_war_transfer`). Option 1B permanent GCP cutover contract and monitor updates; no runtime source or test code changed after `9e02fee699f8660efd37a7e72547d79e5c8ed9bf` (only this verification receipt was added afterwards).

## Independent checkout evidence (`9e02fee699f8660efd37a7e72547d79e5c8ed9bf`)

Fresh detached `--no-hardlinks` clones on `D:`:

- Windows: `D:\CodexWork\hsr-option1b-win-9e02fee`, detached exact SHA `9e02fee699f8660efd37a7e72547d79e5c8ed9bf`, Node `v24.18.0`, npm `11.16.0`, `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` (exit `0`).
  - Targeted 9-file TAP suite: `113` tests, `107` pass, `6` POSIX-only skip, `0` fail, exit `0` (`6.02s`).
  - Full suite `npm test`: `593` tests, `575` pass, `18` POSIX-only skip, `0` fail, exit `0` (`11.97s`).
  - CLI `node scripts/infrastructure/gcp-production-prep.mjs generate scripts/infrastructure/gcp-production/preparation.example.json D:\CodexWork\hsr-option1b-win-9e02fee\var\prep-check`: exit `0`, `fileCount: 13`, `phase: "OFFLINE_PREPARED_ACTIVATION_BLOCKED"`, `decision: "NO_GO"`, `activationReady: false`.
- Linux (WSL2): `/mnt/d/CodexWork/hsr-option1b-linux-9e02fee`, detached exact SHA `9e02fee699f8660efd37a7e72547d79e5c8ed9bf`, `Ubuntu 24.04`, Node `v22.23.2`, npm `10.9.8`, `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` (exit `0`).
  - Targeted 9-file TAP suite: `113` tests, `113` pass, `0` skip, `0` fail, exit `0` (`8.34s`).
  - CLI `gcp-production-prep.mjs generate`: exit `0`, `fileCount: 13`, `phase: "OFFLINE_PREPARED_ACTIVATION_BLOCKED"`, `decision: "NO_GO"`, `activationReady: false`.
- Local repo checks: `npm audit --audit-level=high` (`0` vulnerabilities, exit `0`), `git diff --check` (exit `0`), `node --check` (exit `0`).
- Private runbook repo (`D:\CodexWork\hsr-vercel-gcp-cutover-docs-20261113`, branch `docs/azure-to-gcp-cutover-20261113`, commit `824d731109c7efdf317802b5e2dbefcd2426cb9d`): `npm test` (`220` tests, `219` pass, `1` POSIX-only skip, `0` fail, exit `0`) and `git diff --check` (exit `0`).

---

## Earlier pre-Option-1B receipt (`7bb8fe7c2b069c81ab0899896c9ba6862168dfe7`)

Evaluated executable commit: `7bb8fe7c2b069c81ab0899896c9ba6862168dfe7`.
Source branch: `codex/hsr-resilience`, extending existing Draft PR #8 (`NullOkami47/hsr_currency_war_transfer`). No runtime source or test code changed after `7bb8fe7c2b069c81ab0899896c9ba6862168dfe7`; only this verification receipt was added afterwards.

## Independent checkout evidence (`7bb8fe7c2b069c81ab0899896c9ba6862168dfe7`)

Simular Box was not used; no private repository or credentials were sent to a third-party host. Fresh detached `--no-hardlinks` clones on `D:`:

- Windows: `D:\CodexWork\hsr-production-prep-verify-7bb8fe7`, detached exact SHA `7bb8fe7c2b069c81ab0899896c9ba6862168dfe7`, Node `v24.18.0`, npm `11.16.0`, `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` (exit `0`).
  - Full suite `npm test`: `593` tests, `575` pass, `18` POSIX-only skip, `0` fail, exit `0`.
  - Targeted verification suite (`node --test --test-reporter=tap test/browser-config.test.mjs test/publisher.test.mjs test/gcp-production-profile-preflight.test.mjs test/gcp-native-backup.test.mjs test/backup-failure-notify.test.mjs test/cloud-backup-monitor.test.mjs test/backup-retention.test.mjs test/gcp-production-prep.test.mjs test/cutover-state-audit.test.mjs`): `113` tests, `107` pass, `6` POSIX-only skip, `0` fail, exit `0`.
  - CLI `node scripts/infrastructure/gcp-production-prep.mjs generate scripts/infrastructure/gcp-production/preparation.example.json D:\CodexWork\hsr-production-prep-verify-7bb8fe7\var\prep-check`: exit `0`, `fileCount: 13`, `phase: "OFFLINE_PREPARED_ACTIVATION_BLOCKED"`, `decision: "NO_GO"`, `activationReady: false`, `activated: false`, `cloudCommandsExecuted: false`, `backupEnabled: false` (temporary `var\` cleaned afterwards; working tree clean).
- Linux (WSL2): `/mnt/d/CodexWork/hsr-production-prep-linux-verify-7bb8fe7`, detached exact SHA `7bb8fe7c2b069c81ab0899896c9ba6862168dfe7`, `Ubuntu 24.04.5 LTS`, Node `v22.23.2`, npm `10.9.8`, uid `1000`, `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` (exit `0`).
  - Targeted verification suite (`node --test --test-reporter=tap test/browser-config.test.mjs test/publisher.test.mjs test/gcp-production-profile-preflight.test.mjs test/gcp-native-backup.test.mjs test/backup-failure-notify.test.mjs test/cloud-backup-monitor.test.mjs test/backup-retention.test.mjs test/gcp-production-prep.test.mjs test/cutover-state-audit.test.mjs`): `113` tests, `113` pass, `0` skip, `0` fail, exit `0` (`5.59s`), exercising real POSIX file/directory permission, ownership, lock, symlink/hardlink, drift, and FIFO tests in `/tmp`.
- Local repo security & syntax checks on `D:\CodexWork\hsr-resilience`: `npm audit --audit-level=high` (`0` vulnerabilities, exit `0`), `git diff --check` (exit `0`), and `node --check` on all new/modified `.mjs` files (exit `0`).
- Private runbook repo (`D:\CodexWork\hsr-vercel-gcp-cutover-docs-20261113`, branch `docs/azure-to-gcp-cutover-20261113`, commit `00b50ce3fca69910858b39256745a788bd2c505f`): `npm test` (`220` tests, `219` pass, `1` POSIX-only skip, `0` fail, exit `0`) and `git diff --check` (exit `0`).

## Scope of implemented offline modules & remaining NO_GO blockers

- Implemented and unit-tested offline: explicit `chromiumSandbox: true` in `src/publisher.mjs` and `scripts/worker-server.mjs`; `scripts/infrastructure/gcp-production-profile-preflight.mjs`; `scripts/infrastructure/gcp-native-backup.mjs`; `scripts/infrastructure/gcp-backup-failure-notify.mjs`; active-source scoping (`HSR_ACTIVE_BACKUP_SOURCE=azure|gcp`) and `gcp-production/` prefix isolation in `scripts/infrastructure/cloud-backup-monitor/server.mjs` and `scripts/infrastructure/backup-retention.mjs`; and 13-file offline bundle wiring in `scripts/infrastructure/gcp-production-prep.mjs` and `scripts/infrastructure/gcp-production/*.template`.
- Kept blocked (`NO_GO`, `activationReady: false`, `ConditionPathExists=/etc/hsr-gcp-production/EXPLICIT_GO`, no `[Install]`, `RuntimeMaxSec=3600`): live GCP VM identity/SA/IAM attachment, static IPv4/DNS/TLS/loopback acceptance, Linux Chrome sandbox & `e2-micro` runtime acceptance, GCP-to-Azure secondary backup, external off-Azure GCM cipher restore & owner alert delivery verification, and protected retention pins.

---

## Earlier preparation-only baseline: `d0296091e8c72376e385a9d7b689e07a2ea460d3`
Source branch: codex/hsr-resilience, extending existing Draft PR8. No runtime source changed after this evaluated commit; later receipt-only commits must be distinguished.

## Independent checkout evidence

Simular Box was unavailable; no private repository or credentials were sent to a third-party host. Fresh no-hardlinks clones on D:

- Windows: D:/CodexWork/hsr-production-prep-final-d029609, detached exact SHA, Node24.18.0/npm11.16.0, Windows26300 x64.
- Linux: D:/CodexWork/hsr-production-prep-linux-final-d029609, detached exact SHA, Ubuntu24.04.5/WSL2, Node22.23.2/npm10.9.8, uid1000. WSL ext4 VHDX resides D:/WSL/hoyomix-runner; POSIX fixtures in native /tmp were synthetic only and cleaned by tests.
- Both: clean `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline`, exit0. Dependency security audit is a separate existing hosted CI step, not claimed from no-audit installation.
- Command: `node --test --test-reporter=tap test/gcp-production-prep.test.mjs test/cutover-state-audit.test.mjs`.
- Windows:31 tests,26pass,5POSIXskip,0fail,exit0.
- Linux:31tests,31pass,0skip,0fail,exit0,1.42s. Real native filesystem mode/link/lock/drift/FIFO cases executed; not a production-state restore.
- CLI generate from secret-free example produced11localfiles, phaseOFFLINE_PREPARED_ACTIVATION_BLOCKED,activatedfalse,cloudCommandsExecutedfalse,backupEnabledfalse. Ignore-only var output; no provider or service mutation.
- Logs: D:/CodexWork/hsr-production-prep-final-evidence/windows.tap and linux.tap. Both checkouts clean after verification.

## Review and fixes

Independent state-tool author reviewed the separate production generator and found FIFO open could wait before file-type validation. Regression first failed at the2s external timeout. Fixed in70993cb: pre-lstat regular-file rejection, POSIX NONBLOCK/NOFOLLOW open, handle identity/metadata checks,16KiB+1 bounded reads, post-read drift detection and sanitised failure. Regression passed in83ms on the final independent Linux checkout. No activation feature added.

Private Vercel runbook review found Azure boot fencing came too late in rollback. Updated before any GCPproductionwriter/deallocate: save original units/drop-ins/enable-state, persistent disable/fence, confirm across boot, retain fence while starting Azure and installing latest GCPreturnstate. Removing fence requires final runtime GO. Not implemented or applied as a cloud change in this task.

The state comparer never grants authority: every result runtimeGo=false and authoritativeSourceVerified=false. Full three-file bytes, nested IDs, pending publications, quota/client identities, policy and security/session absence are compared. Unknown/active/pending/empty cases fail readiness. It does not copy, decrypt, chmod, prune or start anything.

The generator intentionally records unresolved production work: native GCP backup/coordinator/failure exporter, GCP→Azure secondary, active-owner scoped monitor, production profile guard and explicit Chrome sandbox launch. /usr/bin/false preflights and3600STOP remain. Passing tests means the inert preparation contract works, NOT that these missing pieces are implemented or production is ready.

## Current readonly operational evidence

At2026-11-13 17:10HKT Azureactive/runningPID572518,healthok,admissiontrue,noactivejobs,quota49 pending its already-enabled next-day restoration. GCPTERMINATED/noexternalIPv4/STOP3600/noVMserviceaccount. GCS pair2026-11-12T19:00:09.535Z observed; bucketretention604800s/softdelete604800s/publicaccesspreventionenforced/uniformaccess. Independent hourlySchedulerENABLED; latest credit balance/runwayunavailable warnings are not backup failure or balance0.

AzureActualCostNov1–12US$10.14337146,Nov6–12dailyaverageUS$0.47840079. RemainingstudentcreditUNKNOWN; GCPnetbillandcreditapplicationunreconciled. ExistingHKD30gross/HKD1net/HKD0.10account budgets unchanged; no payment cap claim. No staticIPreservation,GOmarker,Azurestop/deallocate,ProductionVercelenv/DNS/routingorresource deletion.
