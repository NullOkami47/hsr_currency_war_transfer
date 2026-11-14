#!/bin/sh
set -eu
# Executed inside the existing ancestor-held flock. Failed uploads never prune.
/usr/bin/node /opt/hsr-backup/azure-blob-backup.mjs /etc/hsr-backup/backup.json
/usr/bin/node /opt/hsr-backup/azure-backup-retention.mjs /etc/hsr-backup/backup.json --apply
