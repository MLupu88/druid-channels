# Deployment & portability notes

This project is a pnpm monorepo with two services for the DRUID Partner Radar
Lite product:

- `artifacts/partner-radar` — React + Vite frontend, served at `/`
- `artifacts/api-server` — Express API, served at `/api`

Both currently run on Replit, proxied behind path-based routing. This doc
covers what you need to run and deploy them, and what changes if you move
the project to a plain Ubuntu/Hetzner (or any other) VM.

## Requirements

- Node.js 20+ (developed against Node 24)
- pnpm (workspace-managed; see root `package.json` for the pinned version)
- PostgreSQL 14+ (any standard Postgres; Replit's built-in Postgres is used
  in this environment)

## Environment variables

See `artifacts/api-server/.env.example` for the full list. Required:

- `DATABASE_URL` — Postgres connection string
- `PORT` — port the API server binds to

Optional (integrations, all read from `Admin > Connections & data`):

- `HUBSPOT_ACCESS_TOKEN`
- `SEARCH_PROVIDER`, `SEARCH_API_KEY`
- `EXTRACTION_PROVIDER`, `EXTRACTION_API_KEY`
- `AI_PROVIDER`, `AI_API_KEY`

None of these are required for the app to run — every KPI mapped to an
unconfigured source is labeled `NOT_CONNECTED` in the UI rather than
silently falling back to fake data.

## Build & run

```bash
# install dependencies (from repo root)
pnpm install

# apply the database schema
pnpm --filter @workspace/db run db:push   # or your migration tool of choice

# build
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/partner-radar run build

# start
node artifacts/api-server/dist/index.mjs      # API on $PORT
# serve artifacts/partner-radar/dist/public as static files behind your web server
```

On startup the API server seeds four default `connections` rows (HubSpot,
Web Search, Web Reader, AI) and default `metric_mappings` for every KPI if
they don't already exist — this is idempotent and safe to run on every boot.

## Persistent storage

All application state lives in Postgres (`DATABASE_URL`). There is no use of
local disk for persistent data — the app is safe to run in an ephemeral
container as long as the database is durable.

## Integrations used

- **HubSpot** — optional CRM source for partner/deal metrics. The service
  boundary (`artifacts/api-server/src/services/hubspot.ts`) is stubbed and
  intentionally throws rather than fabricate data; wire it up to HubSpot's
  API when a real integration is built.
- **Web Search / Web Reader / AI** — used by the partner-prospect discovery
  scans (`scan-configs`/`scans`). Each is optional and independently
  configurable from Admin > Connections & data.

## Moving from Replit to Ubuntu/Hetzner

1. Provision a Postgres instance and set `DATABASE_URL`.
2. Set `PORT` (and a reverse proxy — nginx/Caddy) to route:
   - `/` → the built `partner-radar` static files (or a Node static server)
   - `/api/*` → the `api-server` process
   This mirrors the path-based routing Replit does for you automatically;
   outside Replit you must configure it yourself (e.g. an nginx `location`
   block for `/api/` proxying to `localhost:8080`, and a `location /` block
   serving the frontend's `dist/public`).
3. Set any of the optional integration env vars you want enabled.
4. Run the build/start commands above under a process manager (systemd,
   pm2, or a container orchestrator).
5. There is no Replit-specific code in the application logic — the only
   Replit-specific pieces are the `.replit-artifact/artifact.toml` files
   (routing/workflow config for the Replit environment) and the dev-time
   `PORT`/`BASE_PATH` env values, none of which are read outside Replit's
   own tooling.
