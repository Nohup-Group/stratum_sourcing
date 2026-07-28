# Stratum³ Sourcing Console

Password-gated dashboard over the sourcing pipeline: funnel overview, ranked top
picks, per-company 200-signal scans with evidence, the signal library, and the
source registry.

## Local development

Requires the `sourcing` FastAPI service running with `CONSOLE_PASSWORD` set.

```bash
npm install
SOURCING_API_URL=http://localhost:8000 npm run dev
```

Open http://localhost:5180 and sign in with the value of `CONSOLE_PASSWORD`.

## Railway deployment

Separate Railway service:

- root directory: `sourcing-console/`
- build: Dockerfile (static build served by Caddy, `/api/*` proxied)
- env vars:
  - `SOURCING_API_URL` — internal URL of the sourcing service, e.g.
    `http://stratum_sourcing.railway.internal:8080`

The console password is configured on the **sourcing** service via
`CONSOLE_PASSWORD`; the console just forwards the key its user enters.
