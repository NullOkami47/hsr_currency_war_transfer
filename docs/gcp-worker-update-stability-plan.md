# GCP worker update stability: design and implementation plan

## Authority and baseline

The owner authorised investigation, implementation, isolated testing and staging on
15 November 2026. Applying a live restart-behaviour change requires a separate
approval of the exact reviewed package. No worker restart, reboot, live publishing
test, backup encryption/key change, Azure change or PR #10 merge is authorised.

This follow-up builds on PR #10 at `8bc3da3d29c56af7800285e52c59df8abfb47560`.
The deployed backup overlay remains `0cf25ff70d13f85cad6cbc8250e03707022cce94`.
Keep the follow-up branch separate and initially target the PR #10 branch so its
diff is limited to the stabilisation work. Retarget after normal integration.

## Three changes

1. Add a locally managed needrestart `.conf` fragment that augments `override_rc`
   for exactly `hsr-worker-production.service`. Keep security updates and all
   other restart selections. Verify the installed Ubuntu 24.04 Perl semantics,
   selection and a list-only scan; never trigger a libc upgrade or real restart.
2. Add an explicitly authorised coordinated restart command. Reuse the existing
   backup flock, journal the original admission, close/drain and verify durable
   state, stop gracefully, prove exclusive ownership, start once, verify state
   and authenticated health, then restore admission. Interrupted or uncertain
   states require explicit reconciliation. Never remove Chrome locks or weaken
   admission preflight; retain `Restart=no` on the production worker.
3. Add an independent, credential-protected, minimal availability probe behind
   one exact Caddy path. The separate loopback process checks the actual worker
   service and existing fixed loopback health response. It does not read the
   worker administrator credential. Google Cloud uptime checks inspect this
   HTTPS path every minute from multiple locations. A sustained failure opens
   one incident; recovery closes it. The probe has no worker administration
   credential. Use a separate read-only probe credential for the uptime check.

The alternatives were using the worker administrator token directly in an uptime
check, or depending on the existing hourly backup monitor. The former grants an
external checker unnecessary privileges; the latter cannot meet the detection
deadline and conflates backup freshness with availability. A dedicated local
probe and native external uptime check avoid both problems without another VM.

## Implementation checklist

- [x] Read actual needrestart/APT/systemd/drop-ins/preflight/timer configuration,
  hashes, incident logs and current authenticated worker health without restarting.
- [x] Establish isolated D-drive branch and passing baseline test suite.
- [ ] Implement exact needrestart selection and reversible, drift-aware install.
- [ ] Implement restart/recovery command and state/ownership regression tests.
- [ ] Implement independent probe, uptime policy and synthetic failure tests.
- [ ] Validate Caddy candidate, systemd units and least-privilege probe credentials.
- [ ] Run full relevant suite and exact-commit fresh Ubuntu/Box verification.
- [ ] Obtain independent reviews; correct findings; commit and open follow-up PR.
- [ ] Present reviewed live changes, hashes and rollback with the approval request.
- [ ] Apply only after explicit approval; verify without restarting the worker.
- [ ] Observe the 16 November 03:00 HKT backup only after that scheduled time.

## Regression contract

Tests cover exact service selection and near-name rejection, unchanged security
update policy, active/queued/uncertain jobs, original admission true/false,
shutdown crash, live/stale Chrome locks, start failure and explicit recovery,
single publisher and no strategy replay, shared backup lock, healthy backup with
failed worker, unhealthy HTTPS/body, repeated starts, sustained alert thresholds,
recovery notifications and deduplication. Real systemd and Perl behaviour is
verified on isolated Ubuntu using synthetic state, never production credentials.

## Operational limits

An excluded service can retain old loaded libraries until a controlled restart.
The current VM has `/run/reboot-required` naming `libc6`; provide a controlled
reboot runbook and retain the separate reboot approval boundary. A clean backup
metric does not prove availability. The next unattended backup remains unverified
until real timer, journal, object and health evidence after 16 November 03:00 HKT.
