#!/bin/bash
set -euo pipefail

log() {
  printf '%s [lexie-entrypoint] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")" "$*"
}

DATA_ROOT="/data"
export OPENCLAW_HOME="${OPENCLAW_HOME:-${DATA_ROOT}}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${DATA_ROOT}/.openclaw}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${DATA_ROOT}/workspace}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${DATA_ROOT}/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${DATA_ROOT}/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${DATA_ROOT}/.cache}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/lexie-runtime}"
export HOME="${DATA_ROOT}"
export INTERNAL_GATEWAY_HOST="${INTERNAL_GATEWAY_HOST:-127.0.0.1}"
export INTERNAL_GATEWAY_PORT="${INTERNAL_GATEWAY_PORT:-18789}"
umask 077

log "startup begin"
log "paths home=${OPENCLAW_HOME} state=${OPENCLAW_STATE_DIR} workspace=${OPENCLAW_WORKSPACE_DIR} xdg_config=${XDG_CONFIG_HOME} xdg_data=${XDG_DATA_HOME} xdg_cache=${XDG_CACHE_HOME} runtime=${XDG_RUNTIME_DIR}"
log "gateway host=${INTERNAL_GATEWAY_HOST} port=${INTERNAL_GATEWAY_PORT} public_port=${PORT:-unset}"

mkdir -p \
  "${OPENCLAW_STATE_DIR}" \
  "${OPENCLAW_WORKSPACE_DIR}" \
  "${OPENCLAW_WORKSPACE_DIR}/knowledge" \
  "${OPENCLAW_WORKSPACE_DIR}/skills" \
  "${OPENCLAW_WORKSPACE_DIR}/memory" \
  "${XDG_CONFIG_HOME}" \
  "${XDG_CONFIG_HOME}/gogcli" \
  "${XDG_DATA_HOME}" \
  "${XDG_DATA_HOME}/keyrings" \
  "${XDG_CACHE_HOME}" \
  "${XDG_CACHE_HOME}/chromium" \
  "${XDG_CACHE_HOME}/ms-playwright" \
  "${XDG_RUNTIME_DIR}" \
  "${XDG_RUNTIME_DIR}/keyring"

log "directories prepared"

mkdir -p /root/.openclaw
rm -rf /root/.openclaw/workspace
ln -s "${OPENCLAW_WORKSPACE_DIR}" /root/.openclaw/workspace
log "compat workspace symlink refreshed at /root/.openclaw/workspace"

if [[ ! -e /openclaw ]]; then
  ln -s /usr/local/lib/node_modules/openclaw /openclaw
  log "created /openclaw compatibility symlink"
fi

chmod 700 \
  "${DATA_ROOT}" \
  "${OPENCLAW_STATE_DIR}" \
  "${OPENCLAW_WORKSPACE_DIR}" \
  "${XDG_RUNTIME_DIR}" \
  "${XDG_RUNTIME_DIR}/keyring" || true
log "permissions adjusted"

dbus_output="$(dbus-daemon --session --fork --print-address=1 --print-pid=1)"
export DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "${dbus_output}" | sed -n '1p')"
export DBUS_SESSION_BUS_PID="$(printf '%s\n' "${dbus_output}" | sed -n '2p')"
log "dbus session started pid=${DBUS_SESSION_BUS_PID:-unknown}"

if [[ -n "${GOG_KEYRING_PASSWORD:-}" ]]; then
  log "starting gnome-keyring in unlock mode"
  keyring_output="$(printf '%s' "${GOG_KEYRING_PASSWORD}" | gnome-keyring-daemon --unlock --components=secrets --control-directory="${XDG_RUNTIME_DIR}/keyring")"
else
  log "starting gnome-keyring in start mode"
  keyring_output="$(gnome-keyring-daemon --start --components=secrets --control-directory="${XDG_RUNTIME_DIR}/keyring")"
fi
eval "${keyring_output}"
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK
log "gnome-keyring ready control=${GNOME_KEYRING_CONTROL:-unset}"

log "running bootstrap-runtime.js"
node /app/scripts/bootstrap-runtime.js
log "bootstrap-runtime.js complete"

cleanup() {
  log "cleanup begin"
  if [[ -n "${DBUS_SESSION_BUS_PID:-}" ]]; then
    kill "${DBUS_SESSION_BUS_PID}" 2>/dev/null || true
    log "dbus session stopped pid=${DBUS_SESSION_BUS_PID}"
  fi
}
trap cleanup EXIT

log "launching wrapper server"
exec node /app/server.js
