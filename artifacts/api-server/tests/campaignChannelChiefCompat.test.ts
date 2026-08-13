// Phase 6: structural regression guard proving the pre-existing campaign
// consumers added at/before HEAD 1f0bca4 (Channel Chief snapshot, weekly
// marketing KPI) were NOT touched by the Phase 6 taxonomy expansion and
// campaign_opportunities join table. This is a source-text check, not a
// live-DB integration test (see tests/campaignOpportunityVisibility.test.ts
// and project memory for why -- this sandbox must not touch any Postgres,
// disposable or otherwise, without a user-established isolated environment).
// If either consumer genuinely needs to change in a later phase, update
// this test deliberately alongside that change -- it should never pass by
// accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const channelChiefSource = readFileSync(path.join(__dirname, "../src/services/channelChiefContextService.ts"), "utf-8");
const kpiSource = readFileSync(path.join(__dirname, "../src/services/kpiService.ts"), "utf-8");

test("Channel Chief's getActivitySnapshot still selects exactly the same campaign columns as before Phase 6", () => {
  const start = channelChiefSource.indexOf("async function getActivitySnapshot(");
  assert.notEqual(start, -1, "expected to find getActivitySnapshot in channelChiefContextService.ts");
  const body = channelChiefSource.slice(start, start + 700);

  for (const field of ["campaignsTable.name", "campaignsTable.type", "campaignsTable.status", "campaignsTable.territory", "campaignsTable.activityDate", "campaignsTable.mqls", "campaignsTable.partnerReferrals"]) {
    assert.ok(body.includes(field), `expected getActivitySnapshot to still select ${field}`);
  }
});

test("Channel Chief's activity snapshot does not reach into Phase 6 opportunity linkage (stays a pure campaigns read, unchanged scope)", () => {
  const start = channelChiefSource.indexOf("async function getActivitySnapshot(");
  const nextFn = channelChiefSource.indexOf("\nasync function", start + 1);
  const body = channelChiefSource.slice(start, nextFn === -1 ? undefined : nextFn);
  assert.ok(!body.includes("campaignOpportunitiesTable"), "getActivitySnapshot must not reference the new join table -- Channel Chief's activity feed is intentionally unchanged in Phase 6");
  assert.ok(!body.includes("partnerOpportunitiesTable"), "getActivitySnapshot must not reference partner_opportunities -- unchanged in Phase 6");
});

test("weekly_marketing KPI metric registry (ACTIVITY_FIELD_BY_KEY) still maps only the original three type counts plus mqls/partner_referrals sums", () => {
  const start = kpiSource.indexOf("const ACTIVITY_FIELD_BY_KEY");
  assert.notEqual(start, -1, "expected to find ACTIVITY_FIELD_BY_KEY in kpiService.ts");
  const end = kpiSource.indexOf("};", start);
  const body = kpiSource.slice(start, end);

  assert.ok(body.includes('joint_campaigns: { kind: "count", type: "joint_campaign" }'));
  assert.ok(body.includes('events: { kind: "count", type: "event" }'));
  assert.ok(body.includes('webinars: { kind: "count", type: "webinar" }'));
  assert.ok(body.includes('marketing_qualified_leads: { kind: "sum", field: "mqls" }'));
  assert.ok(body.includes('partner_referrals: { kind: "sum", field: "partnerReferrals" }'));

  // The four Phase 6 types must NOT silently start being counted by an
  // existing KPI metric -- if they ever should be, that is a deliberate
  // future decision, not a side effect of the taxonomy expansion.
  for (const newType of ["training_enablement", "co_selling", "executive_roundtable", "other"]) {
    assert.ok(!body.includes(`type: "${newType}"`), `ACTIVITY_FIELD_BY_KEY must not count the new type "${newType}" unless deliberately added`);
  }
});

test("campaigns schema's Phase 6 taxonomy expansion is additive: the original three type values are still first in CAMPAIGN_TYPES", () => {
  const schemaSource = readFileSync(path.join(__dirname, "../../../lib/db/src/schema/campaigns.ts"), "utf-8");
  const start = schemaSource.indexOf("export const CAMPAIGN_TYPES");
  assert.notEqual(start, -1);
  const end = schemaSource.indexOf("] as const", start);
  const body = schemaSource.slice(start, end);
  const order = ["joint_campaign", "event", "webinar", "training_enablement", "co_selling", "executive_roundtable", "other"];
  let lastIndex = -1;
  for (const type of order) {
    const idx = body.indexOf(`"${type}"`);
    assert.ok(idx !== -1, `expected CAMPAIGN_TYPES to include "${type}"`);
    assert.ok(idx > lastIndex, `expected "${type}" to appear after the previous type in CAMPAIGN_TYPES (original three first)`);
    lastIndex = idx;
  }
});
