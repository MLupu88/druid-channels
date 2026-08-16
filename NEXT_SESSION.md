# Next Session

**Resume at Phase 11.5C — Druid Channel RAG / DRUID Context. Do not revisit
or redesign Phase 11.5B unless the repository reveals an actual defect.**

For full context (architecture, invariants, migrations, test status, dev
workflow), read `PROJECT_HANDOFF.md` first.

## Preflight (do this before anything else)

```bash
cd /Users/mihailupu/Projects/druid-channels/Druid-Radar-Lite
git branch --show-current   # expect: phase11/ux-modernization
git rev-parse HEAD          # expect: 19a2fc7...
git status --short          # expect: clean
```

If any of these don't match, **stop and report the discrepancy** rather
than proceeding as if the plan below still applies unchanged.

## 11.5C objective

Build "Druid Channel RAG / DRUID Context": a small, structured knowledge
base of facts about DRUID itself (product, positioning, ideal partner
profile — canonical source `druidai.com`), used to ground research about
**potential DRUID channel partners** (not DRUID's end clients). Eventually
this should inform Discovery and Channel Radar's qualification, but that
downstream wiring is not necessarily in scope for the first slice — confirm
scope with the user before touching Discovery/Channel Radar behavior.

## First action: read-only audit

Do not write any code in the first pass. Audit and report back before
proposing an implementation plan:

- What DRUID-related content already exists anywhere in the repo (prompts,
  hardcoded strings, seed data) that currently substitutes for real DRUID
  context.
- Current Discovery/Channel Radar qualification prompts (`discoveryProviders/
  ai.ts`, `channelRadarProviders/ai.ts`) — what DRUID-specific framing they
  already bake in, and how a structured context store would plug in without
  violating "preserve existing Discovery behavior/scoring except for
  credential resolution" (11.5B's constraint — assume it still holds unless
  the user says otherwise).
- Whether Tavily Extract/Map (already the configured search provider as of
  11.5B) is sufficient for DRUID-site ingestion, before considering any
  other crawler.
- Whether a vector store is actually justified, or whether a small
  Postgres table of admin-curated facts is enough — default assumption is
  the latter.

Then propose the smallest implementation plan and get explicit sign-off
before writing code, matching how 11.5A and 11.5B were run.

## Major constraints (see PROJECT_HANDOFF.md for full detail)

- Deliberately small architecture; prefer the existing Postgres/API stack.
- No vector DB unless the audit proves it necessary.
- Evaluate Tavily Extract/Map before adding another crawler (e.g. Firecrawl).
- Keep DRUID truth, partner evidence, and hypotheses in clearly separate
  categories — never let inference get presented as verified fact.
- Do not expose RAG/vector/chunk/prompt complexity to PAM/Head users.
- Do not implement Aniri or HubSpot during 11.5C.
- Do not commit/push/deploy/SSH/migrate a real database without explicit
  per-action approval — same working agreement as every prior phase.

## What comes after 11.5C

1. **Aniri** — must remain read-only against future HubSpot data; must
   never receive HubSpot write capabilities. (Existing footprint: a single
   read-only `GET /channel-chief/snapshot` endpoint, separately
   authenticated via `CHANNEL_CHIEF_API_TOKEN`.)
2. **Phase 12 — HubSpot** — OAuth implementation, deferred by 11.5B on
   purpose. Should reuse 11.5B's encrypted-credential infrastructure for
   token storage, but OAuth's refresh lifecycle needs its own design pass.

---

## Bootstrap prompt (copy/paste into a new ChatGPT/Claude conversation)

```
I'm resuming work on the DRUID Channels & Alliances repo at
/Users/mihailupu/Projects/druid-channels/Druid-Radar-Lite, branch
phase11/ux-modernization, expected HEAD 19a2fc7.

Read PROJECT_HANDOFF.md and NEXT_SESSION.md at the repo root first — they
contain the full durable implementation state, architecture, invariants,
and the agreed plan. Then:

1. Run the preflight checks in NEXT_SESSION.md (branch/HEAD/clean tree) and
   report back before doing anything else.
2. Resume at Phase 11.5C — Druid Channel RAG / DRUID Context. Do not
   revisit or redesign Phase 11.5B unless you find an actual defect while
   reading the code.
3. Start with a read-only audit only (no code changes) per the "First
   action" section of NEXT_SESSION.md, then propose the smallest
   implementation plan and wait for my sign-off before writing any code.
4. Do not commit, push, deploy, SSH, or run any DB-backed command without
   asking me first and getting an explicit target connection string.
```
