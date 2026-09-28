# Aniri / OpenClaw: `get_pam_commercial_rollup` contract

Status: **documentation only** for the OpenClaw side, which lives outside this
repository. The backend half exists in this repo:
`GET /channel-chief/pam-commercial-rollup`
(`artifacts/api-server/src/routes/channel_chief.ts`, backed by
`artifacts/api-server/src/services/pamCommercialRollupService.ts`).

The Head of Channels sees the same result in Partner Radar under
**Reporting → Commercial** (`/team-commercial`, backed by the human-session
route `GET /pam-commercial/rollup`). Both routes call the same service and
return the same JSON; there is one definition of these numbers.

## What it answers

"How is commercial coverage spread across the PAM team right now?" -- which
PAM holds how many confirmed partners, how many relationships are still
awaiting review, how many of those are linked to a HubSpot company, and how
many current relationships have no PAM at all.

It does **not** answer "how much pipeline / how many deals / how much
revenue does the team have". Nothing in this slice computes that, and Aniri
must not infer it.

## Tool: `get_pam_commercial_rollup`

### Arguments

None.

### Behavior

- Calls `GET {DRUID_API_BASE}/channel-chief/pam-commercial-rollup` with the
  existing `Authorization: Bearer ${CHANNEL_CHIEF_API_TOKEN}` header -- same
  auth as `get_channel_snapshot`, `get_pam_overview` and the PAM directory. No
  new secret. Human session tokens are rejected (`401`).
- Returns the body verbatim as the tool result.
- `401` → generic tool failure (auth misconfiguration), never a business fact.
- DB-only: no HubSpot calls, no AI calls, no writes, no caching of deal data.

### Response shape

```jsonc
{
  "ownership_basis": "partner_relationships.assigned_user_id",
  "territory_basis": "context_only",
  "hubspot_read": "not_performed",
  "included_statuses": {
    "confirmed": ["active", "dormant"],
    "awaiting_review": ["needs_review"],
    "excluded": ["closed"]
  },
  "totals":          { "confirmed_partners": 0, "awaiting_review": 0, "crm_linked_confirmed": 0, "crm_linked_awaiting_review": 0 },
  "pams": [
    {
      "pam_user_id": "…",
      "pam_name": "…",
      "pam_email": "…",
      "territories": [{ "territory_id": "…", "territory_name": "…", "countries": ["…"] }],
      "counts": { "confirmed_partners": 0, "awaiting_review": 0, "crm_linked_confirmed": 0, "crm_linked_awaiting_review": 0 }
    }
  ],
  "unassigned":      { "confirmed_partners": 0, "awaiting_review": 0, "crm_linked_confirmed": 0, "crm_linked_awaiting_review": 0 },
  "other_assignees": { "confirmed_partners": 0, "awaiting_review": 0, "crm_linked_confirmed": 0, "crm_linked_awaiting_review": 0 }
}
```

### Field semantics

- `pams` lists **every active PAM exactly once**, ordered by name then id,
  including PAMs with zero relationships (all counts `0`).
- Counts are grouped by `partner_relationships.assigned_user_id` only.
- `territories` is every territory the PAM owns (`territories.owner_user_id`),
  same representation as the PAM directory. It is **context only**: a
  relationship in a PAM's territory that is not assigned to that PAM is not
  counted on their row.
- `unassigned` -- current relationships with no assigned PAM. They are never
  attributed to the territory owner.
- `other_assignees` -- current relationships assigned to someone who is not
  an active PAM (an inactive PAM, or a head_of_channels/admin account). Kept
  visible rather than dropped or re-attributed.
- `totals` = sum of every `pams[].counts` + `unassigned` + `other_assignees`.
- `confirmed_partners` = `active` + `dormant`.
- `awaiting_review` = `needs_review`: CRM/opportunity evidence exists, the
  relationship is **not** a confirmed partner.
- `closed` relationships are historical and excluded from every count.
- `crm_linked_*` = the relationship's company has a `hubspot_company_id`.

## Truth boundary (Aniri must respect all of these)

| Statement | Why |
|-----------|-----|
| CRM linked ≠ deal exists | A HubSpot company ID is linkage only. The company may have zero deals. |
| CRM linked ≠ active opportunity | Even with deals, none may be open. This endpoint never looks. |
| needs_review ≠ partner | Evidence awaiting human confirmation. Never add it to the partner count. |
| territory owner ≠ relationship owner | Ownership is `assigned_user_id`. Territory is context. |
| No figure here is pipeline, deals or revenue | Those are unknown at team level in this slice -- never zero, never estimated. |

For live deal facts, a human opens the PAM in Partner Radar (Reporting →
Commercial → Open commercial), which reuses the PAM Commercial workspace;
HubSpot deals are then read lazily, one relationship at a time. Aniri has no
team-wide deal feed in this slice.

## Behavioral guidance

- Say "X confirmed partners, Y linked to HubSpot" -- never "Y partners with
  deals" or "Y active opportunities".
- Report awaiting-review relationships separately from partners, e.g. "plus
  Z relationships awaiting review".
- If `unassigned` or `other_assignees` is non-zero, say so plainly; do not
  guess who owns them.
- If asked for team pipeline or revenue from this tool, say that DRUID does
  not have a team-wide live figure here -- do not compute one from
  `crm_linked_*`, and do not explain the API.
