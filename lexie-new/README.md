# lexie-new

Standalone OpenClaw Railway service for the Lexie migration. This service is separate from the FastAPI app in the repository root and is intended to replace the old `lexie-openclaw` Railway service only after the copied runtime has been validated.

## Service shape

- Base image: `node:22-bookworm`
- OpenClaw pinned to `2026.3.13`
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
- materializes the managed workspace payload from `/app/workspace` into `/data/workspace`
- patches `/data/.openclaw/openclaw.json` with the required Phase 1 memory + skills defaults
- generates backfill manifests and transcript shards under `/data/workspace/knowledge/backfill`

After that it starts a session DBus bus and a secrets-only `gnome-keyring-daemon`
before starting the Node wrapper so `gog` can keep credentials on the persistent volume.

## Railway provisioning

1. Create a new service named `lexie-new` in project `Stratum3`.
2. Point the service source to `Nohup-Group/stratum_sourcing` with `rootDirectory=/lexie-new`.
3. Set builder to `DOCKERFILE`.
4. Attach a new empty volume at `/data`.
5. Batch-copy the old Lexie service variables, excluding Railway runtime variables, `PORT`, `HOME`, and `PWD`.
6. Rotate `OPENCLAW_GATEWAY_TOKEN` for `lexie-new`.

## Empty-volume validation

Bring the new service up once with the empty volume and confirm:

- `/healthz` becomes healthy
- `openclaw --version` reports `2026.3.13`
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

The container copies these into `/data/workspace` on startup without deleting
other non-managed files already present on the volume.

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
