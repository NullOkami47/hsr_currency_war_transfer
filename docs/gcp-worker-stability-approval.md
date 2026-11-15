# Production change approval package

## Current boundary

Investigation, implementation, staging and isolated tests are authorised. The
changes below are proposed, not active. Applying them requires explicit owner
approval. Worker restart, reboot, live publishing tests, Vercel/Azure changes,
backup encryption/key changes and merging PR #10 remain outside this approval.

## Exact proposed changes

1. Install `/etc/needrestart/conf.d/99-hsr-worker-production.conf`, root:root 0644:

   ```perl
   $nrconf{override_rc}->{qr(\Ahsr-worker-production\.service\z)} = 0;
   ```

   Complete file SHA-256 is
   `4b4ee4458764e1200f1b627549e8a74577b132f619bd173e8f3f38eef5992f81`.
   The staged checker uses the actual installed needrestart selection stanza.
   Its production plan approval hash is
   `22c0bd94366beab1f7ddbd8feb10f8913b7b9d39d9b63332815178afd120a169`.
   Any configuration drift invalidates this plan. The package-owned APT hook,
   security origins and all unattended-upgrades settings remain unchanged.

2. Install the reviewed coordinated restart command and its three helper files
   under the existing infrastructure directory, root-owned and not worker-writable.
   Create `/var/lib/hsr-worker-maintenance-control` root:root 0700. **Do not run the
   restart command.** Preserve the existing backup journal and shared flock.

3. Create a dedicated locked system account/group `hsr-availability` if absent,
   with `/nonexistent` home, `/usr/sbin/nologin`, no supplemental groups and no
   worker-group membership. Reject any conflicting existing identity. Install
   only `server.mjs`, `probe.mjs`, `credentials.mjs` under
   `/opt/hsr-worker-availability` as root-owned read-only code. Create independent
   probe username/password files under root-only `/etc/hsr-worker-availability`,
   0600; never copy worker administrative credentials.

4. Install and enable `hsr-worker-availability.service` from this commit. It runs
   as the dedicated unprivileged account, loads only the probe credential and
   listens at 127.0.0.1:8790. Its own bounded restart policy does not change
   `hsr-worker-production.service`. Starting the probe does not restart the worker.

5. Add only the exact `/_hsr/availability` handle to the existing Caddy site,
   with 1-second dial and 3-second response-header bounds. The captured original
   Caddyfile SHA-256 is
   `63816761f78e798869b08edf40bd466f54c2b18f10603e0c62f5f0710010a637`;
   the complete proposed file SHA-256 is
   `c5cf3f1d916b5f937674089024968399c38b2ee999cf4b1706e1899b4364cd69`.
   Preserve the existing Bearer and fallback routes, validate the full candidate,
   then use Caddy's graceful reload. Do not restart Caddy or change Vercel.

6. Create one native Google HTTPS uptime check from the reviewed payload builder:
   host `worker.35-223-56-40.sslip.io`, exact probe path, port 443, strict TLS,
   exact healthy body, dedicated Basic credential, 60-second period and three
   checker regions. Create one sustained-failure policy: at least two failing
   locations for 180 seconds, one resource/check incident, OPENED/CLOSED notices,
   no repeated renotify. Reuse authorised channel
   `projects/hsr-currency-war-worker/notificationChannels/13378772448236455951`.
   New resource IDs exist only after creation and must be recorded then.

## Before applying

Re-read the worker's authenticated administration, actual health, PID/cgroup and
durable state. Require no queued/running/uncertain publishing jobs or pending
verification. Recheck the production plan hash and captured configuration hashes.
Confirm backup service/timer and policies `6473563072822992431`,
`2689805350974814162`, `10121792019042862252` remain intact. Save all old files,
metadata and hashes privately before a write. Apply once; inspect ambiguous
results instead of automatic retries.

Verify the new probe locally and over HTTPS using its private credential without
printing it. Missing/wrong credentials must expose no details; original worker
authentication must still work. Read back the uptime/policy definitions, wait for
real successful uptime samples, and confirm the original worker PID/start time.
No live outage or libc upgrade is necessary to prove this configuration. Cloud
alert-delivery acceptance remains separately labelled until actual evidence exists.

## Rollback

- Use `needrestart/deployment.mjs rollback-check --transaction UUID`, review its
  exact plan, then `rollback --transaction UUID --approve SHA256`. It restores the
  saved fragment or removes only the newly added fragment; drift blocks rollback.
- Disable only the newly created availability alert/check if reverting; leave all
  three backup policies enabled. Record resource IDs before changing them.
- Restore the captured Caddyfile only if its current hash equals this deployment's
  candidate; validate and gracefully reload. Unrelated concurrent edits require
  reconciliation, not overwrite.
- Stop/disable only `hsr-worker-availability.service`, then restore prior unit/code
  if any. Preserve evidence/credentials privately. Do not delete an account or
  directory merely because it has the same name; removal requires proven ownership
  and no running processes, otherwise retain the harmless disabled account.
- The coordinated restart tool is inert until explicitly invoked; leaving its
  reviewed files installed does not change worker behaviour.

If worker availability unexpectedly degrades, prioritise service diagnosis and
the previously authorised existing-worker recovery boundaries. Never force-kill
Chrome, remove locks, weaken preflight or start a second publisher.

## Scheduled backup observation

The next run is **16 November 2026 03:00 HKT = 15 November 2026 19:00 UTC**.
It remains pending before that time. Afterward, use read-only timer/service
timestamps, backup journal/status, worker journal, Chrome/profile cleanup,
admission and state comparisons, GCS ciphertext/receipt, backup metrics and real
worker health. A successful manual acceptance or a future timestamp is not
evidence of unattended success. Preserve any failure and recover production first.

The current session has no callable scheduling facility for an assistant follow-up.
No extra cloud schedule, local always-on watcher or production backup trigger is
created by this package. Run the documented observation after the due time; do not
claim that an observation has been scheduled or completed.
