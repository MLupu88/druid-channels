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

// This file's `//`-comments legitimately discuss the *absence* of
// reassignment/PAM-picker/territory-picker controls (explaining a design
// decision, e.g. "no complex reassignment UI"), which makes a loose
// word-match over the raw source brittle -- it flags prose right alongside
// actual controls. Assertions that check "this concept must never appear"
// run against the comment-stripped code instead, so they only fire on a
// real hook call, JSX element, or identifier -- never on a comment
// explaining why one doesn't exist. Precise code-shape assertions
// elsewhere in this file (e.g. matching "createMutation.mutate(") already
// run against the untouched source, since those exact strings can't appear
// in a comment by coincidence.
function stripLineComments(code: string): string {
  return code.replace(/\/\/.*$/gm, "");
}
const sourceCode = stripLineComments(source);
const dialogSectionCode = stripLineComments(dialogSection);

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

test("no reassignment hook, handler, or control is ever wired into actual code (Head is view-only in this slice)", () => {
  assert.ok(!sourceCode.includes("useListUsers"), "opportunities.tsx must not fetch the PAM roster -- no reassignment UI in this slice");
  assert.ok(!/reassign/i.test(sourceCode), "opportunities.tsx must not call, define, or render any reassignment hook/handler/control in code (comments may still explain why one doesn't exist)");
});

test("the create/edit dialog never renders a territory or assignee picker in actual JSX/code (PAM scope comes from props, not user input)", () => {
  assert.ok(!dialogSectionCode.includes("Territory"), "OpportunityFormDialog must not expose a territory picker");
  assert.ok(!dialogSectionCode.includes("Assigned"), "OpportunityFormDialog must not expose an assignee picker");
  assert.ok(!dialogSectionCode.includes("PAM"), "OpportunityFormDialog must not expose a PAM/user picker (comments may still reference PAMs to explain design intent)");
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

test("list view handles loading and error states", () => {
  assert.ok(listSection.includes("isLoading ?"));
  assert.ok(listSection.includes("isError ?"));
});

test("the empty state is role-aware: PAM sees an add-oriented message, Head/Admin sees a read-only message", () => {
  const emptyStateIndex = listSection.indexOf("No opportunities yet.");
  assert.notEqual(emptyStateIndex, -1, "expected an empty-state message");
  const emptyStateBlock = listSection.slice(Math.max(0, emptyStateIndex - 150), emptyStateIndex + 300);
  assert.ok(emptyStateBlock.includes("canMutate"), "the empty-state text must branch on canMutate, not render one fixed string for both roles");
  assert.ok(
    emptyStateBlock.includes("No opportunities yet. Add the partner-sourced or partner-influenced deals you're actively working."),
    "PAM (canMutate) empty state must keep the exact specified add-oriented copy",
  );
  assert.ok(
    emptyStateBlock.includes('No opportunities yet. Partner-sourced and partner-influenced deals created by PAMs will appear here.'),
    "Head/Admin (view-only) empty state must not tell a read-only user to add an opportunity",
  );
});

test("a PAM with no canonical territory is blocked before any list request, matching Portfolio's guard", () => {
  assert.ok(source.includes("pamHasNoTerritory"));
  assert.ok(source.includes("enabled: !pamHasNoTerritory"));
});
