# DRUID Channels & Alliances — Project Handoff

This document is the durable implementation-state reference for continuing
work on this repository in a fresh session. It is written to be self-
contained: a new session should be able to read this file and
`NEXT_SESSION.md` and safely resume without re-deriving prior context from
scratch.

## Repository

- **Path:** `/Users/mihailupu/Projects/druid-channels/Druid-Radar-Lite`
- **Branch:** `phase11/ux-modernization`
- **HEAD (verified at time of writing):** `19a2fc7`
- **Main/production branch:** `migration/hetzner` (this is what `origin/HEAD`
  points at; production runs from a Docker Compose stack on a Hetzner VM,
  not Replit — see `docker-compose.yml` and root `.env`, which is the
  production Compose env file, not a local dev file)
- **Remotes:** `origin` (GitHub, `MLupu88/druid-channels`), `gitsafe-backup`
  (mirror)
- **Working tree:** clean at time of writing (verified via `git status
  --short` before this document was created)

Stack: pnpm monorepo. `artifacts/api-server` (Express + Drizzle/Postgres),
`artifacts/partner-radar` (React + Vite), `lib/db` (Drizzle schema/
migrations), `lib/api-spec` (OpenAPI source of truth), `lib/api-zod` /
`lib/api-client-react` (orval-generated, do not hand-edit).

## Current phase status

| Phase | Commit | Description | Status |
|---|---|---|---|
| 11.1 | `888ec1f` | Prospect deletion integrity | COMPLETE |
| 11.2 | `c20d018` | Navigation & IA | COMPLETE |
| 11.3 | `5990af6` | Visual modernization | COMPLETE |
| 11.4 | `1c3e550` | Recruitment visualization | COMPLETE |
| 11.5A | `350e469` | Research Cleanup & Discovery Exclusions | COMPLETE |
| 11.5B | `19a2fc7` | Integrations & Credentials | COMPLETE |
| 11.5C | — | Druid Channel RAG / DRUID Context | **NEXT** |
| Aniri | — | (external agent, Channel Chief API consumer) | AFTER 11.5C |
| Phase 12 | — | HubSpot | AFTER Aniri |

All six checkpoint commits above were verified against `git log --oneline`
on this branch at the time this document was written; each commit hash
matches exactly. No discrepancy was found.

---

## Architecture delivered in 11.5A — Discovery Exclusions

**Concept:** a PAM's "don't suggest this company again," scoped per
territory. Deliberately narrow — one table, one concept — not a generic
archive/soft-delete mechanism.

- **Schema:** `discovery_exclusions` (`lib/db/src/schema/discovery_exclusions.ts`,
  migration `0020_glorious_raza.sql`). Key columns: `territory_id`, `domain`
  (registrable domain, canonicalized the same way as `companies.domain`),
  `company_id` (nullable, display-only — never the sole match key),
  `reason` (enum: `not_relevant | wrong_match | bad_source | other` —
  **`duplicate` is deliberately excluded**, see below), `active`,
  `restored_at`, `restored_by_user_id`.
- **Service:** `artifacts/api-server/src/services/discoveryExclusions.ts`.
  - `loadActiveExclusionDomains(territoryId)` — loaded once per scan run
    (not per-candidate), returned as a `Set` for O(1) lookup.
  - `isDomainExcluded(domain, exclusionDomains)` — exact match or subdomain
    of an excluded domain; mirrors `discoveryEngine.ts`'s own exclusion
    matching shape.
  - `excludeCompanyForTerritory(input, dbHandle?)` — idempotent (re-excluding
    an already-active domain updates reason/note rather than creating a
    duplicate row). Accepts either the module `db` or a transaction handle
    (the `Executor`/`Tx` pattern reused across this codebase — see
    `partnerRelationshipService.ts`, `territoryOwnership.ts`, and now this
    file), so it can be composed into the same transaction as the prospect
    delete that triggers it.
  - `restoreDiscoveryExclusion(id, restoredByUserId)` — sets `active=false`;
    restored rows are kept (not deleted) so who restored it and why remains
    visible in Admin.
- **Routes:** `GET /discovery-exclusions` (list active, admin-only),
  `POST /discovery-exclusions/:id/restore` (admin-only).
- **Prospect-delete integration** (`routes/prospects.ts`, `DELETE
  /prospects/:id`): the delete body now optionally carries `{ reason,
  exclude_company }`. The prospect-row delete and the exclusion creation
  run in **one DB transaction** — if `excludeCompanyForTerritory` throws for
  any reason, the prospect delete rolls back too, so the client is never
  left in a state where the prospect is gone but no exclusion was created
  (or vice versa).
  - **`reason: "duplicate"` never creates an exclusion**, even if
    `exclude_company: true` was requested — enforced both in the UI
    (`remove-prospect-dialog.tsx` disables the checkbox when `duplicate` is
    selected) and, authoritatively, inside `excludeCompanyForTerritory`
    itself (never trust the frontend as the sole enforcement point). A
    duplicate *result* does not mean the underlying company is illegitimate
    — only the redundant prospect row is removed.
  - **Prospect deletion remains protected when recruitment history
    exists**: `assertProspectHasNoRecruitment(id)` (from Phase 11.1's
    `partnerRecruitmentService.ts`) is checked before the delete
    transaction runs, and returns `409` via `ProspectHasRecruitmentError`
    if the prospect has recruitment history. This guardrail predates 11.5A
    and was **not modified** by it — 11.5A's exclusion logic only runs
    after this check has already passed.
- **UI:** "Remove" flow (`my-prospects.tsx`, `prospects.tsx`) opens
  `remove-prospect-dialog.tsx`, which collects a reason and an optional
  "don't suggest this company again" checkbox (disabled for `duplicate`).
  Settings has an admin-only exclusions list with per-row **Restore**.

## Architecture delivered in 11.5B — Integrations & Credentials

**Scope of this slice:** DB-backed encrypted credential storage for
**Tavily/Web Search and DeepSeek/AI only**. HubSpot OAuth was intentionally
deferred to Phase 12. Web Reader does not get a separate credential-
management UX in this slice (see rationale below).

- **Encryption** (`artifacts/api-server/src/services/encryption.ts`, new
  file): AES-256-GCM using Node's built-in `crypto` module only — no new
  dependency. `INTEGRATION_ENCRYPTION_KEY` must be exactly 64 hex
  characters (32 bytes); missing or malformed **fails closed** (throws
  `EncryptionKeyMissingError` / `EncryptionKeyMalformedError`), never
  silently degrades or falls back to plaintext. Ciphertext is packed as
  `ivBase64:authTagBase64:ciphertextBase64`. A tampered ciphertext or wrong
  key fails closed via `SecretDecryptionError` (GCM auth tag). No function
  in this module ever logs the plaintext, ciphertext, IV, auth tag, or key.
- **Schema** (`lib/db/src/schema/connections.ts`, migration
  `0021_new_gambit.sql`, purely additive): new columns on `connections` —
  `enabled` (boolean, default `true`), `secret_ciphertext`, `secret_last4`,
  `encryption_key_version`, `updated_by_user_id` (FK → `users.id`).
- **Credential resolution** (`artifacts/api-server/src/services/connections.ts`):
  - `resolveProviderSecret(providerType)` is **the single resolution path**:
    DB secret (only when `enabled`) → `credential_env_var` (only when
    `enabled`) → `null`. Throws (does not silently substitute) if a DB
    secret exists but decryption fails — this is the admin-facing path, so
    a broken key must surface loudly.
  - **`enabled=false` disables both credential sources entirely** — not
    just the DB secret. A disabled connection with a perfectly valid env
    var still resolves to `null`. This was an explicit requirement: it
    means "this integration is off," not "prefer env."
  - `hasResolvableCredential(providerType)` is the safe, non-throwing
    boolean wrapper used by background "is this provider usable" gates
    (Discovery's `isConfigured()` checks) — a broken encryption key must
    never crash a scan mid-run. The admin Test Connection action calls
    `resolveProviderSecret` directly (unwrapped) instead, so a
    misconfigured key is surfaced there.
  - `setConnectionSecret` / `clearConnectionSecret` / `setConnectionEnabled`
    — admin actions. Clearing a DB secret **cleanly reverts to the env-var
    fallback** (if enabled) — this is not a separate code path, it's just
    `resolveProviderSecret`'s own if/else chain finding nothing in the DB
    anymore.
  - `toConnectionResponse()` is the single serialization point and **never
    includes `secret_ciphertext`, `encryption_key_version`, or any
    decrypted plaintext** — only `has_db_secret` (boolean) and
    `secret_last4` (masked display). Settings never decrypts a secret
    merely to render the page.
- **Secrets are never exposed through the API or UI** — enforced by
  `toConnectionResponse`'s explicit allow-list shape (not an omit-list),
  and verified by a dedicated test (`connectionSecretHandling.test.ts`)
  that asserts the serialized response never contains the plaintext or its
  base64 encoding, even when the underlying row has a secret stored.
- **Routes** (`artifacts/api-server/src/routes/connections.ts`):
  - `GET /connections`, `PATCH /connections/:id` (now accepts `enabled`),
  - `POST /connections/:id/secret` — new endpoint; body `{ secret: string |
    null }`; `null` clears and reverts to env fallback.
  - `POST /connections/:id/test` — **Test Connection performs a real,
    bounded provider verification**, not presence-only. For `web_search`,
    a minimal Tavily search (`max_results: 1`). For `ai`, a minimal
    DeepSeek completion (`max_tokens: 1`). Both resolve the credential via
    the exact same `resolveProviderSecret()` path production requests use
    — this is the point of the test (it proves the credential that would
    actually be used works, not just that *some* credential is present).
    HubSpot/Web Reader keep the pre-existing presence-only "credential set,
    but no live check implemented yet" behavior (`unverified` status) —
    unchanged, out of scope for this slice.
  - All admin-only (`requireAdmin`), unchanged from before this phase.
- **DeepSeek/Tavily consumers use the centralized credential-resolution
  path.** This was a larger-than-originally-scoped but mechanically
  necessary change: because `enabled=false` must disable an integration
  *entirely*, every direct consumer of `AI_API_KEY`/`SEARCH_API_KEY` had to
  be rewired, not just Discovery's. All five were converted from a
  hardcoded `process.env.AI_API_KEY`/`process.env.SEARCH_API_KEY` read to
  an explicit `apiKey` parameter resolved via `resolveProviderSecret()` at
  the call site:
  - `services/discoveryProviders/search.ts` (Tavily) — also gained
    `testConnection()`.
  - `services/discoveryProviders/ai.ts` (DeepSeek, Discovery qualification
    + identity resolution) — also gained `testConnection()`.
  - `services/copilotProvider.ts` (PAM Workspace Copilot).
  - `services/aiBriefProvider.ts` (Overview AI Channel Brief).
  - `services/portfolioImportProviders/normalization.ts` (Portfolio import
    row normalization).
  - `services/channelRadarProviders/ai.ts` (Channel Radar qualification +
    same-event classification).
  - This incidentally fixed a **pre-existing bug**: `isConfigured()` in
    these files checked credential *presence* via the DB row's
    `credential_env_var` field dynamically, but the actual API key *value*
    used in the real request was a hardcoded env read — so changing
    `credential_env_var` in the DB never actually changed which env var's
    value got used. `resolveProviderSecret()` is now the one place that
    decides both "is a credential configured" and "what is its value."
- **Web Reader does not get a separate credential-management UX** in this
  slice by explicit decision — it is currently unwired (nothing in
  `src/` consumes `EXTRACTION_API_KEY`; Tavily's search result content
  flows directly through `discoveryProviders/extraction.ts` without a
  second external call). **Phase 11.5C is expected to reuse the Tavily/
  web_search credential for Extract/Map rather than introduce a second
  provider/key unnecessarily** — see the 11.5C section below. The
  `web_reader` connection row and its `EXTRACTION_API_KEY` env var still
  exist in the schema/seed defaults; they were simply not extended with
  secret-management UI.
- **HubSpot OAuth was intentionally deferred to Phase 12** — the
  `hubspot` connection row keeps its pre-existing env-var-only,
  presence-only behavior. `services/hubspot.ts` remains stubbed (throws
  rather than fabricates data), unchanged.
- **Frontend** (`artifacts/partner-radar/src/pages/settings.tsx`,
  `ConnectionCard`): for `web_search`/`ai` only — masked display
  (`•••• {secret_last4}`), a "Replace" dialog (single input; also offers
  "Clear stored credential (revert to env var)" when a DB secret exists),
  and an `enabled` Switch. `hubspot`/`web_reader` cards are visually
  unchanged. `connection-display.ts` gained a `disabled` tone (takes
  priority over every other tone) so a disabled integration reads clearly
  in the status badge rather than looking like a misconfigured one.
- **New env var:** `INTEGRATION_ENCRYPTION_KEY` — documented in
  `.env.example` (root, production Compose env). Only required once an
  admin actually stores a secret via Settings; env-var-only credentials
  keep working without it.

---

## Invariants / guardrails that must not regress

These are load-bearing behaviors — a future session should treat any
change that would break one of these as requiring explicit user sign-off,
not a routine refactor:

1. **No fabricated data, ever.** A KPI/metric that can't be computed live
   from a real, directly-related source must not be approximated with
   cross-entity math or an arbitrary multiplier — store a real snapshot
   and show provenance (`data_source`, `last_updated`) instead. (Pre-11
   convention; see `.agents/memory/kpi-honesty.md`.) This same principle
   underlies 11.5C's "keep DRUID truth, partner evidence, and hypotheses
   separate" requirement below — never let an LLM's inference get
   presented as verified fact.
2. **Reject-not-widen scope enforcement.** A caller requesting a scope
   narrower/other than their own (e.g. a PAM passing a foreign territory)
   must get a 403/400, never a silent fallback to a broader default. Acting
   user identity/role is always re-derived fresh from the DB on every
   request from a verified session token, never trusted from the request
   body or a stale token payload. (See `.agents/memory/authorization-scoping.md`.)
3. **Secrets never leave the server in usable form.** `toConnectionResponse`
   is the only place a `Connection` gets serialized, and it is an
   allow-list, not an omit-list — extending it must not accidentally widen
   what's exposed. Settings/UI must never need to decrypt a secret merely
   to render a masked view.
4. **`enabled=false` means "off," not "prefer env."** Any future connection
   type or credential path must honor this — never add a code path that
   reads a credential while bypassing the `enabled` check.
5. **Prospect deletion stays blocked when recruitment history exists**
   (`assertProspectHasNoRecruitment`) — this predates 11.5A/B and must
   continue to run before any delete-adjacent side effect (like exclusion
   creation).
6. **`duplicate` never creates a Discovery exclusion.** Enforced both in
   UI and authoritatively in `excludeCompanyForTerritory` itself.
7. **Delete + exclusion stays one transaction.** Any future extension of
   the prospect-delete flow that adds another side effect should preserve
   this: either everything commits, or everything rolls back.
8. **Migrations are additive-only in this workflow.** Every migration
   landed in Phase 11 (`0020`, `0021`) only adds columns/tables/constraints
   — never drops or renames a column in place. Follow the same pattern
   going forward unless a user explicitly approves a breaking migration.
9. **Aniri (Channel Chief) stays read-only.** See the dedicated guardrail
   section below.

## Migrations and test status

| Migration | Phase | Change |
|---|---|---|
| `0020_glorious_raza.sql` | 11.5A | Adds `discovery_exclusions` table |
| `0021_new_gambit.sql` | 11.5B | Adds `enabled`, `secret_ciphertext`, `secret_last4`, `encryption_key_version`, `updated_by_user_id` to `connections` |

Both migrations are applied on `phase11/ux-modernization`'s development/test
databases used during their respective phases. **Production (the
`migration/hetzner` Compose stack) has not been touched by this session at
any point** — no migration was applied there, no deploy occurred.

11.5B test coverage, all verified passing in this session (most recent run):

- `encryption.test.ts` — 11 tests (pure, no DB): round-trip, last4
  correctness, ciphertext never contains plaintext, missing/malformed key,
  wrong key, tampered ciphertext, unsupported key version, random IV,
  empty-secret rejection.
- `connectionSecretHandling.test.ts` — 8 tests (pure, no DB): secret-never-
  returned via `toConnectionResponse`, masking correctness, `enabled`
  reporting, and mocked-HTTP `testConnection()` behavior for both Tavily
  and DeepSeek (success, non-2xx, aborted/timeout).
- `connectionsCredentialResolution.test.ts` — 10 tests (**DB-backed**,
  requires a real Postgres + `INTEGRATION_ENCRYPTION_KEY`): env fallback,
  DB-over-env precedence, clear-secret-reverts-to-env, disabled integration
  (both credential paths), re-enable, `hasResolvableCredential` fail-closed
  behavior, `resolveProviderSecret` throwing loudly on a missing key. Run
  and passed against a disposable local test DB
  (`postgresql://postgres:postgres@127.0.0.1:32769/druid_phase11_test`) in
  this session, after migration `0021` was applied there; teardown verified
  clean (no leftover secrets/users, `web_search` row restored to its
  original seeded state).
- Updated existing suites for the new explicit-`apiKey` function
  signatures (no behavior change, only how the key is supplied):
  `discoveryProviders.test.ts` (10), `discoveryIdentity.test.ts` (10),
  `pamCopilot.test.ts` (20), `channelRadarQualification.test.ts` (11),
  `portfolioNormalization.test.ts` (5).
- Frontend: `connectionDisplay.test.ts` (16, pure) — includes new coverage
  for the `disabled` tone.

Full workspace `pnpm -w run typecheck` passes cleanly. `api-server` build
(`node build.mjs`) and `partner-radar` build (`vite build`, requires `PORT`/
`BASE_PATH` env vars to load its config) both succeed.

---

## Development workflow and Git conventions

- **Package manager:** pnpm only — the root `preinstall` script rejects
  npm/yarn.
- **Codegen flow:** `lib/api-spec/openapi.yaml` is the source of truth for
  the API contract. Edit it first, then run `pnpm run codegen` from
  `lib/api-spec/` (wraps `orval` + `pnpm -w run typecheck:libs`) — this is
  a pure local operation, safe to run without asking, distinct from DB
  migrations. **Naming collision gotcha** (see
  `.agents/memory/orval-codegen-flow.md`): orval's zod-schema generator
  names runtime schemas after the **operationId** (e.g. `updateConnection`
  → `UpdateConnectionResponse`), while the TS-interface generator names
  types after the **OpenAPI component schema name** — when both exist for
  one operation and the names differ, you must import the zod-schema name
  from `@workspace/api-zod`, not the component schema name, or `.parse()`
  will fail with "only refers to a type." Never name a new component
  schema exactly `<OperationId>Body`/`<OperationId>Response` if that
  string would collide with orval's auto-derived name for a *different*
  schema — check `lib/api-zod/src/generated/api.ts` after every codegen
  run when adding a new endpoint.
- **Migrations:** `drizzle-kit generate` (from `lib/db/`) is pure/local/
  offline — safe to run freely with a placeholder `DATABASE_URL`.
  `drizzle-kit migrate`/`push` require a live DB connection and must
  **never** be run without explicit user approval of exactly which
  database is being targeted. The convention established in this session:
  when a DB-backed action needs approval, ask the user for the target
  connection string rather than guessing — the production Docker stack's
  Postgres and this machine's `localhost:5432` are both off-limits for
  ad hoc test use.
- **Transaction composability pattern:** `type Tx =
  Parameters<Parameters<Db["transaction"]>[0]>[0]; type Executor = Db |
  Tx;` — used by `partnerRelationshipService.ts`, `territoryOwnership.ts`,
  `discoveryExclusions.ts`. Reuse this pattern for any new service function
  that might need to participate in a caller's transaction.
- **Test harness conventions:**
  - Pure tests (no DB): plain `node:test`, mock `fetch` via
    `globalThis.fetch = ...`, restore in `after`/`afterEach`.
  - DB-backed tests: `createServer(app)` bound to an ephemeral port (when
    HTTP-level), `issueSessionToken` for auth, direct `@workspace/db`
    fixture inserts, explicit child-first teardown in `after`. For a
    singleton-row table like `connections` (only 4 seeded rows, unique on
    `provider_type`), the established pattern is to **save and restore the
    row's original state** in `before`/`after` rather than insert/delete —
    see `connectionsCredentialResolution.test.ts`.
  - Placeholder `DATABASE_URL` convention for DB-free commands:
    `127.0.0.1:59999`, never `localhost:5432` (something live listens
    there on this machine) and never the production Compose service name.
- **Commit message style:** short, imperative, type-prefixed (`feat:`,
  `fix:`, `chore:`, `merge:`) — e.g. `feat: manage integration credentials
  securely`. No large bodies in `git log --oneline` history; see recent
  commits on this branch for exact tone.
- **Never commit/push/deploy without explicit instruction** for that
  specific action — this has been the working agreement for the entire
  Phase 11 sequence and should continue.

---

## Agreed direction for 11.5C — Druid Channel RAG / DRUID Context

**This section is a plan, not an implementation record.** It captures what
has been agreed with the user so far. It intentionally does not invent
implementation decisions (table shapes, chunking strategy, specific API
endpoints, etc.) that have not yet been audited — a fresh session should
run the read-only audit described in `NEXT_SESSION.md` before writing any
code.

- **Capability name:** Druid Channel RAG / DRUID Context.
- **Canonical DRUID site:** `druidai.com`.
- **Purpose:** ground research about **potential DRUID channel partners**
  — i.e. companies DRUID might recruit as resellers/SIs/consultancies/etc.
  — not DRUID's own end clients. The context this capability builds is
  about *what DRUID is* (product, positioning, ideal partner profile), so
  that partner-evidence qualification (Discovery, Channel Radar) can be
  grounded in accurate, current DRUID facts instead of an LLM's possibly
  stale/hallucinated general knowledge.
- **Architecture principle: deliberately small.** Prefer the existing
  PostgreSQL/API stack already used throughout this codebase over
  introducing new infrastructure.
- **No vector DB unless the audit proves it necessary.** Default
  assumption is that a small, structured, admin-curated set of DRUID facts
  (stored in Postgres, like everything else in this app) is sufficient —
  do not reach for pgvector/Pinecone/etc. as a starting point.
- **Evaluate Tavily Extract/Map before adding another crawler.** Tavily is
  already the configured web-search provider (11.5B); check whether its
  Extract/Map endpoints can serve DRUID-site ingestion before introducing
  a second crawling vendor like Firecrawl. (11.5B's `.env.example` already
  notes that `EXTRACTION_PROVIDER`/`EXTRACTION_API_KEY` are currently
  unused for exactly this reason — Tavily's search result content flows
  through directly today.)
- **Eventual downstream use:** approved, structured DRUID context should
  eventually ground Discovery and Channel Radar's qualification/scoring —
  but 11.5B's explicit instruction was "preserve existing Discovery
  behavior/scoring except for credential resolution," and that constraint
  should be assumed to continue until 11.5C explicitly changes it with the
  user's sign-off.
- **Keep DRUID truth, partner evidence, and hypotheses in clearly separate
  categories.** Do not let an LLM's inference about a partner get
  conflated with a verified DRUID fact, or vice versa — this directly
  extends the existing "no fabricated data" principle (see guardrails
  above) into the RAG domain.
- **Do not expose RAG/vector/chunk/prompt complexity to PAM/Head users.**
  Whatever internal representation is chosen, the UI surface (if any) must
  stay as simple as the rest of this app's admin-curated data patterns —
  no "prompt playground," no chunk-browser, no embedding-space UI exposed
  to end users.
- **Do not implement Aniri or HubSpot during 11.5C.** Those are separate,
  later phases (see table above and the guardrails below).

## Future Aniri and HubSpot architectural guardrails

- **Aniri must remain read-only against future HubSpot data — it must
  never receive HubSpot write capabilities.** This is a hard architectural
  constraint for whenever Phase 12 (HubSpot) and the Aniri integration
  intersect. Aniri's existing footprint in this codebase today
  (`routes/channel_chief.ts`, `middleware/channelChiefAuth.ts`,
  `CHANNEL_CHIEF_API_TOKEN`) is already a single read-only endpoint
  (`GET /channel-chief/snapshot`) authenticated by a dedicated
  machine-to-machine service token, entirely separate from human session
  auth — any future Aniri surface (including one that touches HubSpot data
  once Phase 12 lands) must preserve this read-only, separately-
  authenticated shape. Never add a write endpoint to the Channel Chief/
  Aniri surface without explicit user sign-off, and never let Aniri's
  token grant HubSpot write access even indirectly (e.g. via a combined
  endpoint that both reads Channel Chief data and triggers a HubSpot
  mutation).
- **HubSpot OAuth (Phase 12) is a separate, later phase.** 11.5B
  deliberately left the `hubspot` connection row and `services/hubspot.ts`
  untouched (stubbed, throws rather than fabricates). When Phase 12 begins,
  it should reuse 11.5B's encrypted-credential infrastructure
  (`resolveProviderSecret`, `setConnectionSecret`, AES-256-GCM via
  `services/encryption.ts`) for HubSpot's OAuth tokens rather than
  inventing a parallel storage mechanism — but OAuth's token-refresh
  lifecycle is different from a static API key, so this will need its own
  design pass, not a copy-paste of the Tavily/DeepSeek pattern.
