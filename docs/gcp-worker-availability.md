# Independent worker availability candidate

Source/staging candidate only, based on `8bc3da3d29c56af7800285e52c59df8abfb47560`.
This component does not deploy itself, call Monitoring APIs, install Caddy routes,
change the worker service, contact HoYoLAB, or change the existing backup monitor.
Production installation and creation/update of cloud policies require separate
authorisation. Main integration owns the deployment bundle, real Caddy inspection
and independent Linux verification.

## Service and credentials

Copy the four `.mjs` files in `scripts/infrastructure/worker-availability/` to
`/opt/hsr-worker-availability/` as root-owned, non-writable-by-service files (directory
0755, files 0644). There are no npm dependencies. Use the candidate
`hsr-worker-availability.service` with the already installed pinned runtime
`/opt/node-v24.22.3-linux-x64/bin/node` (Node 24.22.3); verify that executable and
its parent directories are trusted and accessible before staging. Run the service
with no arguments. Do not add runtime endpoint or credential-value environment
overrides. `PORT`, `HOST`, HTTP proxy settings and worker environment variables
do not select its listener or upstream.

The unit runs as the dedicated static system account and primary group
`hsr-availability`. Its empty `SupplementaryGroups=` assignment adds no unit-level
groups; the target account must have no secondary group memberships, which the
deployment plan must verify from the target's user/group database. Main's
approval/deployment plan must validate that the account and group are absent or
already match the approved dedicated identity, create a locked `nologin` account
with no home and no secondary memberships if absent, and fail closed on name,
UID, GID or membership conflicts. Check `getent passwd hsr-availability` and
`getent group hsr-availability` before creation; do not adopt a pre-existing shared
group. The plan must also validate ownership and modes of installed files and the
credential source directory. This component does not create accounts or mutate the
live host. Do not substitute `root`, `nobody`, the worker account or a shared
service group.

The only listener is IPv4 `127.0.0.1:8790`. Only `GET /_hsr/availability` is
accepted: no query string, suffix, alternate path, body or other method. One
canonical Basic header is required; duplicate/comma-combined, malformed base64,
incorrect credentials and Bearer headers are rejected. Credentials are compared
by constant-time comparison of fixed-size SHA-256 digests. The sole application
responses are `200 {"status":"ok"}` or `503 {"status":"unavailable"}`, without
newlines or diagnostic fields, with `Cache-Control: no-store`. HEAD has no body
as required by HTTP. Connection/header parser failures and overload can also
close/drop a connection; neither is a successful uptime check.

Use a dedicated read-only health username and random password, unrelated to the
worker admin credential. Username is 1–64 ASCII letters/digits/`._-`, starting
with a letter/digit. Password is 32–128 ASCII letters/digits/`._~+/-`, with up to
two optional base64 padding `=` characters. A generated 32-byte base64 secret is
suitable. Each file can end in one LF/CRLF. Never put either secret in source,
command arguments, logs, shared evidence or chat.

| LoadCredential name | Host source file |
| --- | --- |
| `probe-username` | `/etc/hsr-worker-availability/probe-username` |
| `probe-password` | `/etc/hsr-worker-availability/probe-password` |

The host directory must be root-owned 0700 and the two regular source files
root-owned 0600, without links. systemd PID 1 projects them read-only into
`/run/credentials/hsr-worker-availability.service`; `hsr-availability` accesses that
projection, not the protected host source. The loader only accepts this exact
`CREDENTIALS_DIRECTORY`. It requires a root/current-UID owned private directory
and private regular single-link files (owner bits only, no group/other access).
Within this exact namespace it also accepts systemd's root:root read-only
projection: directory mode 0550 and regular-file mode 0440, with no special bits.
Service-user access may be granted by systemd's private projection/ACL; matching
the process GID is not required. Other group-readable modes, group/world writes,
world access and non-root ownership of this projection shape are rejected. It
rejects symlinks with lstat/O_NOFOLLOW, checks inode identity, and bounds username
and password reads to 128 and 256 bytes. Raw read buffers are zeroed after use;
Node strings remain ordinary process memory. Missing/invalid credentials prevent
startup and produce only a fixed generic error. systemd loads credentials at
service start; rotation needs an authorised sidecar restart and matching uptime
credential update. No worker admin token or `worker.env` is opened or loaded.

The candidate uses the dedicated static account, no capabilities, NoNewPrivileges,
a read-only filesystem, no writable state directory, private tmp/devices,
task/memory/CPU/FD limits and loopback-only IP access. It intentionally does not set PrivateNetwork,
ProcSubset=pid, ProtectProc=invisible or a private PID namespace: those would
obstruct existing loopback health or the required read-only worker PID checks.
It does not use MemoryDenyWriteExecute because Node/V8 requires JIT memory.
It has no Requires/PartOf/BindsTo relationship to the worker or backup service.
The static account is selected because transient DynamicUser systemctl callers
failed on production with `Transport endpoint is not connected`, while the isolated
Box's existing static unprivileged identity succeeded. The dedicated account still
requires independent acceptance under the full unit sandbox. It does not
require `libnss-systemd` or `systemd` NSS entries. The fixed user/group must still
resolve through the target's ordinary NSS configuration before starting the unit.
Sidecar `Restart=on-failure` with five starts per minute applies only to this
candidate; it does not alter the worker's restart policy.

## Local sensors and limits

The existing worker `src/worker.mjs` serves fixed GET `/health` before its
authorisation check. The sidecar calls **nonprivileged**
`http://127.0.0.1:8787/health` without any credential. This is not an authenticated
admin or session check. The worker and its external Bearer-protected routes stay
unchanged. HTTP 200 and JSON containing only `status: "ok"` are required;
duplicate status keys, wrong content type/encoding, extra fields, malformed JSON,
redirects, network failure, more than 4 KiB headers/body or a 2-second whole
request deadline fail closed. It never follows redirects or uses a proxy.

In parallel it executes this fixed command, using execFile without a shell,
without inherited secret environment, with a 1500 ms timeout and 4 KiB output cap:

```text
/usr/bin/systemctl --system show --no-pager --no-ask-password --property=Id,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStartTimestampMonotonic,NRestarts,ControlGroup hsr-worker-production.service
```

Required state is exact Id, loaded, active/running, MainPID > 0, Result=success,
positive nonfuture `ExecMainStartTimestampMonotonic`, numeric `NRestarts` and
`ControlGroup=/system.slice/hsr-worker-production.service`. Missing/duplicate
properties or denied reads fail closed. It reads only that numeric PID's
`/proc/<PID>/stat`, `status`, and `cgroup` (each bounded to 16 KiB): nonzero stable
starttime before/after, matching Pid, a live nonstopped/nonzombie state, and exact
systemd cgroup membership on cgroup v2 or v1's name=systemd hierarchy are required.
These are unprivileged read-only sensors; no root subprocess, sudo, process
signals, unit mutations, worker files, jobs, environment or Chrome profile reads
are used. This validates a current member process plus health; it does not prove
socket ownership or exercise a real publishing session. PID changes between
snapshots can safely cause a transient failed sample.

The service samples every five seconds and coalesces timer/HTTP refreshes into
one probe. Success and failure are cached for five seconds from sampling start,
not sampling completion. At most eight HTTP waiters, 32 connections and a
32-connection listen backlog are admitted. The fixed global budget starts with
24 requests and refills 12/second; excess requests return 503 without sensor work.
Headers/requests/socket inactivity have three-second limits; keepalive is one
second, one request per socket. Caddy-facing budget is global and does not trust
X-Forwarded-For. Internet floods can still cause unavailable responses; these
limits bound sidecar/upstream work, not end-to-end denial-of-service protection.

At least three observed starts within a rolling ten minutes make health fail,
even when HTTP is good. A bounded three-entry in-memory history records changed
systemd monotonic start stamps. `NRestarts` deltas additionally catch automatic
restart bursts between polls; unknown intermediate timestamps are conservatively
retained for ten minutes. The initial current start counts only if recent.
Linux `process.hrtime.bigint()` and systemd monotonic microseconds must be checked
on the target host. History is deliberately not persistent: sidecar restart loses
earlier samples, and multiple rapid manual starts between polls or starts while
the sidecar is stopped cannot be reconstructed. `NRestarts` is not a durable
history and may reset. This is a stated detection limit, not a claim of audit-grade
restart accounting.

## Caddy integration contract

`availability.caddy` is a candidate fragment for the existing HTTPS site's route
block, inserted before its Bearer matcher and fallback 401. Its exact
`handle /_hsr/availability` preserves the path and proxies to 127.0.0.1:8790, with
1-second dial and 3-second response-header deadlines. Do not use `handle_path`,
wildcards, replace the existing site, or change other external paths. The sidecar
owns Basic validation; no second Basic or Bearer gate should intercept this exact
route. Preserve the path and forward the existing Authorization header without
injecting any worker Bearer credential; other ordinary proxy headers may remain.
Main must validate the full candidate using installed Caddy 2.6.2 and test routing
order against the actual existing config. An imported handle must remain inside
the explicit route block if needed to preserve ordering.

VM, proxy or sidecar failure is detected externally by native HTTPS checks.
Backup metrics and backup-monitor execution are never consulted: healthy backups
cannot mask a dead worker, and a broken backup cannot by itself fail this probe.
A brief ordinary backup pause can fit below the alert window; a prolonged safe
drain/stop can exceed three minutes and should alert. No implicit maintenance
suppression is implemented.

## Google payload interface and current schema

`payloads.mjs` exports pure `buildUptimeCheckConfig({projectId, username, password})`,
`buildAlertPolicy({projectId, checkId, notificationChannel})` and
`buildMonitoringPayloads(input)`. Each rejects additional fields. The latter
returns `{ projectId, uptimeCheckConfig, alertPolicy }`. Its complete input is:

```javascript
{
  projectId: 'hsr-currency-war-worker',
  checkId: 'SERVER_ASSIGNED_CHECK_ID',
  notificationChannel: '13378772448236455951', // Or full same-project resource name.
  username, password // Private in-memory values from dedicated credentials.
}
```

No CLI writes/prints payloads and no API client is included. Protect the returned
uptime payload exactly like a password: `authInfo.password` necessarily contains
the private input. `maskHeaders: true` requests header masking; it does not make
locally serialised payloads safe to log. No worker credential is an input. Project
is pinned; arbitrary project/channel/filter injection is rejected. Main reported
the existing enabled notification channel above and no uptime checks on
2026-11-15; this module does not verify or mutate live channel/check state.

Creation is two-stage: build the uptime config first without checkId, and only
after a separately authorised creation use Google's assigned check ID to build
the alert policy. Uptime config `name` is omitted because the server assigns it.
Do not apply the combined object directly as an API body: each child is the body
for its respective REST resource, with the pinned project as parent. A real
checkId is required before building the combined object.

Uptime is HTTPS `worker.35-223-56-40.sslip.io:443/_hsr/availability`, GET,
`validateSsl: true`, native dedicated Basic `authInfo`, exactly status 200,
60-second period, 10-second timeout, and USA_IOWA/EUROPE/ASIA_PACIFIC check regions.
The first/only content matcher uses `MATCHES_REGEX` and the RE2 pattern
`\A\{"status":"ok"\}\z`, enforcing the complete canonical JSON body. Reviewed
`JsonPathMatcher` also supports `EXACT_MATCH`, but `$.status == "ok"` would accept
extra keys and is intentionally not used. No failure-body Cloud Logging is enabled.

Alert policy filters only `monitoring.googleapis.com/uptime_check/check_passed`
for the exact check ID/project/host and `uptime_url`. It aligns at 60 seconds using
ALIGN_NEXT_OLDER, reduces with REDUCE_COUNT_FALSE and groups only by resource
project/host and check_id. Checker labels are aggregated away: count > 1 means
at least two checker locations failed; the single resulting series must remain
above threshold for 180 seconds, with trigger count 1. This counts locations, not
necessarily two different broad regions. One ongoing outage yields one aggregate
incident instead of an incident per checker or per minute. Sampling, ingestion
and evaluation delays mean this is approximately three minutes, not a 180-second
delivery guarantee; failing checker identities may change during the window.

Notifications request OPENED and CLOSED. No renotifyInterval or per-channel
reminder strategy is set; `notificationRateLimit` is deliberately absent because
Google implements it for log-match policies, not this metric policy. Missing
data uses EVALUATION_MISSING_DATA_NO_OP. `autoClose: 604800s` closes a stale open
incident after Google's missing-data timeout; **that closure is not evidence of
health recovery**, and can still send CLOSED. Require fresh successful uptime
samples before declaring recovery. This policy does not independently detect a
failure of Google's own checker/metric ingestion service. Email deduplication,
channel delivery and cloud incident behaviour require separate authorised live
acceptance; the synthetic illustration does not prove cloud delivery.

Current official Google REST schemas were reviewed on 2026-11-15:

- [UptimeCheckConfig, HttpCheck, ContentMatcher and JsonPathMatcher](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.uptimeCheckConfigs)
- [AlertPolicy, MetricThreshold, aggregation and AlertStrategy](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies)
- [Official uptime alert JSON example](https://docs.cloud.google.com/monitoring/alerts/policies-in-json)
- [Public uptime checks](https://docs.cloud.google.com/monitoring/uptime-checks)
- [RE2 absolute anchors](https://github.com/google/re2/wiki/Syntax)
- [systemd credentials and user/group identity](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [systemd read-only D-Bus access](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html#Security)

Main's current official discovery snapshot was also read at
`D:/CodexWork/hsr-worker-stability-evidence-20261115/monitoring-discovery.json`,
SHA-256 `ba6dfa2d3171a1842e883470fff7734f4fbebc547be9f6a3eecf1d45b9c10c63`.
The optional test recursively checks generated property names, primitive types
and enums against that snapshot. This is local schema validation, not REST server
acceptance, IAM validation or proof of Monitoring API execution.

## Reproducible verification and independent Linux handoff

Local synthetic tests (no npm installation, cloud calls or HoYoLAB):

```powershell
$env:HSR_MONITORING_DISCOVERY='D:/CodexWork/hsr-worker-stability-evidence-20261115/monitoring-discovery.json'
node --test test/worker-availability.test.mjs
```

On another platform use its equivalent environment assignment. Without this
optional environment variable only the discovery test is skipped. Library test
seams accept synthetic `execute`/`readProc`, `readUnit`/`readHealth`, time and an
ephemeral test port; production entrypoint exposes none of those overrides.

Main's independent Linux acceptance must use a fresh exact-commit checkout:

1. Record SHA, OS/kernel, systemd, Node 24.22.3 and Caddy 2.6.2 versions; run the
   synthetic tests and `systemd-analyze verify` on the candidate unit. Ensure all
   code/runtime parent directories are root-owned and not service-writable.
2. On an isolated machine only, create a synthetic
   `hsr-worker-production.service` in the default system.slice, serving fixed
   loopback 8787 `/health` JSON with no upstream activity. Do not replace a real
   worker unit. Install/start the sidecar candidate and private test credentials.
3. Verify `hsr-availability` has no secondary group memberships, can read the
   private credential projection, access unprivileged systemctl show over the
   system bus and read the synthetic PID's proc files under the complete sandbox.
   Assert correct cgroup identity,
   nonfuture monotonic start and live stable process. There is no assumption that
   this succeeds merely because root can run the command. Host hidepid/LSM/D-Bus
   restrictions cause safe 503; resolve a minimal read-only permission cause or
   stop acceptance, not by running the network service as root.
4. Assert listener is 127.0.0.1 only, valid Basic gives exact 200, and bad/duplicate
   auth, other paths/methods and overload fail. Stop only the synthetic worker:
   after at most the cached sampling interval expect 503 while sidecar remains
   alive. Start/restart the synthetic worker enough times to exercise the bounded
   three-in-ten-minute threshold; distinguish prior samples from probe restart.
5. Validate the complete Caddy candidate with the exact fragment and installed
   version; test exact path and unchanged Bearer/fallback paths. Check rejection
   of extra keys, wrong responses and redirects with synthetic health fixtures.
   VM/proxy/probe-down tests require external HTTPS verification later.
6. Keep evidence of commands, exit codes, test counts, SHA and environment. Do not
   label Windows synthetic tests as Linux unit acceptance, local notification
   examples as cloud delivery, or a staged unit as a production deployment.

No systemd, proc permission, Caddy binary or live cloud acceptance is established
by the Windows test run alone. No production mutation or Monitoring API call is
performed by this component's implementation/testing workflow.
