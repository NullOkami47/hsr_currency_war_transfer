#!/bin/sh
set -eu

capture_file_metadata() {
  source_path="$1"
  metadata_path="$2"
  stat -c '%a %u %g' "$source_path" >"$metadata_path"
  chmod 0600 "$metadata_path"
}

install_file_with_metadata() {
  source_path="$1"
  target_path="$2"
  metadata_path="$3"
  IFS=' ' read -r mode owner group extra <"$metadata_path"
  case "$mode" in ''|*[!0-7]*) echo "Invalid saved file mode." >&2; return 1 ;; esac
  case "$owner" in ''|*[!0-9]*) echo "Invalid saved file owner." >&2; return 1 ;; esac
  case "$group" in ''|*[!0-9]*) echo "Invalid saved file group." >&2; return 1 ;; esac
  if [ -n "${extra:-}" ]; then
    echo "Invalid saved file metadata." >&2
    return 1
  fi
  install -m "$mode" -o "$owner" -g "$group" "$source_path" "$target_path"
}

restore_file_metadata() {
  install_file_with_metadata "$1" "$2" "$3"
}

if [ "${0##*/}" = "caddy-file-metadata.sh" ]; then
  case "${1:-}" in
    capture)
      [ "$#" -eq 3 ] || { echo "Usage: $0 capture SOURCE METADATA" >&2; exit 2; }
      capture_file_metadata "$2" "$3"
      ;;
    install)
      [ "$#" -eq 4 ] || { echo "Usage: $0 install SOURCE TARGET METADATA" >&2; exit 2; }
      install_file_with_metadata "$2" "$3" "$4"
      ;;
    restore)
      [ "$#" -eq 4 ] || { echo "Usage: $0 restore BACKUP TARGET METADATA" >&2; exit 2; }
      restore_file_metadata "$2" "$3" "$4"
      ;;
    *)
      echo "Usage: $0 capture SOURCE METADATA | install SOURCE TARGET METADATA | restore BACKUP TARGET METADATA" >&2
      exit 2
      ;;
  esac
fi
