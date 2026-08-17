// Phase 11.6.1: pure, DB-free unit tests for the "is this a material
// change worth recording for Aniri/Channel Chief" decision logic --
// targetService.ts's diffTargetValues and routes/opportunities.ts's
// diffMaterialOpportunityFields. No live network, DB, or server. These are
// the exact functions that decide whether channelChangeEventsService.ts's
// recordChannelChangeEvent is ever called, so proving their behavior here
// is what proves "a no-op save never becomes a material change event."
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTargetValues, type TargetMaterialValues } from "../src/services/targetService";
import { diffMaterialOpportunityFields } from "../src/routes/opportunities";
import { boundFeedLimit } from "../src/services/channelChangeFeedService";

// ---- diffTargetValues -------------------------------------------------

test("diffTargetValues: null before (create) is always material, old_values null, new_values the full shape", () => {
  const after: TargetMaterialValues = { target_value: 100, note: "Q3 push" };
  const diff = diffTargetValues(null, after);
  assert.ok(diff);
  assert.equal(diff!.oldValues, null);
  assert.deepEqual(diff!.newValues, { target_value: 100, note: "Q3 push" });
});

test("diffTargetValues: identical target_value and note is a no-op -- returns null, never a fabricated event", () => {
  const before: TargetMaterialValues = { target_value: 100, note: "Q3 push" };
  const after: TargetMaterialValues = { target_value: 100, note: "Q3 push" };
  assert.equal(diffTargetValues(before, after), null);
});

test("diffTargetValues: a changed target_value is material, both old and new values preserved exactly", () => {
  const before: TargetMaterialValues = { target_value: 100, note: "Q3 push" };
  const after: TargetMaterialValues = { target_value: 150, note: "Q3 push" };
  const diff = diffTargetValues(before, after);
  assert.ok(diff);
  assert.deepEqual(diff!.oldValues, { target_value: 100, note: "Q3 push" });
  assert.deepEqual(diff!.newValues, { target_value: 150, note: "Q3 push" });
});

test("diffTargetValues: a changed note alone (target_value unchanged) is still material", () => {
  const before: TargetMaterialValues = { target_value: 100, note: null };
  const after: TargetMaterialValues = { target_value: 100, note: "Revised after Irina 1:1" };
  const diff = diffTargetValues(before, after);
  assert.ok(diff);
  assert.deepEqual(diff!.newValues, { target_value: 100, note: "Revised after Irina 1:1" });
});

// ---- diffMaterialOpportunityFields --------------------------------------

const BASE_MATERIAL_FIELDS = {
  company_id: "company-1",
  territory_id: "territory-1",
  assigned_user_id: "user-1",
  attribution_type: "partner_sourced",
  status: "open",
  deal_value: 10000,
  currency: "USD",
  opportunity_date: "2026-01-01",
  expected_close_date: "2026-03-01",
  closed_at: null,
  credit_value: null,
  credit_date: null,
  customer_name: "Acme Corp",
};

test("diffMaterialOpportunityFields: identical material fields is a no-op -- returns null", () => {
  assert.equal(diffMaterialOpportunityFields({ ...BASE_MATERIAL_FIELDS }, { ...BASE_MATERIAL_FIELDS }), null);
});

test("diffMaterialOpportunityFields: a status change alone is material, and old/new contain ONLY the changed field", () => {
  const after = { ...BASE_MATERIAL_FIELDS, status: "won", closed_at: "2026-02-15T00:00:00.000Z" };
  const diff = diffMaterialOpportunityFields({ ...BASE_MATERIAL_FIELDS }, after);
  assert.ok(diff);
  assert.deepEqual(diff!.oldValues, { status: "open", closed_at: null });
  assert.deepEqual(diff!.newValues, { status: "won", closed_at: "2026-02-15T00:00:00.000Z" });
  // Every OTHER field is unchanged and must not appear in the diff at all.
  assert.ok(!("deal_value" in diff!.oldValues));
  assert.ok(!("customer_name" in diff!.oldValues));
});

test("diffMaterialOpportunityFields: a deal_value change alone captures only deal_value", () => {
  const after = { ...BASE_MATERIAL_FIELDS, deal_value: 25000 };
  const diff = diffMaterialOpportunityFields({ ...BASE_MATERIAL_FIELDS }, after);
  assert.ok(diff);
  assert.deepEqual(diff!.oldValues, { deal_value: 10000 });
  assert.deepEqual(diff!.newValues, { deal_value: 25000 });
});

test("diffMaterialOpportunityFields: reassignment (assigned_user_id + territory_id) captures only those two fields", () => {
  const after = { ...BASE_MATERIAL_FIELDS, assigned_user_id: "user-2", territory_id: "territory-2" };
  const diff = diffMaterialOpportunityFields({ ...BASE_MATERIAL_FIELDS }, after);
  assert.ok(diff);
  assert.deepEqual(diff!.oldValues, { assigned_user_id: "user-1", territory_id: "territory-1" });
  assert.deepEqual(diff!.newValues, { assigned_user_id: "user-2", territory_id: "territory-2" });
});

// ---- boundFeedLimit ------------------------------------------------------

test("boundFeedLimit: defaults to 50 when omitted, caps at 200, never returns a non-positive value", () => {
  assert.equal(boundFeedLimit(undefined), 50);
  assert.equal(boundFeedLimit(null), 50);
  assert.equal(boundFeedLimit(500), 200);
  assert.equal(boundFeedLimit(0), 1);
  assert.equal(boundFeedLimit(-10), 1);
  assert.equal(boundFeedLimit(75), 75);
});
