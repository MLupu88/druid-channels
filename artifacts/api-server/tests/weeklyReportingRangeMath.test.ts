// Phase 7: DB-free unit tests for the two pure primitives the weekly
// reporting range/scope refactor of kpiService.ts relies on --
// matchesOpportunityScope (PAM-identity scoping) and dayAfter (the
// [start, end) <-> old inclusive-"<=" equivalence). Importing kpiService.ts
// still requires DATABASE_URL to be set (see @workspace/db's index.ts),
// even though nothing here ever queries it -- same convention as
// tests/targetProgress.test.ts / tests/periodResolution.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesOpportunityScope, dayAfter, type OpportunityScope } from "../src/services/kpiService";

// ---- matchesOpportunityScope --------------------------------------------

const oppInTerritoryA_ownedByDenny = { territoryId: "territory-a", assignedUserId: "denny" };
const oppInTerritoryA_ownedByJames = { territoryId: "territory-a", assignedUserId: "james" };
const oppInTerritoryB_ownedByDenny = { territoryId: "territory-b", assignedUserId: "denny" };

test("global scope matches every opportunity regardless of territory or assignee", () => {
  const scope: OpportunityScope = { kind: "global" };
  assert.equal(matchesOpportunityScope(oppInTerritoryA_ownedByDenny, scope), true);
  assert.equal(matchesOpportunityScope(oppInTerritoryA_ownedByJames, scope), true);
  assert.equal(matchesOpportunityScope(oppInTerritoryB_ownedByDenny, scope), true);
});

test("territory scope matches by territory alone, regardless of assignee", () => {
  const scope: OpportunityScope = { kind: "territory", territoryId: "territory-a" };
  assert.equal(matchesOpportunityScope(oppInTerritoryA_ownedByDenny, scope), true);
  assert.equal(matchesOpportunityScope(oppInTerritoryA_ownedByJames, scope), true, "territory scope must not also require a specific assignee");
  assert.equal(matchesOpportunityScope(oppInTerritoryB_ownedByDenny, scope), false);
});

test("pam scope requires BOTH territory (within the PAM's owned set) and assigned_user_id to match -- same two-part rule as assertPamOwnsOpportunity/isOpportunityVisible", () => {
  const dennyScope: OpportunityScope = { kind: "pam", territoryIds: ["territory-a"], assignedUserId: "denny" };
  assert.equal(matchesOpportunityScope(oppInTerritoryA_ownedByDenny, dennyScope), true);
});

test("pam scope excludes an opportunity in the SAME territory but assigned to a different PAM -- the one-PAM-per-territory pattern is never an authorization boundary", () => {
  const dennyScope: OpportunityScope = { kind: "pam", territoryIds: ["territory-a"], assignedUserId: "denny" };
  assert.equal(
    matchesOpportunityScope(oppInTerritoryA_ownedByJames, dennyScope),
    false,
    "an opportunity assigned to James must never count toward Denny's PAM-scoped weekly report just because it sits in Denny's territory",
  );
});

test("pam scope excludes an opportunity assigned to the same PAM but in a different territory not in their owned set", () => {
  const dennyScope: OpportunityScope = { kind: "pam", territoryIds: ["territory-a"], assignedUserId: "denny" };
  assert.equal(matchesOpportunityScope(oppInTerritoryB_ownedByDenny, dennyScope), false);
});

test("pam scope with multiple owned territories matches an opportunity in ANY of them, still requiring the same assignee", () => {
  const dennyScope: OpportunityScope = { kind: "pam", territoryIds: ["territory-a", "territory-b"], assignedUserId: "denny" };
  assert.equal(matchesOpportunityScope(oppInTerritoryA_ownedByDenny, dennyScope), true);
  assert.equal(matchesOpportunityScope(oppInTerritoryB_ownedByDenny, dennyScope), true);
  assert.equal(
    matchesOpportunityScope(oppInTerritoryA_ownedByJames, dennyScope),
    false,
    "owning multiple territories must never widen visibility to another PAM's assignment",
  );
});

// ---- dayAfter / inclusive-end equivalence --------------------------------

function oldInclusiveInRange(dateStr: string, start: string, end: string): boolean {
  return dateStr >= start && dateStr <= end;
}
function newExclusiveInRange(dateStr: string, start: string, endExclusive: string): boolean {
  return dateStr >= start && dateStr < endExclusive;
}

test("dayAfter advances by exactly one calendar day", () => {
  assert.equal(dayAfter("2026-03-15"), "2026-03-16");
});

test("dayAfter correctly rolls over a month boundary", () => {
  assert.equal(dayAfter("2026-02-28"), "2026-03-01"); // 2026 is not a leap year
});

test("dayAfter correctly rolls over a leap-year February", () => {
  assert.equal(dayAfter("2024-02-28"), "2024-02-29");
});

test("dayAfter correctly rolls over a year boundary", () => {
  assert.equal(dayAfter("2026-12-31"), "2027-01-01");
});

test("`d <= end` and `d < dayAfter(end)` agree for every date around the boundary -- proves the refactored computeClosedRevenue/computeOpportunitiesCreated preserve their exact pre-Phase-7 inclusive-end behavior", () => {
  const start = "2026-07-01";
  const end = "2026-07-15";
  const endExclusive = dayAfter(end);
  assert.equal(endExclusive, "2026-07-16");

  const candidates = ["2026-06-30", "2026-07-01", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"];
  for (const d of candidates) {
    assert.equal(
      oldInclusiveInRange(d, start, end),
      newExclusiveInRange(d, start, endExclusive),
      `mismatch at ${d}: old inclusive-end and new [start, dayAfter(end)) semantics must agree`,
    );
  }
});
