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
