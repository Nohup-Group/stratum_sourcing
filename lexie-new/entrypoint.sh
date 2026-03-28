#!/bin/bash
set -euo pipefail

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

mkdir -p /root/.openclaw
rm -rf /root/.openclaw/workspace
ln -s "${OPENCLAW_WORKSPACE_DIR}" /root/.openclaw/workspace

if [[ ! -e /openclaw ]]; then
  ln -s /usr/local/lib/node_modules/openclaw /openclaw
fi

chmod 700 \
  "${DATA_ROOT}" \
  "${OPENCLAW_STATE_DIR}" \
  "${OPENCLAW_WORKSPACE_DIR}" \
  "${XDG_RUNTIME_DIR}" \
  "${XDG_RUNTIME_DIR}/keyring" || true

dbus_output="$(dbus-daemon --session --fork --print-address=1 --print-pid=1)"
export DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "${dbus_output}" | sed -n '1p')"
export DBUS_SESSION_BUS_PID="$(printf '%s\n' "${dbus_output}" | sed -n '2p')"

if [[ -n "${GOG_KEYRING_PASSWORD:-}" ]]; then
  keyring_output="$(printf '%s' "${GOG_KEYRING_PASSWORD}" | gnome-keyring-daemon --unlock --components=secrets --control-directory="${XDG_RUNTIME_DIR}/keyring")"
else
  keyring_output="$(gnome-keyring-daemon --start --components=secrets --control-directory="${XDG_RUNTIME_DIR}/keyring")"
fi
eval "${keyring_output}"
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK

# Remove stale invalid keys from config (jq is available in the image)
OPENCLAW_CONFIG="${OPENCLAW_STATE_DIR}/openclaw.json"
if [[ -f "${OPENCLAW_CONFIG}" ]] && jq -e '.agents.investor' "${OPENCLAW_CONFIG}" >/dev/null 2>&1; then
  jq 'del(.agents.investor, .agents.list)' "${OPENCLAW_CONFIG}" > "${OPENCLAW_CONFIG}.tmp" \
    && mv "${OPENCLAW_CONFIG}.tmp" "${OPENCLAW_CONFIG}"
fi

node /app/scripts/bootstrap-runtime.js

# Set openai-direct as primary model (uses OPENAI_API_KEY, not Codex OAuth)
openclaw config set agents.defaults.model.primary "openai-direct/gpt-5.4" 2>/dev/null || true
openclaw config set agents.defaults.model.fallbacks '["openai-codex/gpt-5.4"]' 2>/dev/null || true

cleanup() {
  if [[ -n "${DBUS_SESSION_BUS_PID:-}" ]]; then
    kill "${DBUS_SESSION_BUS_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

exec node /app/server.js
