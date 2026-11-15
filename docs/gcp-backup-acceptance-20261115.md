# GCP production backup acceptance, 2026-11-15

The owner explicitly approved the repair, bounded maintenance, complete backup
and restore drill, then timer activation only after acceptance. Production code
was deployed from `0cf25ff70d13f85cad6cbc8250e03707022cce94`. Seventeen deployed
source files and three installed systemd drop-ins matched their Git SHA-256
manifest on the actual VM. The monitor uses image digest
`sha256:5b9b6d6a899b80d26fb798761d2d559b28812bec358fc7baebbf15bdf7a76e19`.
Private evidence, configuration and recovery material remain outside Git.

## Maintenance and production continuity

All times below are **2026-11-15 Asia/Hong_Kong (UTC+08:00)**.
The first deployment began at 12:40:55.084. Final successful backup maintenance
finished at 12:56:48.179. The worker continued serving between windows.

| Window | Stop requested | systemd Started | Request-to-start | Health interruption |
| --- | --- | --- | ---: | ---: |
| Install reviewed shutdown repair | 12:40:56.716 | 12:40:58.756 | 2.040 s | 2.331 s |
| First backup acceptance, failed temporary probe | 12:54:00.598 | 12:54:42.967 | 42.369 s | 42.585 s |
| Successful backup with actual profile acceptance | 12:56:31.982 | 12:56:47.002 | 15.021 s | 15.496 s |

Health was sampled every 250 ms with a one-second request deadline, so these
health intervals are observations rather than exact network availability bounds.
For the successful backup, the stop-post profile probe ran within the stop
transaction; reporting only inactive-to-start time would omit that interruption.

The failed attempt was an operator probe-path error: the worker's `PrivateTmp`
sandbox could not see `/var/tmp/profile-reopen-acceptance.mjs`. It produced no new
backup and correctly recorded failure. The backup coordinator executed fail-closed
handling (`BACKUP_RUN_FAILED`), skipped uploads, prevented corrupt or partial state
overwrites, and claimed no restore verification. The temporary hook was removed, the
existing worker restarted, and original admission restored at 12:55:02.696 HKT
(runId `4a4600d0-f525-470d-b304-53d1fcdb3389`). No locks were deleted or valid processes
forcibly terminated. The timer remained disabled and failure monitoring stayed enabled.
After moving the probe into the service-readable application directory
(`/opt/hsr-transfer-worker-staging/scripts/infrastructure/profile-reopen-acceptance-20261115.mjs`)
and checking path visibility in systemd, the next attempt passed. Both temporary hooks
and the probe were then moved to the private rollback directory and removed from active
service configuration.

The actual production Chrome profile opened and closed twice using a raw Chrome
child, loopback-deny proxy, `about:blank`, and CDP `Browser.close` without a kill
fallback. It used the existing publisher flock with `--no-fork`, refused existing
owners/Singleton links, and confirmed Chrome removed its own links. No publisher
or strategy request was created. Application hashes before/after were identical.

Thirty-four job records were identical before and after maintenance: 30 completed,
four failed, zero queued/running. Mappings remained 39. Security state and session
entries were unchanged. One older quota event naturally expired at 12:34:33.021
under the existing 24-hour window before the capture; the remaining 15 events
matched the capture, restored data and post-maintenance production state.

The final worker was `active/running`, MainPID `10865`, `/health` returned `ok`,
and original public admission was `true`. Azure remained deallocated. Vercel
routing was not changed and no second publisher was started.

## New backup and real restore

- Captured: **12:56:46.422 HKT** / `2026-11-15T04:56:46.422Z`.
- Complete scheduled-mode run succeeded: **12:56:48.179 HKT**.
- GCS bucket: `hsr-worker-backups-282550645630` in region **`US-CENTRAL1`** (Standard regional bucket).
- Ciphertext: `gs://hsr-worker-backups-282550645630/gcp-production/hsr-state/hsr-state-2026-11-15T04-56-46-422Z.enc.json`.
- Receipt: the same stem with `.receipt.json`.
- Ciphertext size: **76,549 bytes**.
- SHA-256: `b2057b69a31b7b5f72a45c45c9c7818aa8c688c4f61411cf1f13ea3e04ac0e1b`.
- Ciphertext generation: `1794718607756209`; receipt generation: `1794718607934447`.
- Key recipient hash: **`1b7198fa8f2009311bff67b8df7376f08809d07dc4ffb456076baf67467a56d8`**, matching recovery keys in **`D:/HSRRecoveryKeys`** (`hsr-backup-public.pem` and `hsr-backup-portable-private.pem`).
- Actual independent decryption/restore completed: **12:57:53.953 HKT**.

Downloaded ciphertext and receipt from GCS and used the existing protected
off-VM recovery key. AES-256-GCM, RSA-OAEP-SHA256, archive/receipt digest, file
manifest hashes and application schemas all passed. The three restored hashes
equalled the quiescent source hashes recorded by the profile probe immediately
before the snapshot. Jobs were never replayed. Temporary plaintext was overwritten
and removed; this does not claim forensic erasure on an SSD. Keys were not rotated,
uploaded or installed on the production VM.

Both new objects have temporary holds and are the cloud/local externally restored
baseline. The earlier verified baseline is also retained. Bucket minimum retention
and Soft Delete are each seven days; versioning is off. Guarded pruning retains
seven days and the held baseline; lifecycle covers production archives at 30 days
and monitor events at 14 days. The successful local prune had zero candidates and
deleted nothing. Historical Azure ciphertext/receipts and their GCS copies remain.

## Schedule and monitoring

After all acceptance checks, `hsr-gcp-state-backup.timer` was enabled and active.
Readback: `*-*-* 03:00:00 Asia/Hong_Kong`, `Persistent=yes`; next execution
**2026-11-16 03:00 HKT** (`2026-11-15 19:00:00 UTC` / `2026-11-15T19:00:00Z`). This future timer execution
has not yet occurred. The same real backup service was manually exercised above.

The coordinator closes admission and safely drains jobs. A busy queue that cannot
drain restores admission without stopping the worker. An uncertain stop never
starts another publisher. `KillMode=mixed`, `SendSIGKILL=no`, and a 510-second
client bound accommodate systemd's two 240-second stop phases. Preserve any live
process and investigate a timeout; never remove a valid profile lock.

Cloud Run revision `hsr-backup-monitor-00005-j2f` serves 100% of traffic using the
same reviewed image and the new verified baseline. Min instances remain zero,
max one, 256 MiB. Existing hourly Scheduler remains enabled in Asia/Hong_Kong.
Old revisions have no traffic and are retained for rollback.

| Policy | ID | Final setting |
| --- | --- | --- |
| Old HSR backup failure or missed schedule | `2920267040207521978` | Disabled (`enabled: false`) |
| GCP production backup unhealthy | `6473563072822992431` | Enabled (`enabled: true`) |
| GCP monitor persistent error | `2689805350974814162` | Enabled (`enabled: true`) |
| Watchdog silent for two hours | `10121792019042862252` | Enabled (`enabled: true`) |
| Isolated TEST ONLY delivery policy | `1608838014335576235` | Disabled after receipt (`enabled: false`) |

The old policy was already checking GCP; its failure warning was real. The service
and Scheduler were reused rather than removed. Live health metric `custom.googleapis.com/hsr/gcp_backup_unhealthy = 0`
returned **0** at 13:00:07.281 HKT; a follow-up check at 13:00:56.729 produced only INFO heartbeat
logs and HTTP 200. No repeated per-check notification is configured. The existing
authorised email channel received the earlier labelled TEST ONLY message.

## Validation and cost

Independent fresh Simular Box checkout of deployed `0cf25ff`, clean `npm ci`,
Node 24.21.0, systemd 255, Chrome 157: **26/26 focused tests passed**, zero skips,
exit 0. This includes real Chrome timeout preservation, graceful profile reopen,
coordinator drain/recovery and publisher shutdown. Earlier full exact-commit
verification at `86926a6` passed 466/480 with 14 root-only skips; a separate root
spool run passed 51/51 (overlapping coverage). Windows focused tests also passed.

Hosted GitHub checks for deployed `0cf25ff` all passed. Its CircleCI Node 20 run
exposed two pre-existing test timing assumptions (5 ms retention deadline and
20 x 2 ms queue polling); Node 22/24 passed. The PR fixes those tests without
changing production logic. Consult the current PR head for final hosted results.

Estimated incremental backup/monitoring cost remains **US$0–0.50/month** at the
observed volume, separate from the worker VM, disk and IPv4. Shared free allowances
do not guarantee a zero invoice. No new always-on resource, long-lived service
account key, budget change or promotional-credit ordering assumption was introduced.
