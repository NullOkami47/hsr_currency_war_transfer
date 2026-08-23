#!/bin/sh
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/caddy-file-metadata.sh"

WORKER_SERVICE="${CURRENCY_WAR_LOGIN_WORKER_SERVICE:-hsr-transfer-worker.service}"
SERVICE_USER="${CURRENCY_WAR_LOGIN_USER:-azureuser}"
PROFILE_DIR="${CURRENCY_WAR_PROFILE_DIR:-/var/lib/hsr-transfer-worker/browser-profile}"
RUNTIME_DIR="${CURRENCY_WAR_LOGIN_RUNTIME_DIR:-/run/hsr-currency-war-login}"
CADDYFILE="${CURRENCY_WAR_LOGIN_CADDYFILE:-/etc/caddy/Caddyfile}"
NOVNC_DIR="${CURRENCY_WAR_LOGIN_NOVNC_DIR:-/usr/share/novnc}"
DISPLAY_NUMBER="${CURRENCY_WAR_LOGIN_DISPLAY:-:99}"
VNC_PORT="${CURRENCY_WAR_LOGIN_VNC_PORT:-5900}"
NOVNC_PORT="${CURRENCY_WAR_LOGIN_NOVNC_PORT:-6080}"
UNIT_PREFIX="hsr-hoyolab-login"
APP_URL="https://act.hoyolab.com/sr/event/currency-wars/index.html?sign_type=2&auth_appid=rpqcurrencywar&authkey_ver=1&open_bbs=0&hyl_presentation_style=fullscreen&lang=en-us#/lineup/home"

usage() {
  cat <<'EOF'
Usage: sudo npm run vm:login -- start|status|stop

start   Stop the worker and open a temporary HTTPS noVNC login page.
status  Show whether temporary login mode is active (never prints its password).
stop    Remove the temporary route and graphics services, then restart the worker.
EOF
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "This command must run as root (use sudo)." >&2
    exit 1
  fi
}

validate_runtime_dir() {
  case "$RUNTIME_DIR" in
    /run/*|/var/run/*) ;;
    *)
      echo "Runtime directory must be a child of /run or /var/run." >&2
      exit 1
      ;;
  esac
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is missing: $1" >&2
    exit 1
  fi
}

unit_name() {
  printf '%s-%s.service' "$UNIT_PREFIX" "$1"
}

stop_login_units() {
  for component in chrome websockify x11vnc xvfb; do
    systemctl stop "$(unit_name "$component")" >/dev/null 2>&1 || true
  done
}

restore_caddy() {
  if [ -f "$RUNTIME_DIR/Caddyfile.backup" ] && [ -f "$RUNTIME_DIR/Caddyfile.metadata" ]; then
    restore_file_metadata \
      "$RUNTIME_DIR/Caddyfile.backup" \
      "$CADDYFILE" \
      "$RUNTIME_DIR/Caddyfile.metadata"
    caddy validate --config "$CADDYFILE" >/dev/null
    systemctl reload caddy
  fi
}

rollback_start() {
  stop_login_units
  restore_caddy || true
  systemctl start "$WORKER_SERVICE" >/dev/null 2>&1 || true
  rm -rf -- "$RUNTIME_DIR"
}

detect_login_host() {
  if [ -n "${CURRENCY_WAR_LOGIN_HOST:-}" ]; then
    printf '%s\n' "$CURRENCY_WAR_LOGIN_HOST"
    return
  fi
  awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      host = $1
      sub(/[,{].*$/, "", host)
      if (host ~ /^[A-Za-z0-9.-]+$/) { print host; exit }
    }
  ' "$CADDYFILE"
}

start_component() {
  component="$1"
  shift
  systemd-run \
    --quiet \
    --unit="$(unit_name "$component")" \
    --property="User=$SERVICE_USER" \
    --property="Environment=HOME=$USER_HOME" \
    --property="Environment=DISPLAY=$DISPLAY_NUMBER" \
    --collect \
    -- "$@"
}

wait_for_unit() {
  component="$1"
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if systemctl is-active --quiet "$(unit_name "$component")"; then
      return
    fi
    attempts=$((attempts + 1))
    sleep 0.25
  done
  echo "Temporary $component service did not start." >&2
  journalctl -u "$(unit_name "$component")" -n 20 --no-pager >&2 || true
  exit 1
}

start_login() {
  require_root
  validate_runtime_dir
  for command_name in awk caddy cut getent google-chrome install openssl pkill sed systemctl systemd-run websockify x11vnc Xvfb; do
    require_command "$command_name"
  done
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Login service user does not exist: $SERVICE_USER" >&2
    exit 1
  fi
  if [ ! -d "$PROFILE_DIR" ] || [ ! -d "$NOVNC_DIR" ]; then
    echo "The browser profile or noVNC directory is missing." >&2
    exit 1
  fi
  if [ -e "$RUNTIME_DIR/state" ]; then
    echo "Temporary login mode is already active. Run status or stop first." >&2
    exit 1
  fi

  LOGIN_HOST="$(detect_login_host)"
  if [ -z "$LOGIN_HOST" ]; then
    echo "Could not determine the public HTTPS hostname from $CADDYFILE." >&2
    exit 1
  fi
  LOGIN_PATH="$(openssl rand -hex 24)"
  VNC_PASSWORD="$(openssl rand -hex 4)"
  LOGIN_URL="https://$LOGIN_HOST/$LOGIN_PATH/vnc.html?autoconnect=true&resize=scale&path=$LOGIN_PATH/websockify"
  USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
  install -d -m 0750 -o root -g "$SERVICE_GROUP" "$RUNTIME_DIR"
  capture_file_metadata "$CADDYFILE" "$RUNTIME_DIR/Caddyfile.metadata"
  install -m 0600 "$CADDYFILE" "$RUNTIME_DIR/Caddyfile.backup"
  START_COMMITTED=0
  trap 'if [ "$START_COMMITTED" -ne 1 ]; then rollback_start; fi' EXIT HUP INT TERM

  systemctl stop "$WORKER_SERVICE"
  stop_login_units
  pkill -TERM -u "$SERVICE_USER" -f -- "--user-data-dir=$PROFILE_DIR" >/dev/null 2>&1 || true
  sleep 1

  x11vnc -storepasswd "$VNC_PASSWORD" "$RUNTIME_DIR/vnc.pass" >/dev/null
  chmod 0600 "$RUNTIME_DIR/vnc.pass"
  chown "$SERVICE_USER":"$SERVICE_GROUP" "$RUNTIME_DIR/vnc.pass"

  start_component xvfb "$(command -v Xvfb)" "$DISPLAY_NUMBER" -screen 0 1440x1000x24 -nolisten tcp
  wait_for_unit xvfb
  start_component chrome "$(command -v google-chrome)" \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --user-data-dir="$PROFILE_DIR" \
    --window-size=1440,1000 \
    "$APP_URL"
  wait_for_unit chrome
  start_component x11vnc "$(command -v x11vnc)" \
    -display "$DISPLAY_NUMBER" \
    -rfbauth "$RUNTIME_DIR/vnc.pass" \
    -rfbport "$VNC_PORT" \
    -localhost -forever -shared
  wait_for_unit x11vnc
  start_component websockify "$(command -v websockify)" \
    --web "$NOVNC_DIR" \
    "127.0.0.1:$NOVNC_PORT" \
    "127.0.0.1:$VNC_PORT"
  wait_for_unit websockify

  cat >"$RUNTIME_DIR/Caddyfile.new" <<EOF
$LOGIN_HOST {
    encode zstd gzip

    handle_path /$LOGIN_PATH/* {
        reverse_proxy 127.0.0.1:$NOVNC_PORT
    }

    handle {
        reverse_proxy 127.0.0.1:8787
        header -Server
    }
}
EOF
  caddy validate --config "$RUNTIME_DIR/Caddyfile.new" >/dev/null
  install -m 0644 "$RUNTIME_DIR/Caddyfile.new" "$CADDYFILE"
  systemctl reload caddy

  printf 'LOGIN_HOST=%s\nLOGIN_PATH=%s\nLOGIN_URL=%s\n' \
    "$LOGIN_HOST" "$LOGIN_PATH" "$LOGIN_URL" >"$RUNTIME_DIR/state"
  chmod 0600 "$RUNTIME_DIR/state"
  rm -f "$RUNTIME_DIR/Caddyfile.new"
  START_COMMITTED=1
  trap - EXIT HUP INT TERM

  echo "Temporary HoYoLAB login mode is active."
  echo "Login URL: $LOGIN_URL"
  echo "VNC password: $VNC_PASSWORD"
  echo "Run 'sudo npm run vm:login -- stop' immediately after login."
}

show_status() {
  require_root
  validate_runtime_dir
  if [ ! -f "$RUNTIME_DIR/state" ]; then
    echo "Temporary HoYoLAB login mode is not active."
    systemctl is-active "$WORKER_SERVICE" || true
    return
  fi
  LOGIN_URL="$(sed -n 's/^LOGIN_URL=//p' "$RUNTIME_DIR/state")"
  echo "Temporary HoYoLAB login mode is active."
  echo "Login URL: $LOGIN_URL"
  echo "VNC password is intentionally not shown again."
  for component in xvfb chrome x11vnc websockify; do
    printf '%s: ' "$component"
    systemctl is-active "$(unit_name "$component")" || true
  done
  printf 'worker: '
  systemctl is-active "$WORKER_SERVICE" || true
}

stop_login() {
  require_root
  validate_runtime_dir
  for command_name in caddy install systemctl; do
    require_command "$command_name"
  done
  stop_login_units
  restore_caddy
  rm -rf -- "$RUNTIME_DIR"
  systemctl start "$WORKER_SERVICE"
  echo "Temporary login mode stopped; Caddy was restored and the worker restarted."
}

case "${1:-}" in
  start) start_login ;;
  status) show_status ;;
  stop) stop_login ;;
  *) usage; exit 2 ;;
esac
