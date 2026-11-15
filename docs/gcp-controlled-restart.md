# GCP controlled security-update worker restart

This is an implementation/staging component. It does not install anything, update
packages, schedule restarts, reboot a VM or change any cloud resource. Production
installation and each Production execution require separate owner authorisation.

## Fixed operational contract

- Service: `hsr-worker-production.service`; source: `/opt/hsr-transfer-worker-staging`.
- Runtime: `/opt/node-v24.22.3-linux-x64/bin/node`, Linux root coordinator, non-root
  `hsr-worker` publisher.
- Shared backup/maintenance exclusion: `/run/hsr-worker-backup.flock`. The wrapper
  opens the existing inode on FD 9 and takes a nonblocking exclusive flock. Node
  checks inode identity and `/proc/self/fdinfo/9` kernel lock evidence. Environment
  flags do not establish ownership. Collision exits 75 before admission mutation.
- Publisher flock: `/var/lib/hsr-transfer-worker-staging/login/.production-worker.flock`.
  This persistent flock file is expected to exist; it must be **unheld** before
  start and owned by the sole publisher afterwards. It is never removed.
- Three existing private state files under `/var/lib/hsr-transfer-worker-production`:
  `transfers.json`, `jobs.json`, `jobs.json.security.json`. No defaults, migration,
  reset, adoption or editing of these files is performed by this command.
- Authentication is read from root-owned private `/etc/hsr-gcp-production/worker.env`
  without shell evaluation. Only `http://127.0.0.1:8787` is used. Tokens, raw jobs,
  client keys, sessions and mapping contents never appear in output or journal.
- Service must retain `Restart=no`, `KillMode=mixed`, `SendSIGKILL=no`, and
  `TimeoutStopSec=240s`. The stop client waits at most 510 seconds because systemd
  can use two graceful 240-second phases. There is no signal escalation.
- Exact `ExecStart`, non-root `ExecStartPre`, environment binding, service unit text
  and preflight configuration are checked. Deployed preflight SHA-256 is pinned to
  `4d8fac701742e667874ea4c9358e842fd2463d4d0831ebbc93c85f3f9008de63` from the
  November 15 private deployment evidence. The command preserves and relies on
  systemd executing that strict preflight; it does not bypass or relax it.

The independent reviewer must validate these deployment assumptions on Ubuntu.
Root-group-writable deployed preflight files are accepted only with root ownership,
root group, no other-write access and the exact pinned content hash. No permission
changes are made here.

## Preparation and inspection

An authorised installer provisions `/var/lib/hsr-worker-maintenance-control` as a
root-owned mode 0700 directory and stages the four restart scripts thereunder the
existing source tree. Do not copy private evidence, environment files, credentials
or production state into Git or a third-party test host.

Inspection is the default and does not change admission, state, service or journal:

```sh
sudo /bin/sh /opt/hsr-transfer-worker-staging/scripts/infrastructure/gcp-coordinated-restart.sh --inspect
```

Inspection needs the same protected files and shared lock. It reports current
service status and sanitised state fingerprints; it does not promise restart
readiness or a successful backup. An unfinished maintenance journal is visible.

After separate owner approval of the concrete staged revision:

```sh
sudo /bin/sh /opt/hsr-transfer-worker-staging/scripts/infrastructure/gcp-coordinated-restart.sh --authorise-controlled-restart
```

Under the shared lock, the existing backup journal must be valid and `complete`.
The restart tool never writes `/var/lib/hsr-worker-backup-control/journal.json` or
`status.json`, so backup monitor success/failure evidence remains independent.

## Sequence and evidence

1. Verify contract, sole live publisher and authenticated dashboard against durable
   state. Durably journal original admission before the first PUT.
2. Close public admission. Poll at most 120 times at one-second intervals; no retry
   of PUT, stop or start. Dashboard zeroes must agree with terminal durable jobs.
   Reject unknown jobs and any `verificationPending` transfer marker.
3. Check policy/security stability, capture drained state and dashboard fingerprints,
   journal stop intent, and issue one graceful `systemctl stop`.
4. Require a definite terminal service state, MainPID/ControlPID zero, no outstanding
   systemd job, empty recursively inspected cgroup, no surviving original PID/start
   identity, Chrome, worker, login or manual writer. All transfer/profile/session
   markers, including stale markers and dangling Singleton symlinks, must be absent.
   Probe the publisher kernel flock without deleting its inode.
5. Recheck unchanged durable fingerprints/contract, journal start intent, then issue
   one `systemctl start`. Verify exactly one publisher, its pinned executable/uid,
   new invocation identity, cgroup ownership and its publisher flock.
6. Check health and authenticated dashboard while admission is still closed.
   `/health` alone is public and only says `status: ok`; authenticated `/admin`,
   durable files and OS ownership provide the additional evidence.
7. Restore original admission, including original `false`, confirm the same sole
   publisher and durable state, then mark maintenance complete.

`journal.json` uses mode 0600, atomic rename, file fsync and directory fsync on Linux.
It records phases, original admission, invocation/PID start identities, attempt
counts and SHA-256 fingerprints/counts. Successful old journals are archived as
`restart-<runId>.complete.json` before the next cycle. No automatic evidence pruning.

Jobs, mappings, security state, policy and quota cooldown must remain unchanged from
the drained checkpoint. Only removal of already-expired quota events (older than or
equal to 24 hours at comparison) is permitted; ordered duplicate events and hashed
client identities remain accounted for. Dashboard UTC-day/rolling quota counters
are independently recomputed. Changes caused by retention, admin sessions, external
requests or another administrator may conservatively refuse recovery; they are not
silently accepted as maintenance changes.

## Failure and explicit recovery

A normal pre-stop busy/drain failure safely restores original admission only if
the same publisher is authenticated and healthy, admission is confirmed closed,
the policy settings and service contract are unchanged, and no controller
interruption or stop intent occurred. The journal records `aborted_before_stop`;
the command still exits nonzero. Uncertain mutations, changed policy, interruption
and any failure after stop intent do not automatically reopen admission.

Never invoke start/restart manually as a retry, kill Chrome, delete `Singleton*`,
remove transfer locks or edit the maintenance journal to force progress. Inspect
the protected journal, systemctl show/job/cgroup, process start identities, lock
holders, three state fingerprints and authenticated dashboard locally. Do not paste
raw environment, state or session content into logs.

After explicit owner review:

```sh
sudo /bin/sh /opt/hsr-transfer-worker-staging/scripts/infrastructure/gcp-coordinated-restart.sh --recover --authorise-controlled-restart
```

- `drained`: same original live instance and drained fingerprints are required;
  continue with one stop/start.
- `stopping`/`stopped`: require the original stop actually completed successfully,
  no processes/locks, closed admission, unchanged state and contract; proceed to start.
- `starting`: no automatic retry. A fresh owner-run recovery may issue **one** new
  attempt only after proving the previous systemd start job ended (`inactive/dead`
  or `failed/failed`, zero PIDs, no outstanding job), all process/lock checks pass
  and the drained hashes are unchanged. Each explicit invocation increments the
  durable attempt count; another failure requires another owner review.
- `started`: verify the exact already-recorded publisher and health/state, then
  restore admission; do not stop it or start another publisher.
- `restoring`: continue only while admission is still closed and the exact publisher
  and state are proven. If a previous PUT may already have restored admission,
  refuse ambiguity for manual reconciliation rather than guessing the outcome.
- `prepared`/`closing`/`draining`/`aborting`: explicit recovery may only restore
  original admission without a stop/start, after proving the same original healthy
  publisher, closed admission and unchanged policy/service contract. An uncertain
  mutation or already-open admission requires manual reconciliation. A complete or
  missing journal is not a recovery request.

Live **and stale** transfer, readonly-owner/session and Chrome Singleton markers
fail closed. A terminated owner does not authorise automatic cleanup. Reconcile the
specific marker/owner/state through the existing strict profile runbook, preserving
private evidence, then rerun inspection and separately authorise recovery.

## Regression verification

Local portable suite (real disk, JobStore, queue and authenticated HTTP; synthetic
systemd boundary):

```sh
node --test test/coordinated-worker-restart.test.mjs test/restart-systemd.integration.test.mjs
```

The Linux flock test runs automatically on Linux. Two real systemd scenarios are
opt-in and create only `/run/systemd/system/hsr-restart-fixture-*.service`, with
synthetic state, real shared flock and isolated HTTP. They cover successful restart
and explicit failed-ExecStartPre recovery. On an isolated root systemd host:

```sh
HSR_RESTART_SYSTEMD_TEST=1 node --test test/restart-systemd.integration.test.mjs
```

Fixtures stop their own services, verify zero PIDs, remove their unit and synthetic
temporary state, and reload systemd. They never address Production. The main agent
must run these against a fresh exact-commit checkout and record runtime, command,
exit code, test counts and environment. This component's local Windows results do
not establish Linux/systemd/Chrome or Production acceptance.
