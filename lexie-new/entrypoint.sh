#!/bin/bash
set -euo pipefail

DATA_ROOT="/data"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${DATA_ROOT}/.openclaw}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${DATA_ROOT}/workspace}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${DATA_ROOT}/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${DATA_ROOT}/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${DATA_ROOT}/.cache}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/lexie-runtime}"
export HOME="${HOME:-${DATA_ROOT}}"
export INTERNAL_GATEWAY_HOST="${INTERNAL_GATEWAY_HOST:-127.0.0.1}"
export INTERNAL_GATEWAY_PORT="${INTERNAL_GATEWAY_PORT:-18789}"

mkdir -p \
  "${OPENCLAW_STATE_DIR}" \
  "${OPENCLAW_WORKSPACE_DIR}" \
  "${XDG_CONFIG_HOME}" \
  "${XDG_CONFIG_HOME}/gogcli" \
  "${XDG_DATA_HOME}" \
  "${XDG_DATA_HOME}/keyrings" \
  "${XDG_CACHE_HOME}" \
  "${XDG_CACHE_HOME}/chromium" \
  "${XDG_CACHE_HOME}/ms-playwright" \
  "${XDG_RUNTIME_DIR}" \
  "${XDG_RUNTIME_DIR}/keyring"

chmod 700 "${DATA_ROOT}" "${OPENCLAW_STATE_DIR}" "${OPENCLAW_WORKSPACE_DIR}" "${XDG_RUNTIME_DIR}" || true

dbus_output="$(dbus-daemon --session --fork --print-address=1 --print-pid=1)"
export DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "${dbus_output}" | sed -n '1p')"
export DBUS_SESSION_BUS_PID="$(printf '%s\n' "${dbus_output}" | sed -n '2p')"

keyring_cmd=(gnome-keyring-daemon --start --components=secrets --control-directory="${XDG_RUNTIME_DIR}/keyring")
if [[ -n "${GOG_KEYRING_PASSWORD:-}" ]]; then
  keyring_output="$(printf '%s' "${GOG_KEYRING_PASSWORD}" | "${keyring_cmd[@]}" --unlock)"
else
  keyring_output="$("${keyring_cmd[@]}")"
fi
eval "${keyring_output}"
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK

cleanup() {
  if [[ -n "${DBUS_SESSION_BUS_PID:-}" ]]; then
    kill "${DBUS_SESSION_BUS_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

exec node /app/server.js
