// PAM Commercial Workspace v1 (Slice C): semantics of the Commercial tab.
// Pure checks on src/lib/pam-commercial.ts plus source-text boundaries on
// src/components/pam-commercial-workspace.tsx -- same convention as
// tests/druidContextFactUx.test.ts / commercialCurrencyDisplay.test.ts; this
// project has no React rendering harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PamCommercialDeal, PamCommercialDealFacts, PamCommercialRelationshipDeals } from "@workspace/api-client-react";
import {
  AWAITING_REVIEW_SECTION_TITLE,
  COMMERCIAL_UNKNOWN,
  CRM_OWNER_LABEL,
  NOT_LINKED_TITLE,
  OWNER_DETAILS_UNAVAILABLE,
  PROVEN_ZERO_COPY,
  availabilityTitle,
  classifyDealSet,
  dealStateLabel,
  formatCrmOwner,
  formatDealAmount,
  formatDealDate,
  formatIdLabel,
  truncationNotice,
} from "../src/lib/pam-commercial";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(path.join(__dirname, "../src/components/pam-commercial-workspace.tsx"), "utf-8");
const workspaceSource = readFileSync(path.join(__dirname, "../src/pages/pam-workspace.tsx"), "utf-8");

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected function ${name}`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

const ZERO_WORDING = /no deals|0 deals|no pipeline/i;

function facts(overrides: Partial<PamCommercialDealFacts> = {}): PamCommercialDealFacts {
  return {
    deal_name: "Acme renewal",
    amount: "12500",
    currency: "EUR",
    pipeline: { id: "default", label: "Sales pipeline" },
    stage: { id: "123456", label: "Proposal" },
    deal_state: "open",
    close_date: "2026-11-30T00:00:00.000Z",
    create_date: "2026-01-01T00:00:00.000Z",
    last_modified_at: "2026-09-20T10:00:00.000Z",
    crm_owner: { owner_id: "77", resolution: "resolved", first_name: "Dana", last_name: "Rep", email: "dana@example.com", archived: false },
    associated_companies: [],
    associated_companies_truncated: false,
    property_history: [],
    ...overrides,
  };
}

function deal(id: string, overrides: Partial<PamCommercialDeal> = {}): PamCommercialDeal {
  return { deal_id: id, association_types: [], load_status: "loaded", error: null, facts: facts(), druid_opportunities: { match_status: "no_match", records: [] }, ...overrides };
}

function response(overrides: Partial<PamCommercialRelationshipDeals>): Pick<PamCommercialRelationshipDeals, "hubspot" | "association" | "deals"> {
  return { hubspot: { availability: "available", message: "" }, association: { returned_count: 0, truncated: false }, deals: [], ...overrides };
}

// 1 + 2 ---------------------------------------------------------------------

test("confirmed (active/dormant) and awaiting-review relationships render in separate sections", () => {
  const root = sliceFunction(componentSource, "PamCommercialWorkspace");
  assert.ok(root.includes("data.confirmed_relationships"));
  assert.ok(root.includes("Confirmed Portfolio partners"));
  assert.ok(root.includes("unconfirmed={false}"), "confirmed rows must not carry the unconfirmed marker");
  assert.ok(root.includes("<AwaitingReviewSection relationships={awaiting} />"));
  assert.ok(!root.includes("closed"), "closed relationships are never rendered");
});

test("awaiting review is a collapsed, visibly unconfirmed section", () => {
  assert.equal(AWAITING_REVIEW_SECTION_TITLE, "Awaiting review — not confirmed partners");
  const section = sliceFunction(componentSource, "AwaitingReviewSection");
  assert.ok(section.includes("useState(false)"), "awaiting review starts collapsed");
  assert.ok(section.includes("unconfirmed />"), "awaiting-review rows carry the unconfirmed marker");
  // The marker persists after deals load (13: deals never promote it).
  const panel = sliceFunction(componentSource, "RelationshipDealsPanel");
  assert.ok(panel.includes("{unconfirmed && ("), "the deals panel keeps an unconfirmed marker");
});

// 3 -------------------------------------------------------------------------

test("not-linked says commercial activity unknown, never zero, and never queries HubSpot", () => {
  assert.equal(NOT_LINKED_TITLE, "HubSpot not linked");
  assert.equal(COMMERCIAL_UNKNOWN, "Commercial activity unknown");
  assert.doesNotMatch(`${NOT_LINKED_TITLE} ${COMMERCIAL_UNKNOWN}`, ZERO_WORDING);
  const row = sliceFunction(componentSource, "RelationshipRow");
  const notLinkedBranch = row.slice(row.indexOf("!== 'linked'"), row.indexOf("return (\n    <li data-testid"));
  assert.ok(notLinkedBranch.includes("{NOT_LINKED_TITLE} · {COMMERCIAL_UNKNOWN}"));
  assert.ok(!notLinkedBranch.includes("RelationshipDealsPanel"), "a not-linked partner never mounts the deals panel");
  assert.deepEqual(classifyDealSet(response({ hubspot: { availability: "not_linked", message: "" }, association: null, deals: null })), { kind: "not_linked" });
});

// 4 -------------------------------------------------------------------------

test("deals load lazily: only the panel fetches, and it mounts only while its partner is open", () => {
  const root = sliceFunction(componentSource, "PamCommercialWorkspace");
  assert.ok(!root.includes("useGetPamCommercialRelationshipDeals"), "the tab must not fetch deals on open");
  assert.ok(!sliceFunction(componentSource, "RelationshipRow").includes("useGetPamCommercialRelationshipDeals"));
  assert.ok(sliceFunction(componentSource, "RelationshipDealsPanel").includes("useGetPamCommercialRelationshipDeals(relationshipId"));
  assert.ok(componentSource.includes("{open && <RelationshipDealsPanel"), "panel is mounted only when opened");
  assert.equal(componentSource.match(/useGetPamCommercialRelationshipDeals\(/g)?.length, 1);
});

// 5 + 6 ---------------------------------------------------------------------

test("an available, empty, non-truncated deal set is the only real zero", () => {
  assert.deepEqual(classifyDealSet(response({})), { kind: "proven_zero" });
  assert.equal(PROVEN_ZERO_COPY, "No deals currently associated with this HubSpot company");
});

test("HubSpot unavailable never renders zero deals", () => {
  const unavailable = [
    "not_configured",
    "credential_error",
    "authentication_failed",
    "permission_denied",
    "rate_limited",
    "timeout",
    "provider_error",
    "hubspot_company_not_found",
    "invalid_hubspot_company_id",
  ] as const;
  for (const availability of unavailable) {
    const view = classifyDealSet(response({ hubspot: { availability, message: "" }, association: null, deals: null }));
    assert.deepEqual(view, { kind: "unavailable", availability });
    assert.doesNotMatch(availabilityTitle(availability), ZERO_WORDING);
  }
  // Even a malformed "available" without a deal array stays unknown.
  assert.equal(classifyDealSet(response({ deals: null })).kind, "unavailable");
  const panel = sliceFunction(componentSource, "RelationshipDealsPanel");
  assert.ok(panel.includes("isError || !data"), "a failed request renders its own unknown state");
});

// 7 -------------------------------------------------------------------------

test("current deal facts render: name, amount+currency, pipeline, stage, state, close, CRM owner, last modified", () => {
  const row = sliceFunction(componentSource, "DealRow");
  for (const needle of ["f.deal_name", "formatDealAmount(f.amount, f.currency)", "formatIdLabel(f.pipeline)", "formatIdLabel(f.stage)", "dealStateLabel(f.deal_state)", "formatDealDate(f.close_date)", "formatCrmOwner(f.crm_owner)", "formatDealDate(f.last_modified_at)"]) {
    assert.ok(row.includes(needle), `expected DealRow to render ${needle}`);
  }
  assert.equal(formatDealAmount("12500", "EUR"), "€12,500.00");
  assert.equal(formatDealAmount("12500.5", "usd"), "$12,500.50");
  assert.equal(formatDealAmount(null, "EUR"), null);
  assert.equal(formatDealDate("2026-11-30T00:00:00.000Z"), "Nov 30, 2026");
});

test("deal states are labelled verbatim -- unknown and outcome-unknown are never lost", () => {
  assert.equal(dealStateLabel("open"), "Open");
  assert.equal(dealStateLabel("closed_won"), "Closed won");
  assert.equal(dealStateLabel("closed_lost"), "Closed lost");
  assert.doesNotMatch(dealStateLabel("unknown"), /lost/i);
  assert.doesNotMatch(dealStateLabel("closed_outcome_unknown"), /lost/i);
});

// 8 -------------------------------------------------------------------------

test("CRM owner is labelled distinctly from the PAM and never invents a person", () => {
  assert.equal(CRM_OWNER_LABEL, "CRM owner");
  assert.doesNotMatch(componentSource, /label="(PAM|Partner Manager|Owner)"/);
  assert.equal(formatCrmOwner(facts().crm_owner), "Dana Rep");
  const unresolved = formatCrmOwner({ owner_id: "77", resolution: "unavailable", first_name: null, last_name: null, email: null, archived: null });
  assert.equal(unresolved, `${OWNER_DETAILS_UNAVAILABLE} (ID 77)`);
});

// 9 -------------------------------------------------------------------------

test("pipeline/stage metadata failure preserves the raw HubSpot IDs", () => {
  assert.equal(formatIdLabel({ id: "123456", label: null }), "123456 (label unavailable)");
  assert.equal(formatIdLabel({ id: "123456", label: "Proposal" }), "Proposal");
  assert.equal(formatIdLabel({ id: null, label: null }), "Not set");
});

// 10 ------------------------------------------------------------------------

test("an unavailable deal stays visible with its ID, alongside loaded siblings", () => {
  const view = classifyDealSet(
    response({
      association: { returned_count: 2, truncated: false },
      deals: [deal("1"), deal("2", { load_status: "unavailable", error: "timeout", facts: null })],
    }),
  );
  assert.equal(view.kind, "deals");
  assert.equal(view.kind === "deals" && view.deals.length, 2);
  const row = sliceFunction(componentSource, "DealRow");
  assert.ok(row.includes("{DEAL_UNAVAILABLE_TITLE}"));
  assert.ok(row.includes("HubSpot deal ID {deal.deal_id}"));
});

// 11 ------------------------------------------------------------------------

test("truncation says more may exist and uses returned_count, never a total", () => {
  const view = classifyDealSet(response({ association: { returned_count: 50, truncated: true }, deals: Array.from({ length: 50 }, (_, i) => deal(String(i))) }));
  assert.deepEqual(view.kind === "deals" && [view.returnedCount, view.truncated], [50, true]);
  assert.equal(truncationNotice(50), "Showing 50 associated deals. More may exist in HubSpot.");
  assert.doesNotMatch(truncationNotice(50), /total|of \d/i);
  // A truncated response is never a proven zero.
  assert.equal(classifyDealSet(response({ association: { returned_count: 0, truncated: true }, deals: [] })).kind, "deals");
});

// 12 + no interpretation ------------------------------------------------------

test("no history/timeline UI and no interpretive signals are introduced", () => {
  for (const forbidden of ["property_history", "history", "timeline", "Timeline"]) {
    assert.ok(!componentSource.includes(forbidden), `Commercial tab must not reference "${forbidden}" yet (Slice D)`);
  }
  for (const forbidden of [/\bhot\b/i, /\bcold\b/i, /momentum/i, /propensity/i, /likely to close/i, /next best action/i, /engagement score/i, /\brisk\b/i]) {
    assert.doesNotMatch(componentSource, forbidden);
  }
});

// Integration ---------------------------------------------------------------

test("Commercial is a tab of the existing PAM workspace, scoped by the existing drill-down pamUserId", () => {
  assert.ok(workspaceSource.includes('<TabsTrigger value="commercial" data-testid="tab-workspace-commercial">Commercial</TabsTrigger>'));
  assert.ok(workspaceSource.includes("<PamCommercialWorkspace pamUserId={pamUserId} pamName={pamName} />"));
  assert.ok(componentSource.includes("const params = pamUserId ? { pam_user_id: pamUserId } : {};"));
});
