# Separately approved controlled reboot

The 15 November 2026 production inspection found `/run/reboot-required` and
`libc6` in `/run/reboot-required.pkgs`. Do not clear those files or schedule an
unattended reboot. The security-update restart tool is not a reboot command.

Before a reboot, obtain explicit approval for the service interruption, bounded
IAP/OS Login recovery window and temporary backup-timer coordination described
below. A successful process restart does not establish that a required machine
reboot has been completed.

1. Verify the pinned VM identity, attached disk, current service/preflight hashes,
   valid short-lived OS Login access and IAP path. Capture the running kernel,
   reboot-required files, service state, timer enablement/next run and original
   admission. Verify a held, recoverable encrypted backup and external monitoring.
2. Hold `/run/hsr-worker-backup.flock` throughout admission closure, draining and
   stopping. Check the backup journal is complete. Persist a private maintenance
   record before closing admission. Refuse unknown or active publishing state.
3. Under the reboot-specific approval, temporarily disable the backup timer while
   preserving its prior enablement and schedule in the record. This avoids a
   `Persistent=yes` catch-up racing startup after reboot; a runtime-only mask does
   not survive reboot and is insufficient. Do not disable backup alerts.
4. Close public admission through authenticated administration and drain within
   a bounded interval. If work does not drain, restore original admission after
   confirming health and unchanged policy; restore the timer and postpone reboot.
5. Stop through the existing graceful unit. Use the established bounded stop
   deadline, inspect Node/Chrome processes, cgroup and profile/publisher locks.
   Never kill a live profile owner or delete Singleton links. Refuse reboot as
   an automated recovery technique when stop or job ownership is uncertain.
6. Verify no active/uncertain durable job or pending transfer verification, state
   preservation, admission=false and no profile owner. Keep the service enabled
   so its unchanged startup preflight can run after boot. Record the final
   checkpoint and only then issue the separately approved reboot once.
7. Reconnect within the approved bounded window. Verify the same VM/disk identity,
   new boot ID/kernel, service start result, strict preflight and exactly one
   publisher. If the unit is failed, preserve evidence and follow explicit
   recovery after proving ownership; do not repeatedly restart or reboot.
8. Verify authenticated administration, real health, jobs/mappings/security and
   quota (allow only the application's documented expiry). Restore original
   admission and read it back. Verify the protected production HTTPS endpoint
   and the external availability signal.
9. Restore the timer's original enablement only after healthy-worker acceptance.
   A missed slot may trigger a catch-up; monitor that real cycle and avoid starting
   a second backup manually. Record timer execution, journal, upload/receipt,
   worker recovery and next scheduled run separately.
10. Preserve both failure and success evidence. Clear the maintenance checkpoint
    only after the whole recovery is verified. A notification closed because of
    absent data is not a recovery proof; require fresh successful checks.

No step in this runbook has been executed by the stabilisation implementation.
It does not authorise a reboot, timer change, live process stop or lock removal.
