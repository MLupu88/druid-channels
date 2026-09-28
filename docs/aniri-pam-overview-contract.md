# Aniri / OpenClaw: `get_pam_overview` plugin contract

Status: **documentation only.** OpenClaw lives outside this repository, on the
server; nothing in this file is executable and nothing outside this repo was
touched. This describes exactly what the OpenClaw plugin should look like
once someone deploys the corresponding change there, and the behavioral
guidance to add to Aniri's own prompt/instructions alongside it.

The backend half of this contract already exists in this repo:
`GET /channel-chief/pam-overview` (see `artifacts/api-server/src/routes/channel_chief.ts`,
`artifacts/api-server/src/services/pamOverviewService.ts`, and
`artifacts/api-server/src/services/pamResolution.ts`). This document only
covers the OpenClaw-side plugin wiring and Aniri's conversational behavior,
neither of which lives in this repo.

## Why this exists

Aniri was asked, in Romanian:

> "ce poti sa-mi zici de denny?"
> (clarified:) "e un pam da. denny morais. vreau sa stiu cum performeaza"

She could not answer, because the only tool she had (`get_channel_snapshot`)
is Global/company-wide scope only -- it has no notion of one specific PAM.
She then repeatedly explained her own tool limitation, asked the user to
supply Denny's territory/partners (data DRUID already owns), and leaked
implementation language ("tool-ul imi da date agregate"). `get_pam_overview`
exists so this class of question has a real, narrow, read-only data path,
and the guidance below exists so Aniri never falls back into that failure
mode again even when data genuinely is missing.

## Tool: `get_pam_overview`

### Arguments

| Argument   | Type   | Required | Notes |
|------------|--------|----------|-------|
| `pam_name` | string | yes      | Free text as the user said it -- "Denny", "denny", "Denny Morais". Never pre-resolve or guess client-side; the DRUID endpoint does case-insensitive resolution (exact full name → exact email → first name → substring, most-specific match wins) and reports ambiguity/unknown explicitly. |
| `period`   | string | no       | Composite period key matching the existing Channel Chief convention, e.g. `"2026-q3"` or `"2026-ytd"`. Omit for the current quarter. Same format `get_channel_snapshot` already uses -- no new period vocabulary. |

### Behavior

- Calls `GET {DRUID_API_BASE}/channel-chief/pam-overview?pam_name=<pam_name>&period=<period>` using the exact same `Authorization: Bearer ${CHANNEL_CHIEF_API_TOKEN}` pattern `get_channel_snapshot` already uses. No new auth mechanism, no new secret.
- Returns the DRUID response body verbatim (or a thin pass-through) as the tool result -- a bounded, structured JSON object (`identity`, `portfolio`, `performance`, `druid_recorded_opportunities`, `recruitment`, `activity`, `availability`). Aniri interprets it; the plugin does not reshape, summarize, or filter it further.
- Maps DRUID's HTTP status to a tool-level outcome the model can act on:
  - `200` → return the overview object.
  - `404` → return a small `{ "resolved": false, "reason": "not_found" }` result (never invent a PAM).
  - `409` → return `{ "resolved": false, "reason": "ambiguous", "candidates": [...] }` (the bounded candidate list DRUID returned) so Aniri can ask the user to pick one -- this is the one case where asking a clarifying question is correct, because DRUID itself could not disambiguate.
  - `400` → malformed period; the plugin should not construct malformed periods itself, so this indicates a plugin bug, not a user-facing case.
  - `401`/`503` → surfaced as a generic tool failure (auth misconfiguration / FX provider unavailable respectively); never shown to the user as a business fact.
- No direct database access of any kind -- this tool, like `get_channel_snapshot`, only ever calls the one DRUID HTTP endpoint.
- No HubSpot access from Aniri, directly or indirectly. `get_pam_overview` never touches HubSpot; DRUID's own read-only HubSpot reconciliation (opportunity import) is entirely internal to this repo and irrelevant to this tool's contract.
- No writes of any kind. This is a pure read, exactly like `get_channel_snapshot`.
- `get_channel_snapshot` and its existing behavior are completely unaffected -- this is a new, additive tool, not a replacement.

### Field semantics (Canonical Portfolio Truth)

- `identity.territories` lists **every** territory the PAM owns
  (`territories.owner_user_id`), never just the first. It is context, not
  portfolio scope. `performance` rows carry `territory_id`/`territory_name`
  because targets are per (PAM, territory).
- `portfolio` covers relationships **assigned** to the PAM
  (`partner_relationships.assigned_user_id`). A relationship in the PAM's
  territory that is unassigned or assigned to someone else is not theirs.
- `portfolio.assigned_partner_count` / `assigned_partners` are confirmed
  partners only (`active` or `dormant`). `closed` is historical
  (`counts_by_status.closed`). `needs_review` is opportunity/CRM evidence
  awaiting human confirmation -- never a partner -- and appears only as
  `portfolio.needs_review_count` and in `portfolio.needs_attention`.
- `recruitment` covers recruitments **assigned** to the PAM
  (`partner_recruitments.assigned_user_id`). A recruitment in the PAM's
  territory that is unassigned or assigned to someone else is not theirs.
- `druid_recorded_opportunities` is opportunities recorded in DRUID
  (`source: "druid_partner_opportunities"`), **not** the PAM's complete
  HubSpot pipeline (`hubspot_pipeline: "not_included"`). DRUID-recorded
  opportunities can be a subset of the PAM's HubSpot deals. Aniri must never
  call these figures "the pipeline" or treat the missing HubSpot pipeline as
  zero -- it is unknown in this tool.

### Companion endpoint: `GET /channel-chief/pam-directory`

The PAM roster uses the same machine-to-machine auth and the same territory
representation: each entry is `{ pam_user_id, pam_name, pam_email,
territories, active }`, where `territories` is every territory the PAM owns
(`{ territory_id, territory_name, countries }`, ordered by name then id) and
is `[]` -- never invented -- when they own none. There is no single
`territory_id`/`territory_name` field; never assume a PAM has exactly one
territory.

### Example plugin pseudocode (illustrative only -- not for the actual OpenClaw file, which lives outside this repo)

```
async function get_pam_overview({ pam_name, period }) {
  const url = new URL(`${DRUID_API_BASE}/channel-chief/pam-overview`);
  url.searchParams.set("pam_name", pam_name);
  if (period) url.searchParams.set("period", period);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CHANNEL_CHIEF_API_TOKEN}` },
  });

  if (res.status === 404) return { resolved: false, reason: "not_found" };
  if (res.status === 409) {
    const body = await res.json();
    return { resolved: false, reason: "ambiguous", candidates: body.candidates };
  }
  if (!res.ok) throw new Error(`get_pam_overview failed: ${res.status}`);

  return await res.json(); // passed straight to the model as the tool result
}
```

## Behavioral guidance to add to Aniri

### When PAM-level information is available

1. Answer the user's actual question first -- don't preface with tool talk.
2. Make a commercial judgment from the facts actually returned (e.g. "3 open
   DRUID-recorded deals worth $45k, none overdue" is a judgment; inventing a performance
   percentage that isn't in `performance` is not).
3. Highlight the 1-3 most important things, not every field in the payload.
4. Optionally offer a deeper opportunity/portfolio breakdown if the user wants
   more.

### When data is unavailable

Some fields will legitimately be empty or absent -- no territory assigned
yet, no target configured for the period, no canonical "stalled opportunity"
rule (see `druid_recorded_opportunities.past_due_open`'s plain date-based facts vs. a fabricated
score), etc. `availability` in the response names exactly what's missing and
why. Use that to be honest, briefly, in the user's own language -- never by
explaining the tool.

**BAD** (what actually happened, and must never happen again):
> "Tool-ul meu imi da doar date agregate la nivel Global."

**GOOD:**
> "Nu am inca suficiente date individuale pentru Denny ca sa-i evaluez corect
> performanta. Pot vedea imaginea generala, dar nu vreau sa inventez
> concluzii."

### Do not

- Explain API/tool architecture to the user (no "tool-ul imi da...", no
  mentioning endpoints, tokens, or "date agregate").
- Ask for territory/partners/PAM identity details DRUID Channels can already
  resolve. Only ask a clarifying question when the tool itself reports
  `reason: "ambiguous"` -- i.e. DRUID genuinely could not tell which PAM was
  meant.
- Repeat the same limitation more than once in a conversation.
- Make the user reconstruct data the application already owns.

Romanian responses should stay natural and concise -- the tone of the GOOD
example above, not a translated error message.
