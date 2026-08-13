// Phase 5B-2: structural regression guard for pages/opportunities.tsx.
// Actual authz enforcement is server-side (GET/POST/PATCH /opportunities --
// see artifacts/api-server/tests/opportunitiesAuthz.test.ts and
// partnerOpportunities.test.ts); this test's job is narrower: catch a
// future edit that accidentally adds a PAM/territory reassignment control,
// exposes an integration/provenance field for manual editing, or lets a
// Head/Admin session trigger the create/edit mutation path. This project
// has no React rendering harness (see tests/commercialPerformanceRoleScope
// .test.ts and siblings) -- every frontend test here is a plain node:test
// source-text check, never a rendered-DOM assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, "../src/pages/opportunities.tsx"), "utf-8");

const dialogMarker = "function OpportunityFormDialog(";
const dialogStart = source.indexOf(dialogMarker);

test("opportunities.tsx defines OpportunityFormDialog as a distinct section of the file", () => {
  assert.notEqual(dialogStart, -1, "expected to find OpportunityFormDialog in opportunities.tsx");
});

const listSection = source.slice(0, dialogStart);
const dialogSection = source.slice(dialogStart);

test("PAM/Head mutation gate is a single boolean derived from role, never a per-record check", () => {
  assert.ok(source.includes("const canMutate = !isGlobalUser"), "expected canMutate to be derived directly from !isGlobalUser");
});

test("the Add opportunity button only renders when canMutate is true", () => {
  const addButtonIndex = listSection.indexOf("button-add-opportunity");
  assert.notEqual(addButtonIndex, -1, "expected an Add opportunity button");
  const precedingSlice = listSection.slice(Math.max(0, addButtonIndex - 200), addButtonIndex);
  assert.ok(precedingSlice.includes("canMutate &&"), "Add opportunity button must be gated behind canMutate");
});

test("row click-to-edit and the form dialog itself are both gated behind canMutate", () => {
  assert.ok(listSection.includes("onClick={canMutate ?"), "table row edit trigger must be conditioned on canMutate");
  assert.ok(listSection.includes("{canMutate && formOpen && ("), "the create/edit dialog must only mount when canMutate is true");
});

test("the list view never references a PAM roster or reassignment hook (Head is view-only in this slice)", () => {
  assert.ok(!source.includes("useListUsers"), "opportunities.tsx must not fetch the PAM roster -- no reassignment UI in this slice");
  assert.ok(!/reassign/i.test(source), "opportunities.tsx must not implement opportunity reassignment");
});

test("the create/edit dialog never renders a territory or assignee picker (PAM scope comes from props, not user input)", () => {
  assert.ok(!dialogSection.includes("Territory"), "OpportunityFormDialog must not expose a territory picker");
  assert.ok(!dialogSection.includes("Assigned"), "OpportunityFormDialog must not expose an assignee picker");
  assert.ok(!dialogSection.includes("PAM"), "OpportunityFormDialog must not expose a PAM/user picker");
});

test("territory_id/assigned_user_id are only ever taken from props on create, never from dialog-local state", () => {
  const createCallIndex = dialogSection.indexOf("createMutation.mutate(");
  assert.notEqual(createCallIndex, -1, "expected a createMutation.mutate call");
  const createCall = dialogSection.slice(createCallIndex, createCallIndex + 300);
  assert.ok(createCall.includes("territory_id: territoryId!"), "territory_id must come from the territoryId prop");
  assert.ok(createCall.includes("assigned_user_id: assignedUserId!"), "assigned_user_id must come from the assignedUserId prop");
});

test("integration/provenance fields are never referenced anywhere in the opportunities UI", () => {
  for (const field of ["source_system", "external_id", "source_updated_at", "last_synced_at"]) {
    assert.ok(!source.includes(field), `opportunities.tsx must never reference provenance field ${field}`);
  }
});

test("attribution labels distinguish Partner-Sourced from Partner-Influenced", () => {
  assert.ok(source.includes("'Partner-Sourced'"));
  assert.ok(source.includes("'Partner-Influenced'"));
});

test("status handling covers open, won, and lost with no invented pipeline stages", () => {
  assert.ok(source.includes("open: 'Open'") && source.includes("won: 'Won'") && source.includes("lost: 'Lost'"));
  assert.ok(!/probability|forecast|kanban|delete/i.test(source), "must not invent probability%, forecasting, kanban, or delete");
});

test("won requires closed_at, both in submit validation and as a conditionally-required field", () => {
  assert.ok(dialogSection.includes("(status !== 'won' || !!closedAt)"), "canSubmit must require closedAt only when status is won");
  assert.ok(dialogSection.includes("status === 'won' &&"), "the closed date input must only render when status is won");
});

test("target credit override is a collapsed, optional advanced section with the specified helper text", () => {
  assert.ok(dialogSection.includes("Target credit override"));
  assert.ok(dialogSection.includes("Use only when commercial target credit differs from the deal's actual close value/date."));
  assert.ok(!dialogSection.includes("!!creditValue &&") , "credit_value must never be a hard requirement of canSubmit");
});

test("opportunity values render in their own native currency, never a fixed or converted currency", () => {
  assert.ok(listSection.includes("formatMoney(o.deal_value, o.currency)"), "the list must format each row's value with that row's own currency");
  assert.ok(!/convertMoney|usd_to_currency_rate/i.test(source), "opportunities.tsx must never convert deal_value -- that is Overview's job, not this ledger's");
});

test("list view handles loading, error, and the exact specified empty state", () => {
  assert.ok(listSection.includes("isLoading ?"));
  assert.ok(listSection.includes("isError ?"));
  assert.ok(listSection.includes("No opportunities yet. Add the partner-sourced or partner-influenced deals you're actively working."));
});

test("a PAM with no canonical territory is blocked before any list request, matching Portfolio's guard", () => {
  assert.ok(source.includes("pamHasNoTerritory"));
  assert.ok(source.includes("enabled: !pamHasNoTerritory"));
});
