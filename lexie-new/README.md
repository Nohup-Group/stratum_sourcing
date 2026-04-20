# lexie-new

Standalone OpenClaw Railway service for the Lexie migration. This service is separate from the FastAPI app in the repository root and is intended to replace the old `lexie-openclaw` Railway service only after the copied runtime has been validated.

## Service shape

- Base image: `node:22-bookworm`
- OpenClaw pinned to `2026.4.15`
- `gog` pinned to `v0.12.0`
- Public wrapper port: `PORT` (Railway)
- Internal loopback gateway port: `INTERNAL_GATEWAY_PORT` (defaults to `18789`)
- Persistent volume mount: `/data`

## Runtime layout

- OpenClaw state: `/data/.openclaw`
- OpenClaw workspace: `/data/workspace`
- XDG config: `/data/.config`
- XDG data: `/data/.local/share`
- XDG cache: `/data/.cache`

The entrypoint now also:

- exports `OPENCLAW_HOME=/data` so OpenClaw resolves its active workspace from the volume
- maintains a compatibility symlink for old `/openclaw/skills/*` references
- seeds missing bootstrap files and knowledge docs from `/app/workspace` into `/data/workspace`
- syncs repo-managed skills from `/app/workspace/skills` into `/data/workspace/skills` on every boot
- patches the existing `/data/.openclaw/openclaw.json` in place instead of deleting it
- generates backfill manifests and transcript shards under `/data/workspace/knowledge/backfill`

After that it starts a session DBus bus and a secrets-only `gnome-keyring-daemon`
before starting the Node wrapper so `gog` can keep credentials on the persistent volume.

## Auth and secret split

- Internal staff API access is only trusted when the request comes from the frontend proxy with:
  - `Authorization: Bearer $OPENCLAW_CONTROL_UI_PROXY_TOKEN`
  - a forwarded user email ending in `@nohup.group`
- Investor access still uses the invite/session cookie flow.
- `X-Lexie-Client-Id` is only a session partition key. It is not authentication.

Use separate secrets for separate responsibilities:

- `OPENCLAW_GATEWAY_REMOTE_TOKEN`: remote gateway/device/admin token
- `OPENCLAW_CONTROL_UI_PROXY_TOKEN`: frontend-to-backend trusted proxy secret
- `OPENCLAW_CONTROL_UI_PASSWORD`: optional direct-login password for non-Railway/local environments only

On Railway production, the backend does not expose a direct password login page for `/openclaw`; the supported path is the Cloudflare-protected frontend route at `lexie.stratum3.org/openclaw`.

## Railway provisioning

1. Create a new service named `lexie-new` in project `Stratum3`.
2. Point the service source to `Nohup-Group/stratum_sourcing` with `rootDirectory=/lexie-new`.
3. Set builder to `DOCKERFILE`.
4. Attach a new empty volume at `/data`.
5. Batch-copy the old Lexie service variables, excluding Railway runtime variables, `PORT`, `HOME`, and `PWD`.
6. Set a dedicated `OPENCLAW_GATEWAY_REMOTE_TOKEN` for `lexie-new`.
7. Set a separate `OPENCLAW_CONTROL_UI_PROXY_TOKEN` shared only between the frontend and backend services.

The backend still accepts legacy `OPENCLAW_GATEWAY_TOKEN` as a fallback input for the remote token during migration, but new deploys should use the split variables explicitly.

## Empty-volume validation

Bring the new service up once with the empty volume and confirm:

- `/healthz` becomes healthy
- `openclaw --version` reports `2026.4.15`
- `gog version` reports `v0.12.0`
- the wrapper restarts OpenClaw if the child exits

## Volume migration

1. Stream `/data` from old Lexie into a local tarball.
2. Extract that tarball into the new service volume mounted at `/data`.
3. Confirm `/data/.openclaw/openclaw.json` and `/data/workspace` exist on `lexie-new`.
4. Generate a session manifest from `/data/.openclaw/agents/main/sessions` before cleanup.
5. Apply the config mutations:
   - `session.dmScope = "per-channel-peer"`
   - `agents.defaults.memorySearch.provider = "openai"`
   - `agents.defaults.memorySearch.model = "text-embedding-3-small"`
   - `agents.defaults.memorySearch.experimental.sessionMemory = true`
   - `agents.defaults.memorySearch.sources = ["memory", "sessions"]`
   - enable remote batch indexing
   - `skills.load.extraDirs = ["/data/workspace/skills"]`

## Workspace payload

Managed bootstrap files and Stratum-specific knowledge/skills live in:

- `/app/workspace/*.md`
- `/app/workspace/knowledge/**/*`
- `/app/workspace/skills/**/*`

Ownership is intentionally split:

- Volume-owned and persistent:
  - `/data/.openclaw/openclaw.json`
  - `/data/workspace/*.md`
  - `/data/workspace/knowledge/**/*`
  - `/data/workspace/memory/**/*`
  - generated backfill outputs
- Repo-managed and deploy-updated:
  - `/data/workspace/skills/**/*`

The container only seeds missing mutable docs and knowledge files. It does not overwrite reviewed memory/bootstrap content already present on the volume. Skills are the only workspace subtree that is force-synced on each boot.

Bootstrap state is tracked in `/data/.lexie-bootstrap-state.json` so future migrations can run once without clobbering reviewed docs.

## Codex OAuth auto-refresh

A small Node script (`scripts/refresh-codex-if-needed.js`) is scheduled by the wrapper to keep the `openai-codex:default` OAuth profile fresh without a human in the loop.

Schedule:

- Runs once 60 s after wrapper startup (defensive catch for containers that came up with a near-expiry token).
- Runs again daily at 03:00 UTC (low-traffic slot) via an in-process `setTimeout` + `setInterval` chain in `server.js`.

Behaviour:

- Reads `/data/.openclaw/agents/main/agent/auth-profiles.json`.
- If the profile's `expires` is more than `CODEX_AUTO_REFRESH_THRESHOLD_HOURS` in the future (default `48`), it logs healthy and exits.
- If the profile is inside the threshold, it POSTs to `OAUTH_MINTER_URL` (default `https://oauthminter-production.up.railway.app/mint`) with `Authorization: Bearer $OAUTH_MINTER_API_KEY`, writes a timestamped backup of `auth-profiles.json`, atomically overwrites the file with the newly minted access/refresh/expires, and kills the running OpenClaw gateway child so the wrapper respawns it and re-reads the file (OpenClaw otherwise caches the old refresh token in memory and would hit `refresh_token_reused`).

Env vars:

- `OAUTH_MINTER_API_KEY` (required to enable) — bearer token for the oauth minter service.
- `OAUTH_MINTER_URL` (optional) — override the mint endpoint.
- `CODEX_AUTO_REFRESH_THRESHOLD_HOURS` (optional, default `48`) — refresh when the token has this many hours or fewer remaining.
- `CODEX_AUTO_REFRESH_DRY_RUN=1` (optional) — log the decision but do not call the minter or touch the file.

## Model defaults

- Preferred default model: `openai-codex/gpt-5.4` when an `openai-codex:*` auth profile exists in live agent state
- Codex stays the only default path when that auth profile is present; direct OpenAI is only used if Codex auth is absent and `OPENAI_API_KEY` is available
- Default thinking level: `high`
- Memory embeddings stay on OpenAI with `text-embedding-3-small`

## OpenClaw 2026.4.15 notes

- Official npm `latest` tag as of April 16, 2026 is `2026.4.15`.
- Built-in auth monitoring lands in this release: `openclaw models status --check` (exit `0` ok, `1` expired/missing, `2` expiring soon) and a new `models.authStatus` gateway method. The Control UI Overview now shows a Model Auth status card with callouts for expiring/expired OAuth tokens.
- Codex-acp subprocess teardown is now graceful on EPIPE, so the gateway no longer crashes when the codex app-server child exits abruptly.
- Stale `openai-codex` native transport metadata self-heals on runtime and discovery instead of routing through the broken Cloudflare HTML path.
- The `openai-codex` refresh path now falls back to the cached access token when refresh fails on accountId extraction, so transient refresh hiccups do not immediately take the agent offline.
- WhatsApp/Baileys reconnect drains the pending per-auth `creds.json` save queue before reopening sockets, reducing the likelihood of a stray 401 on reconnect restoring from backup.
- `openclaw security audit` gates `config.patch` / `config.apply` calls from the model-facing gateway tool when they would newly enable flags like `dangerouslyDisableDeviceAuth`. Lexie sets that flag at bootstrap time before the gateway starts (not via the tool), so the flag continues to apply, but any model-tool-driven re-enable is blocked.
- Previous upgrade notes still apply: newer OpenClaw builds harden local-direct `trusted-proxy` fallback behavior (Lexie already writes an explicit gateway token into config and passes it into the child gateway env), and config/doctor no longer auto-migrate very old configs (Lexie keeps patching the live `/data/.openclaw/openclaw.json` in place on every boot).
- Not expected to affect Lexie:
  - `qwen-portal-auth` removal
  - QMD-specific memory changes, because Lexie uses OpenAI embeddings instead of QMD
  - `/fast` behavior changes, because Lexie does not force fast mode
  - Default Anthropic selection bump to Claude Opus 4.7 (Lexie uses `openai-codex/gpt-5.4` as primary)

## Cutover

1. Stop old Lexie so channels are not double-consumed.
2. Run a final full `/data` sync from old Lexie to `lexie-new`.
3. Start `lexie-new`.
4. Validate:
   - `openclaw config validate` succeeds
   - memory no longer reports local `node-llama-cpp` failures
   - a known historical phrase is retrievable through memory search
   - WhatsApp DM sessions split per peer
   - `gog` works for Gmail, Calendar, and Drive after restart
   - Control UI and gateway auth work with the rotated token

## Rollback

If validation fails, stop `lexie-new`, restart the old `lexie-openclaw` service, and leave the new copied volume untouched for debugging.
