// Pure unit tests for Stage 6 Partner Relationship status transitions and
// period-reporting eligibility -- no live network, DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidRelationshipTransition, eventTypeForTransition, isEligibleForPeriodMetric, isNeedingAttention } from "../src/services/partnerRelationshipService";

test("active <-> dormant <-> closed transitions, with direct reactivation from closed", () => {
  assert.equal(isValidRelationshipTransition("active", "dormant"), true);
  assert.equal(isValidRelationshipTransition("active", "closed"), true);
  assert.equal(isValidRelationshipTransition("dormant", "active"), true);
  assert.equal(isValidRelationshipTransition("dormant", "closed"), true);
  assert.equal(isValidRelationshipTransition("closed", "active"), true);
});

test("closed cannot go directly to dormant, and same-status is rejected", () => {
  assert.equal(isValidRelationshipTransition("closed", "dormant"), false);
  assert.equal(isValidRelationshipTransition("active", "active"), false);
  assert.equal(isValidRelationshipTransition("dormant", "dormant"), false);
  assert.equal(isValidRelationshipTransition("closed", "closed"), false);
});

test("event_type is structured, not just a free-text note -- reactivated only fires from dormant/closed into active", () => {
  assert.equal(eventTypeForTransition("dormant", "active"), "reactivated");
  assert.equal(eventTypeForTransition("closed", "active"), "reactivated");
  assert.equal(eventTypeForTransition("active", "closed"), "closed");
  assert.equal(eventTypeForTransition("active", "dormant"), "status_changed");
});

test("period eligibility: unknown precision is excluded from every period, never fabricated", () => {
  assert.equal(isEligibleForPeriodMetric("unknown", "quarter"), false);
  assert.equal(isEligibleForPeriodMetric("unknown", "year"), false);
});

test("period eligibility: year precision is usable only for annual (year) reporting, not quarter", () => {
  assert.equal(isEligibleForPeriodMetric("year", "quarter"), false);
  assert.equal(isEligibleForPeriodMetric("year", "year"), true);
});

test("period eligibility: exact_date/month/quarter precision are usable for both quarter and year reporting", () => {
  for (const precision of ["exact_date", "month", "quarter"] as const) {
    assert.equal(isEligibleForPeriodMetric(precision, "quarter"), true, precision);
    assert.equal(isEligibleForPeriodMetric(precision, "year"), true, precision);
  }
});

// ---- Phase 12 Portfolio Reconciliation: needs_review -----------------------

test("needs_review is entry-only: it may transition to active/dormant/closed, but nothing transitions back into it", () => {
  assert.equal(isValidRelationshipTransition("needs_review", "active"), true);
  assert.equal(isValidRelationshipTransition("needs_review", "dormant"), true);
  assert.equal(isValidRelationshipTransition("needs_review", "closed"), true);
  assert.equal(isValidRelationshipTransition("needs_review", "needs_review"), false);
  for (const from of ["active", "dormant", "closed"] as const) {
    assert.equal(isValidRelationshipTransition(from, "needs_review"), false, `${from} -> needs_review must never be allowed`);
  }
});

test("isNeedingAttention: a needs_review relationship always needs attention, regardless of next_action or last_interaction_at", () => {
  assert.equal(isNeedingAttention({ status: "needs_review", nextAction: null, lastInteractionAt: null }), true);
  assert.equal(
    isNeedingAttention({ status: "needs_review", nextAction: "Call scheduled", lastInteractionAt: new Date() }),
    true,
    "an unclassified relationship needs a human look even if it happens to have a next_action/recent interaction set",
  );
});

test("isNeedingAttention: dormant/closed relationships never need attention, needs_review or not", () => {
  assert.equal(isNeedingAttention({ status: "dormant", nextAction: null, lastInteractionAt: null }), false);
  assert.equal(isNeedingAttention({ status: "closed", nextAction: null, lastInteractionAt: null }), false);
});
