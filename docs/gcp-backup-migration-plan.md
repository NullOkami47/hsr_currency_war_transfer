# GCP production backup repair and monitoring migration

Approved scope: the owner's 2026-11-15 request. Work from public main
`cbc5b78fe831ad4a108a6fe2f1d13c34f8cc8fcf`; recover only the backup dependencies
from reviewed PR 8 head `f62b28020304d4c3c43b618757e10f8471dfc8cd`.

- [x] Read current GCE, Cloud Run, Scheduler, GCS, IAM and budget configuration.
- [x] Establish that GCP-native backup already exists and the current warning is
  genuine: the 2026-11-14 19:00 UTC backup stopped the publisher, then restart
  failed on retained Chrome singleton links. Azure is deallocated.
- [x] Preserve configuration/journal evidence locally outside Git; upload the
  completed encrypted snapshot left in the GCP spool without restarting anything.
- [x] Obtain the separately required authority for recovering the failed publisher.
- [x] Verify a graceful shutdown unit in an isolated Linux systemd environment;
  retain strict stale-lock preflight and all snapshot consistency checks.
- [x] Test monitor retry, exact 03:00 Asia/Hong_Kong schedule plus two-hour grace,
  integrity, missing receipt, source separation and healthy/error log behaviour.
- [x] Independently review and verify commit `86926a6` from a fresh checkout.
- [x] Receive explicit authority for repair deployment and backup acceptance;
  apply the owner's no-force stop and idle-queue conditions before maintenance.
- [ ] Deploy only reviewed backup/monitor files and narrow systemd drop-ins.
  Production interruptions require the owner's explicit approval.
- [ ] Create a fresh production snapshot, download ciphertext, decrypt using the
  existing D-drive recovery key, validate all three state files against capture
  hashes, and remove isolated plaintext without replaying jobs.
- [ ] Pin the externally restored pair; enable guarded seven-day pruning and
  bounded event lifecycle. Preserve historical Azure ciphertext and recovery keys.
- [x] Replace the old exact alert policy with deduplicated GCP health monitoring;
  retain independent missing-monitor-heartbeat protection and existing channels.
- [ ] Read back deployed configuration, schedule, integrity, monitor and production
  health; commit the narrow changes and open a PR. No automatic merge.

Reuse the current regional bucket, attached service account, scale-to-zero Cloud
Run monitor and hourly Scheduler. No new always-on resources or service-account
keys. Backups exclude browser profiles, cookies and HoYoLAB credentials. Public
repository artifacts contain only source, tests and sanitised receipts.
