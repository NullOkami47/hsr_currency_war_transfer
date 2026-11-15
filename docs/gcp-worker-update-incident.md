# GCP worker outage caused by automatic service restart

## Verified incident

On 15 November 2026, Ubuntu unattended upgrades installed libc6, libc-bin and
locales updates. The VM's `unattended-upgrades-dpkg.log` explicitly lists
`systemctl restart ... hsr-worker-production.service ...`. The worker stopped
gracefully at 06:38:30.544437 UTC. Its restart failed with
`PREFLIGHT_ADMISSION_OPEN` because persisted public admission remained enabled.
The service's deliberate `Restart=no` policy left it failed.

The existing worker was recovered at 09:06:29.574377 UTC and authenticated
administration plus health were verified at 09:06:30.601 UTC. The systemd
stopped-to-started interval was 8,879.030 seconds. The recovery preserved the
original jobs file, temporarily closed admission while no publisher existed,
started through the unchanged preflight and restored original admission. Jobs,
mappings and security state were unchanged; four expired quota events were
removed by the existing 24-hour rule. No live publishing test was performed.

This was an OS package-update restart after the backup acceptance, not another
backup-maintenance invocation. The backup health metric remained zero because
the recent backup was healthy. That metric does not measure worker availability.

## Production inspection for this follow-up

At 12:52 UTC on 15 November, the real VM ran Ubuntu 24.04 packages needrestart
3.6-7ubuntu4.5, systemd 255.4-1ubuntu8.18 and libc6 2.39-0ubuntu8.12. The worker
was active/running at PID 19392 with 37 terminal jobs (33 completed, four failed),
39 mappings and no pending transfer verification. Both loopback and the existing
protected production HTTPS health path returned HTTP 200 and `status: ok`.

Effective worker settings were `Restart=no`, `RestartSec=100ms`,
`StartLimitIntervalSec=10s`, `StartLimitBurst=5`, `TimeoutStopSec=240s`,
`KillMode=mixed` and `SendSIGKILL=no`. The deployed graceful-stop drop-in uses
`flock --no-fork` so Node owns shutdown and Chrome closes before lock release.
The strict startup preflight remains required.

APT security origins and `APT::Periodic::Unattended-Upgrade=1` were enabled.
The needrestart APT hook uses Ubuntu mode `-m u`, which automatically restarts
eligible services. No worker-specific override existed. The VM's
`/run/reboot-required.pkgs` named libc6; that flag is an outstanding maintenance
requirement, not authority to reboot.

The existing daily backup timer remained enabled/active for 03:00
Asia/Hong_Kong, next due 16 November 2026. The three backup-monitoring policies
remained enabled. No native Google uptime check existed at inspection.

## Policy

Keep unattended security package installation. Exclude only the production
worker from needrestart's automatic restart selection, using the documented
`override_rc` mechanism and an exact service-name match. A local `.conf` file
under `/etc/needrestart/conf.d/` is loaded after the packaged defaults, retaining
unrelated overrides. It is a local configuration addition, not an edit to a
package-owned script or the global update policy.

The trade-off is explicit: a protected worker may retain outdated loaded
libraries until an approved coordinated restart. Schedule that restart promptly
after security updates; do not treat exclusion as permanent patch deferral.
Keep the worker's `Restart=no`: repeated uncoordinated starts cannot establish
admission, durable-job or profile ownership safety.

## Official source and verification limitation

Ubuntu's “needrestart changes in Ubuntu 24.04: service restarts” documents
`override_rc` and a `.conf` snippet for excluding an individual service:

`https://discourse.ubuntu.com/t/needrestart-changes-in-ubuntu-24-04-service-restarts/44671`

The installed `/usr/share/doc/needrestart/README.Ubuntu`, packaged configuration
and `/usr/sbin/needrestart` were also inspected. `-b` batch output lists detected
services before evaluating `override_rc`; it cannot alone prove restart
exclusion. Verify effective Perl selection and use explicit list-only mode
without relying on batch output as selection evidence. Never run automatic mode
against production to test the exclusion.

Private configuration snapshots, hashes, service output and original incident
logs remain outside Git. Production application and the future scheduled backup
must have their own dated evidence; source tests alone prove neither.
