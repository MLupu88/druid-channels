# Memory Index

- [Orval codegen flow](orval-codegen-flow.md) — edit openapi.yaml, run api-spec codegen, before touching dependent frontend/backend code.
- [Drizzle push on renames](drizzle-rename-ambiguous.md) — drizzle-kit push fails non-interactively on rename-ambiguous diffs; use raw SQL then re-verify with push.
- [KPI honesty principle](kpi-honesty.md) — never derive metrics live across unrelated entities; store snapshots and expose data_source/last_updated.
- [Authorization scoping rules](authorization-scoping.md) — reject invalid/foreign scope requests (403/400), never widen to a default like Global.
