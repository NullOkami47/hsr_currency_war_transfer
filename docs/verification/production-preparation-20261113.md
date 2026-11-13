# 2026-11-13 Production-preparation verification receipt

Evaluated executable commit: `d0296091e8c72376e385a9d7b689e07a2ea460d3`.
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
