---
name: Orval codegen flow (partner-radar / api-spec)
description: How this project's API types/hooks are generated; run before editing dependent code.
---

The API contract lives in `lib/api-spec/openapi.yaml`. Frontend/backend types and React Query
hooks are generated from it, not hand-written.

Flow:
1. Edit `lib/api-spec/openapi.yaml` (schemas, paths).
2. Run `pnpm --filter @workspace/api-spec run codegen`. This regenerates
   `lib/api-zod/src/generated` and `lib/api-client-react/src/generated`, and also runs
   `typecheck:libs`.
3. Only after codegen succeeds, write backend routes / frontend pages that use the new
   types/hooks — editing them first just means redoing the edits when generated types shift.

**Why:** editing generated files directly is silently overwritten by the next codegen run, and
consuming code written against a stale contract fails typecheck in confusing ways.

**Preview/dry-run endpoints:** for an endpoint that computes a value under a hypothetical
override (e.g. "preview this KPI mapping before saving"), pass the override as a parameter into
the same pure compute function used by the real read path, instead of writing the override to the
DB, computing, then reverting. The mutate/revert pattern is fragile (races, partial failures leave
bad state) and duplicates logic that can drift from the real path.

**Stale HMR after codegen:** after `codegen` regenerates client hook files, Vite's dev server can
serve stale HMR state for pages that import the changed hooks (e.g. a hook that no longer exists
throws `X is not defined` in the browser even though the file on disk is correct). A full workflow
restart (not just waiting for HMR) clears it — always restart + refresh the browser screenshot
after codegen touches consumed hooks, don't trust mid-edit HMR error logs as the final verdict.
