#!/bin/sh
set -eu
# The systemd ExecStart ancestor owns the kernel flock throughout both commands.
test "${HSR_BACKUP_FLOCK_HELD:-}" = 1
node=/opt/node-v24.22.3-linux-x64/bin/node
scripts=/opt/hsr-transfer-worker-staging/scripts/infrastructure
result="$($node "$scripts/gcp-native-backup.mjs" /etc/hsr-gcp-production/backup.json)"
printf '%s\n' "$result"
printf '%s\n' "$result" | "$node" "$scripts/gcp-spool-retention.mjs" \
  /etc/hsr-gcp-production/backup.json /etc/hsr-gcp-production/restore-baseline.json \
  --pin-namespace=gcp --apply
