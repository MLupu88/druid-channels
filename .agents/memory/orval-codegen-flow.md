---
name: Orval codegen flow
description: How to safely add/change API endpoints with the openapi.yaml -> orval codegen pipeline, including a schema-naming collision gotcha.
---

Edit `lib/api-spec/openapi.yaml` first, then run the api-spec codegen, before touching
dependent frontend/backend code that consumes the generated client/zod types.

**Naming collision gotcha:** the TS-interface generator (in `lib/api-zod/src/generated/types/`)
names types after the OpenAPI **component schema name** (e.g. `AuthLoginResponse`), but the
**zod runtime schema** generator (in `lib/api-zod/src/generated/api.ts`) names schemas after the
**operationId** instead (e.g. operationId `login` -> zod schema `LoginResponse`), ignoring the
component schema name entirely. When both exist for the same operation, importing the schema
name from `@workspace/api-zod` resolves to the type-only interface, not the zod value, and
using it as `X.parse(...)` fails with "only refers to a type, but is being used as a value".

**How to apply:** when wiring a new/changed route to its zod schema for runtime validation,
check what name `lib/api-zod/src/generated/api.ts` actually exported for that operationId
(grep for `export const <Name>` there) rather than assuming it matches the OpenAPI component
schema name — alias the import if the names differ, e.g.
`import { LoginResponse as AuthLoginResponse } from "@workspace/api-zod"`.
