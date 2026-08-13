// Phase 6: DB-free unit test for the single predicate that decides "can this
// caller see this linked opportunity" -- services/campaignService.ts's
// isOpportunityVisible. This is the rule the product brief is strictest
// about: "Do not expose another PAM's opportunities to a PAM." Everything
// else in campaignService needs a live Postgres (see
// tests/campaignsAuthz.test.ts, not runnable in this sandbox without an
// isolated DB -- see project memory on the Docker host running production).
// This test needs neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpportunityVisible, type VisibilityContext } from "../src/services/campaignService";

const GLOBAL: VisibilityContext = { global: true, territoryId: null, userId: "head-1" };
const PAM: VisibilityContext = { global: false, territoryId: "territory-a", userId: "pam-1" };
const PAM_NO_TERRITORY: VisibilityContext = { global: false, territoryId: null, userId: "pam-1" };

test("Head/Admin (global) can see any opportunity regardless of territory or assignment", () => {
  assert.equal(isOpportunityVisible(GLOBAL, { territoryId: "territory-z", assignedUserId: "someone-else" }), true);
});

test("a PAM can see an opportunity assigned to themselves in their own territory", () => {
  assert.equal(isOpportunityVisible(PAM, { territoryId: "territory-a", assignedUserId: "pam-1" }), true);
});

test("a PAM cannot see an opportunity assigned to a different PAM, even in their own territory", () => {
  assert.equal(isOpportunityVisible(PAM, { territoryId: "territory-a", assignedUserId: "pam-2" }), false);
});

test("a PAM cannot see an opportunity in a different territory, even if somehow assigned to them", () => {
  assert.equal(isOpportunityVisible(PAM, { territoryId: "territory-b", assignedUserId: "pam-1" }), false);
});

test("a PAM with no resolved territory can never see any opportunity", () => {
  assert.equal(isOpportunityVisible(PAM_NO_TERRITORY, { territoryId: "territory-a", assignedUserId: "pam-1" }), false);
});
