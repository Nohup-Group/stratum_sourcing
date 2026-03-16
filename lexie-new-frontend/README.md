# Stratum Lexie Frontend

Standalone Vite frontend for the `lexie-new` service. It provides a Stratum-branded chat UI with browser-scoped sessions, OpenClaw websocket chat, attachments, archived sessions, and theme switching.

## Scope

Included:

- Stratum branding (`Rethink Sans`, `#4E00FF`, light mode by default)
- Anonymous browser session identity via `localStorage`
- Session CRUD against `lexie-new` REST APIs
- OpenClaw websocket chat through `/api/openclaw/ws`
- Web search toggle and session verbosity/follow-up controls

Removed from the source app:

- Teams/MSAL flows
- Cloudflare auth helpers
- Project switching
- Dataroom search
- Evidence and file preview UI
- Admin and print settings

## Local Development

Prerequisites:

- Node.js 18+
- `pnpm` 8+
- A running `lexie-new` instance on `http://localhost:8080` or another reachable URL

Install and run:

```bash
pnpm install
pnpm dev
```

The Vite dev server proxies both REST and websocket traffic to `LEXIE_NEW_URL`.

## Environment

Use `.env` for local development:

```env
LEXIE_NEW_URL=http://localhost:8080
```

`LEXIE_NEW_URL` should point to the public or internal `lexie-new` service URL that exposes:

- `/api/sessions`
- `/api/agent/chat-capabilities`
- `/api/openclaw/ws`

## Railway Deployment

This app is intended to run as a separate Railway service with:

- root directory: `lexie-new-frontend/`
- build: Dockerfile
- static files served by Caddy
- `/api/openclaw/ws` rewritten to `/` and proxied to `lexie-new`
- `/api/*` proxied to `lexie-new`

Runtime env vars:

- `LEXIE_NEW_URL`: internal URL for the `lexie-new` service, for example `http://lexie-new.railway.internal:8080`

## Verification

```bash
pnpm test
pnpm build
```
