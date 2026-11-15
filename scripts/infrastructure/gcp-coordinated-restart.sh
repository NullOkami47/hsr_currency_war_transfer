#!/bin/sh
set -eu
umask 077
# Existing shared backup lock; never truncate or replace its inode.
test "$(/usr/bin/id -u)" = 0 || { printf '%s\n' 'Root required.' >&2; exit 1; }
lock=/run/hsr-worker-backup.flock
test -f "$lock" && test ! -L "$lock"
exec 9<>"$lock"
/usr/bin/flock --nonblock --conflict-exit-code 75 9 || exit 75
# Node verifies the inherited FD has this exact inode and an exclusive kernel
# FLOCK. HSR_BACKUP_FLOCK_HELD or any other environment flag is not authority.
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /opt/node-v24.22.3-linux-x64/bin/node \
  /opt/hsr-transfer-worker-staging/scripts/infrastructure/coordinated-worker-restart.mjs "$@"
