# lexie-new

Standalone OpenClaw Railway service for the Lexie migration. This service is separate from the FastAPI app in the repository root and is intended to replace the old `lexie-openclaw` Railway service only after the copied runtime has been validated.

## Service shape

- Base image: `node:22-bookworm`
- OpenClaw pinned to `2026.3.28`
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
- `openclaw --version` reports `2026.3.28`
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

## Model defaults

- Preferred default model: `openai-codex/gpt-5.4` when an `openai-codex:*` auth profile exists in the live config
- Fallback default model: `openai-direct/gpt-5.4` when Codex auth is absent but `OPENAI_API_KEY` is available
- Default thinking level: `high`
- Memory embeddings stay on OpenAI with `text-embedding-3-small`

## OpenClaw 2026.3.28 notes

- Official npm `latest` tag as of March 30, 2026 is `2026.3.28`.
- Relevant upgrade note: newer OpenClaw builds harden local-direct `trusted-proxy` fallback behavior. Lexie already writes an explicit gateway token into config and now also passes that token into the child gateway env so browser and relay helpers can resolve it reliably.
- Relevant upgrade note: config and doctor no longer auto-migrate very old configs. Lexie keeps patching the live `/data/.openclaw/openclaw.json` in place on every boot, so the service should stay on a current config shape instead of relying on old auto-migrations.
- Not expected to affect Lexie:
  - `qwen-portal-auth` removal
  - QMD-specific memory changes, because Lexie uses OpenAI embeddings instead of QMD
  - `/fast` behavior changes, because Lexie does not force fast mode

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
