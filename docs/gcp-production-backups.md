# GCP production backups

## Scope and incident

The production worker is the existing `hsr-worker-standby` VM in project
`hsr-currency-war-worker`, zone `us-central1-a`, immutable instance ID
`4111188809525812699`. Its name is historical. The active service is
`hsr-worker-production.service`, behind the existing Caddy HTTPS endpoint.
The Azure VM was already deallocated when investigated on 2026-11-15.

The old policy `HSR backup failure or missed schedule` was already monitoring
GCP. Its `worker_state_unverified` warning was real: the 2026-11-14 19:00 UTC
backup stopped the worker, created ciphertext, then could not restart because
Chrome singleton links remained. A successful snapshot was left in the local
spool because the coordinator correctly refused to report successful recovery.
Do not suppress this condition merely because its tooling originated on Azure.

After explicit owner approval, the three links for the absent PID 1992 were
quarantined on the same VM. The existing publisher recovered at
2026-11-15 02:06 UTC; admission was restored to its recorded original value.
The old failure status was not overwritten with fabricated backup success.

## Durable state and exclusions

The application uses the VM filesystem, not Firestore or Cloud SQL:

| Path under `/var/lib/hsr-transfer-worker-production` | Contents |
| --- | --- |
| `transfers.json` | CN-to-Global mappings, source hashes and publication verification state |
| `jobs.json` | Job records and idempotency, publication quota ledger, admission and security policies |
| `jobs.json.security.json` | Durable request budgets and administrator session/revocation state |

All three files must be backed up together. The coordinator holds the backup
flock, records original admission, closes new submissions and drains jobs before
stopping the exclusive publisher. A snapshot refuses active/ambiguous jobs or a
transfer lock. It does not discard pending jobs: failure to drain blocks capture.
The original service and admission must recover before the run is successful.

The owner approved the repair maintenance on 2026-11-15 with an additional
no-force requirement. The worker drop-in sets `SendSIGKILL=no`: reaching the
240-second graceful-stop deadline must not kill a remaining profile owner.
Systemd can wait through two 240-second signal phases; the coordinator bounds
its stop command at 510 seconds to observe both. An ambiguous stop
blocks snapshotting and any second publisher; preserve the live process and
reconcile it before retrying. A busy queue is polled for up to 120 drain checks,
then the original admission setting is restored without stopping the worker.
That attempt fails safely and remains visible to backup monitoring.

Keep the daily timer disabled throughout repair acceptance. Installation,
service recovery, real profile reopen, a complete encrypted upload and isolated
decryption/restore must all pass before enabling it. An installation rollback
may restore the saved source only after proving that no publisher or browser
remains. Never use lock deletion or a forced process kill to make that proof pass.

Excluded: browser profiles, cookies, HoYoLAB login material, worker/Vercel
authentication secrets, recovery private keys and recovery codes. Source and
deployment configuration are reconstructed from reviewed Git history and the
owner's protected configuration. Re-authentication may be needed after a VM loss.
Infrastructure configuration and encrypted spool are not additional application
databases. No browser profile is a substitute for a state backup.

## Encryption, storage and schedule

The existing `hsr-worker-backup/v1` format uses a random AES-256-GCM data key,
RSA-OAEP-SHA256 wrapping and per-file SHA-256 hashes in its encrypted manifest.
The existing recovery recipient is unchanged. Only its public key is installed
on the VM; private recovery material stays in the owner's protected
`D:/HSRRecoveryKeys` directory and must never enter Git, a build context or cloud
storage.

Destination: `gs://hsr-worker-backups-282550645630/gcp-production/hsr-state/`.
Each run creates immutable `.enc.json` and `.receipt.json` objects with generation
preconditions and downloads both for transport verification. Status events use
`gcp-production/monitor/events/`. Transport success is not a decryption claim.

The existing systemd timer runs at 19:00 UTC, equivalent to **03:00
Asia/Hong_Kong**, with `Persistent=true`. Neither Windows nor Codex is needed.
The independent hourly Cloud Scheduler job uses `Asia/Hong_Kong` and invokes
the authenticated scale-to-zero `hsr-backup-monitor` Cloud Run service. A stopped
VM cannot perform its daily backup; the independent monitor detects this.

The attached `hsr-gcp-worker-backup` service account has only object create/get
permissions, scoped to the two production prefixes. It cannot list or delete
backups. The monitor can list the bucket and access production objects; its
conditional IAM binding excludes historical Azure objects. No downloadable
service-account key is used. Uniform access and Public Access Prevention are
enabled; transfer uses HTTPS.

## Retention and recovery

The bucket enforces a seven-day minimum retention period, without an irreversible
retention lock. Soft Delete separately preserves deleted objects for seven days;
object versioning is not enabled. These settings do not retain encryption keys.

Guarded pruning uses the existing seven-day policy, generation checks, a fresh
valid successor no older than 36 hours, protected newest pair and an externally
restored baseline. The baseline's two GCS objects have temporary holds. A
replacement pin is installed only after real off-VM decryption and validation.
Never release the only verified recoverable baseline.

The lifecycle file removes production monitoring events after 14 days. A
30-day lifecycle rule bounds production ciphertext growth if guarded pruning
stops; held verified baselines are exempt. Neither rule targets the historical
`hsr-state/` Azure namespace. Historical Azure Blob data and recovery keys are
preserved. Five existing Azure encrypted pairs and receipts were already in GCS;
all ten objects matched Azure sizes and MD5 values on 2026-11-15.

To restore, download a chosen ciphertext/receipt pair into an isolated authorised
environment, validate its outer digest, decrypt using the legitimate recovery
key, validate GCM and every manifest hash, and restore to a new private directory.
Validate schemas, mappings, jobs, quotas and security state. Do not start a
publisher or replay jobs during a drill. Compare with the captured snapshot's
hashes, record a sanitised verification receipt, then overwrite and remove
temporary plaintext. File overwriting is not a claim of forensic erasure on SSDs.
After an actual disaster, reopen original admission only after single-publisher
ownership, browser authentication and recovered application health are verified.

## Monitoring

The GCP health metric is `custom.googleapis.com/hsr/gcp_backup_unhealthy`:
zero means all checks passed; one means a failed or overdue backup, missing
scheduled evidence, corrupt pair/receipt, recovery-evidence problem or monitoring
error. The daily slot has a two-hour grace period, giving a 05:00 HKT deadline.
A successful catch-up backup can resolve the missed-slot condition; an old
snapshot or ciphertext resend cannot impersonate a new scheduled backup.

Metadata and storage GETs retry transient failures at most three times. Neither
DELETE nor an entire prune is retried. A metric-based policy tracks one unhealthy
incident without per-reason labels or a repeat-notification interval. A separate
ERROR-only fallback detects monitor failures even when metric reporting fails,
with at most one notification per 24 hours. The independent two-hour missing
heartbeat policy remains enabled. Healthy logs do not match either error filter.

Reuse the existing authorised owner notification channel. Delivery tests must use
an isolated, explicitly labelled test policy/event; disable that temporary policy
afterwards. Do not inject a real production failure to test email delivery.

## Cost assumptions (checked 2026-11-15)

No additional VM, database, load balancer or scheduler job is required. Observed
checks took roughly 1.7–1.9 seconds before the monitoring changes. At up to ten
seconds per hourly check, one 256 MiB request-billed Cloud Run instance uses about
7,200 vCPU-seconds and 1,800 GiB-seconds per 30 days. Current snapshots are below
0.1 MiB; normal storage and operation volume is small.

Estimated backup/monitoring cost: **US$0–0.50/month** at this volume, depending on
shared free allowances and retained container images; this is not an invoice or
a spending cap and excludes the production VM, disk and IPv4. One image build is
an additional small one-time usage charge if build allowances are exhausted.
Cloud Run currently includes 180,000 vCPU-seconds, 360,000 GiB-seconds and two
million requests per billing account/month for request-based billing. Regional
GCS free allowances include 5 GB-month, 5,000 Class A and 50,000 Class B operations.
Cloud Scheduler includes three jobs per billing account, then US$0.10/job/month.

Cloud Monitoring currently lists alert-policy charging as starting no sooner
than 2027-09-01: US$0.35 per metric reference/month plus returned-point charges.
Recheck pricing before then. Existing project HK$30 gross/HK$1 net and account
HK$0.10 net budgets remain unchanged. Promotional-credit application order and
the actual settled net bill were not inferred from these budgets.

Official sources: Google Cloud Storage pricing, Cloud Scheduler pricing,
Cloud Run pricing and Google Cloud Observability pricing, checked 2026-11-15.
