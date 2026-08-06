# DRUID Partner Radar Lite

A full-stack partner lead-generation web app for DRUID AI's Head of Channels and five regional Partner Account Managers (PAMs). Surfaces AI-discovered partner prospects, enables PAM review/accept/reject workflows, and feeds accepted partners into HubSpot (mocked in Phase 0).

## Run & Operate

- `pnpm --filter @workspace/partner-radar run dev` — run the frontend (port auto-assigned)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — express session secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (`artifacts/api-server`)
- Frontend: React + Vite + Tailwind + shadcn/ui (`artifacts/partner-radar`)
- DB: PostgreSQL + Drizzle ORM (`lib/db`)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval 8 (from OpenAPI spec at `lib/api-spec/openapi.yaml`)
- API client hooks: TanStack Query via `@workspace/api-client-react`
- Build: esbuild (API server bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts (run codegen after editing)
- `lib/db/src/schema/` — Drizzle schema files (one per table)
- `lib/api-client-react/src/generated/api.ts` — auto-generated; do not hand-edit
- `lib/api-zod/src/generated/api.ts` — auto-generated; do not hand-edit
- `artifacts/api-server/src/routes/` — Express route handlers (one file per domain)
- `artifacts/partner-radar/src/pages/` — React page components (overview, prospects, campaigns, scan-setup)

## Architecture decisions

- **No real auth in Phase 0**: User switcher dropdown in header lets testers impersonate any of the 6 seeded users (Irina + 5 PAMs). Session state lives in React context only.
- **All Fluent 2 styling is approximated** with shadcn/Tailwind + custom CSS variables — no `@fluentui/react-components` package installed. This avoids heavyweight dependency while matching the visual spec.
- **Orval 8 integer bug**: All `type: integer` fields in the OpenAPI spec were changed to `type: number`. Orval 8 generates `z.int()` for integers which doesn't exist in Zod v3 (the pinned version).
- **Null params in generated hooks**: `getListProspectsUrl` converts `null` to the string `"null"`. Always pass `undefined` or omit keys rather than passing `null` to generated Orval hooks.
- **Territory filter**: Backend accepts both territory name and territory ID for the `territory` query param.
- **HubSpot integration is mocked**: `POST /api/prospects/:id/hubspot` returns a fake HubSpot ID prefixed `MOCK-`.

## Product

**Overview** — KPI dashboard showing partner development metrics (partner count, pipeline, revenue) vs. quarterly targets. Territory and period filters for Irina's global view.

**Prospect Review** — Paginated data grid of 30 seeded prospects across 5 territories. Filter by territory, priority (A/B), partner type, and status. Click a row to open a right-side detail drawer with 4 tabs: Summary (AI rationale), Evidence (signals), Outreach (suggested message), and Activity log. Accept / Reject / Push to HubSpot actions.

**Campaign Lists** — List of outreach campaigns per territory, with prospect count and performance stats. Create new campaigns via dialog.

**Scan Setup** — Per-territory configuration panel for the AI scanner (queries, partner types, industries, technologies, exclusions). Trigger a mock scan that simulates discovering new prospects.

## Seeded data (Phase 0)

- 6 users: Irina Dochitu (head_of_channels) + 5 PAMs (James Bradley, Denny Morais, Elena Panait, Vlad Greavu, Chase Baylor)
- 5 territories: UK & Ireland, DACH, CEE, United States, Portugal/Canada/South America
- 30 companies and 30 prospects (6 per territory: 2 priority-A new, 1 priority-A accepted/pushed, 1 priority-B new, 1 deferred, 1 rejected)
- 17 signals across key companies
- 5 scan configs (one per territory)
- 2 sample campaigns

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after editing `openapi.yaml` before changing backend or frontend code.
- After DB schema changes, run `pnpm --filter @workspace/db run push` (dev) — production requires a migration strategy.
- The Orval null-to-string-"null" behavior means filter params must use `undefined` or omit-key spreading, never `null`.
- `type: integer` in openapi.yaml will break codegen — use `type: number` instead.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- OpenAPI spec: `lib/api-spec/openapi.yaml`
- DB schema: `lib/db/src/schema/index.ts`
