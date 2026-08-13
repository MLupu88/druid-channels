// Phase 6: structural regression guard for pages/campaigns.tsx. Same
// approach as tests/opportunitiesUiScope.test.ts -- this project has no
// React rendering harness, so every frontend test here is a plain node:test
// source-text check, never a rendered-DOM assertion. Actual authz
// enforcement is server-side (see artifacts/api-server/tests/campaignsAuthz
// .test.ts and campaignOpportunityVisibility.test.ts); this test's job is
// narrower: lock in the product-mandated taxonomy labels, the
// partner-required-on-create rule, the absence of a double-counting
// aggregate pipeline total, and that commercial-impact math never touches
// credit_value from the UI layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, "../src/pages/campaigns.tsx"), "utf-8");

test("all seven activity types are present with the exact product-specified labels", () => {
  const expected: [string, string][] = [
    ["joint_campaign", "Joint Campaign"],
    ["event", "Event / Conference"],
    ["webinar", "Webinar"],
    ["training_enablement", "Training & Enablement"],
    ["co_selling", "Co-selling / Account Activation"],
    ["executive_roundtable", "Executive Roundtable / Workshop"],
    ["other", "Other"],
  ];
  for (const [value, label] of expected) {
    assert.ok(source.includes(`${value}: '${label}'`), `expected TYPE_LABELS to map ${value} -> '${label}'`);
  }
});

test("Training & Enablement is a single type value, never split into two", () => {
  const occurrences = source.split("training_enablement").length - 1;
  assert.ok(occurrences >= 1, "expected training_enablement to appear");
  assert.ok(!source.includes("training_and_enablement"), "must not exist as a separate/second type key");
  assert.ok(!source.includes("enablement_training"), "must not exist as a separate/second type key");
});

test("the create dialog has no 'no specific partner' escape hatch -- partner is required for new activities", () => {
  const createDialogStart = source.indexOf("<DialogTitle>New activity</DialogTitle>");
  assert.notEqual(createDialogStart, -1);
  const createDialogSection = source.slice(createDialogStart);
  assert.ok(!createDialogSection.includes("No specific partner"), "the create dialog must not offer a no-partner option");
});

test("the edit dialog still allows 'no specific partner', so legacy null-partner rows remain fully editable", () => {
  const editDialogStart = source.indexOf("<DialogTitle>Edit activity</DialogTitle>");
  assert.notEqual(editDialogStart, -1);
  const editDialogSection = source.slice(editDialogStart, source.indexOf("<DialogTitle>Delete"));
  assert.ok(editDialogSection.includes("No specific partner"), "the edit dialog must keep the no-partner option for legacy activities");
});

test("the create button is disabled without a selected partner", () => {
  assert.ok(source.includes("!partnerCompanyId"), "expected the create button's disabled condition to require partnerCompanyId");
});

test("the opportunity picker is scoped to the selected partner via company_id, and disabled without one", () => {
  const pickerStart = source.indexOf("function OpportunityLinkPicker(");
  assert.notEqual(pickerStart, -1);
  const pickerBody = source.slice(pickerStart, source.indexOf("\nconst NONE_PARTNER"));
  assert.ok(pickerBody.includes("{ company_id: partnerCompanyId }"), "must fetch opportunities filtered by company_id");
  assert.ok(pickerBody.includes("enabled"), "must gate the fetch on a partner being selected");
});

test("commercial impact never reads credit_value or credit_date -- pipeline/revenue come only from the server-derived linked_open_pipeline/linked_closed_revenue fields", () => {
  assert.ok(!source.includes("credit_value"), "campaigns.tsx must never reference credit_value");
  assert.ok(!source.includes("credit_date"), "campaigns.tsx must never reference credit_date");
  assert.ok(source.includes("linked_open_pipeline"));
  assert.ok(source.includes("linked_closed_revenue"));
});

test("no aggregate/summed marketing pipeline or revenue total is computed across the campaign list (would double-count opportunities linked to multiple activities)", () => {
  assert.ok(!/reduce\(/.test(source), "campaigns.tsx must not reduce/sum values across the campaigns array");
  assert.ok(!/total\s*pipeline/i.test(source), "must not introduce a 'total pipeline' concept");
  assert.ok(!/total\s*revenue/i.test(source), "must not introduce a 'total revenue' concept");
});

test("no ROI, attribution percentage, weighted pipeline, lead scoring, or approval workflow language appears", () => {
  assert.ok(!/\broi\b/i.test(source));
  assert.ok(!/attribution\s*(percent|%|weight)/i.test(source));
  assert.ok(!/lead\s*scor/i.test(source));
  assert.ok(!/approv/i.test(source));
});

test("list view handles loading and error states, and mutations have onError toasts", () => {
  assert.ok(source.includes("isLoading ?"));
  assert.ok(source.includes("isError ?"));
  const onErrorCount = (source.match(/onError:/g) ?? []).length;
  assert.ok(onErrorCount >= 3, `expected onError handlers on create/update/delete mutations, found ${onErrorCount}`);
});

test("basic filters exist for partner, type, and status", () => {
  assert.ok(source.includes("filterPartner"));
  assert.ok(source.includes("filterType"));
  assert.ok(source.includes("filterStatus"));
});
