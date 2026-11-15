# Worker stability verification and deployment status

## Verified implementation evidence

All tests use synthetic state or read-only production inspection. No publishing
request, production worker restart or reboot was used as a fixture. The follow-up
is stacked on Draft PR #10; it does not overwrite or merge that PR.

The 15 November candidate verification established:

- Windows Node 24.18.0: full suite 554 tests, 526 pass, 28 platform/opt-in skips,
  zero failures at `5b126b0`.
- Independent Box source checkout, clean dependency installation, Node 24.21.0,
  Ubuntu 24.04/systemd 255: full suite 554 tests, 536 pass, 18 skips, zero failures
  at `5b126b0`, with a fresh checkout and clean dependency installation.
- Explicit Linux tests: two real coordinated-restart cases including failed-start
  recovery; one real unprivileged probe service case; seven real systemd/Chrome
  graceful-shutdown cases; 51 root spool-retention cases. All passed. These are
  overlapping targeted suites, not additional unique full-suite test totals.
- Real Caddy 2.6.2 preserved the existing Bearer and fallback routes, rejected
  probe credentials on privileged routes and returned 504 at the configured
  response-header deadline for a stalled probe.

The final 6.1 Sol review passed the loaded systemd signal/reload and restoring
admission corrections. The candidate figures above remain dated evidence for
staging and isolated verification, not an active production deployment.

## Independent review findings addressed

Needrestart review found no high-priority blocker in the captured production
snapshot. Its selection proof is limited to that snapshot and sampled services;
the documentation records the conflicting-override/hash-order limitation.

Restart review required pinned unit text and single command sets, rejection of
unapproved hooks, recovery after a failed preflight, durable admission consistency,
safe completion when a new job arrives after reopening, bounded read-only health
readiness, and validation of loaded manager signal/reload state.

Availability review required missing-checker-safe success aggregation, anonymous
requests not spending authenticated quota and rejection of late duplicate/framing
headers. Synthetic regressions reproduce those failures.

Real Linux testing found that systemd credentials can be root:root 0550/0440
private projections; the loader now accepts only that exact read-only shape in
its fixed namespace. DynamicUser D-Bus reads failed on both Box and a production
read-only transient check, so the reviewed probe uses a dedicated static system
account, no supplemental groups and no worker credentials. The real static-user
fixture passed D-Bus, proc/cgroup and monotonic-clock checks under its sandbox.

## Production evidence and approval boundary

The unchanged production unit/preflight hashes were read back. Worker PID 19392
remained active, its start timestamp remained 09:06:29 UTC, KillSignal and
RestartKillSignal were 15, and NeedDaemonReload was no. The needrestart candidate
was staged in a root-owned isolated directory and its `check` command evaluated
the actual configuration without installing the fragment. The result changes
only the exact worker selection among the checked services.

The staged Linux restart adapter was also executed in read-only mode against the
real VM at 15:37 UTC. It verified the pinned contract, live publisher/flock and
authenticated admin/health, with admission true, zero queued/running work and no
restart. This exposed two compatibility differences which were corrected:
systemd omits empty command-array properties, and the existing preflight config
is root:hsr-worker 0640. The reader permits only the explicitly identified worker
group and that exact read-only mode; live permissions remain unchanged.

No active needrestart, production worker unit, backup unit/timer, Caddy route or
Google uptime policy was changed. The three existing backup policies remain
separate. Availability monitoring is therefore **PENDING**, not active. Native
cloud alert opening/closing and email delivery are not established by a synthetic
test or payload-schema check.

The 16 November 03:00 HKT unattended backup is **PENDING** until its scheduled
time and real execution evidence. The precise proposed changes and rollback
boundary are in `gcp-worker-stability-approval.md`; restart and reboot require
separate explicit authority.

Private evidence is retained under
`D:/CodexWork/hsr-worker-stability-evidence-20261115`, including failed runs and
runtime/command/exit-code receipts. It is not part of the public repository.
