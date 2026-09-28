// PAM Commercial Workspace v1 (Slice B): DB-free tests for the commercial
// deal read path and its authorization helpers. HubSpot is exercised
// through the real Slice A primitives (services/hubspot.ts) over a mocked
// global fetch -- no live HubSpot. The access token and the DRUID
// opportunity lookup are injected, so no database is touched (the
// placeholder DATABASE_URL only satisfies @workspace/db's import-time check).
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder \
//     tsx --test tests/pamCommercialService.test.ts
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PartnerOpportunity } from "@workspace/db";
import { ForbiddenScopeError, type ActingUser } from "../src/services/authz";
import { SecretDecryptionError } from "../src/services/encryption";
import {
  getDealWithHistory,
  getOwner,
  listCompanyDealAssociations,
  listDealPipelines,
} from "../src/services/hubspot";
import {
  assertCommercialRelationshipAccess,
  isCommercialWorkspaceStatus,
  isConfirmedPartnerStatus,
  PamSelectionRequiredError,
  readRelationshipDeals,
  resolveCommercialWorkspaceUserId,
  type CommercialDealsDependencies,
  type CommercialRelationship,
  type DruidOpportunityRow,
} from "../src/services/pamCommercialService";

// ---- Fixtures -----------------------------------------------------------------

const TOKEN = "hubspot-secret-token-that-must-not-leak";
const PAM_A = "00000000-0000-4000-8000-00000000000a";
const PAM_B = "00000000-0000-4000-8000-00000000000b";
const HEAD = "00000000-0000-4000-8000-0000000000ff";
const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";
const HUBSPOT_COMPANY_ID = "9001";

function actingUser(id: string, role: "pam" | "head_of_channels" | "admin"): ActingUser {
  return { id, role, name: `User ${id}`, email: `${id}@example.test`, active: true } as ActingUser;
}

const pamA = actingUser(PAM_A, "pam");
const head = actingUser(HEAD, "head_of_channels");

function relationship(overrides: Partial<CommercialRelationship> = {}): CommercialRelationship {
  return {
    relationship_id: "00000000-0000-4000-8000-0000000000r1",
    company_id: COMPANY_ID,
    company_name: "Partner Co",
    company_domain: "partner.example",
    territory_id: "00000000-0000-4000-8000-0000000000t1",
    territory_name: "Territory",
    status: "active",
    confirmed_partner: true,
    assigned_user_id: PAM_A,
    hubspot_company_id: HUBSPOT_COMPANY_ID,
    hubspot_link_status: "linked",
    ...overrides,
  };
}

function druidRow(overrides: Partial<PartnerOpportunity>): DruidOpportunityRow {
  return {
    opportunity: {
      id: "opp-1",
      name: "DRUID Opp",
      companyId: COMPANY_ID,
      territoryId: "00000000-0000-4000-8000-0000000000t1",
      assignedUserId: PAM_A,
      attributionType: "partner_sourced",
      status: "open",
      dealValue: "1000",
      currency: "USD",
      opportunityDate: "2026-07-01",
      expectedCloseDate: null,
      closedAt: null,
      creditValue: null,
      creditDate: null,
      customerName: null,
      note: null,
      sourceSystem: "hubspot",
      externalId: "101",
      sourceUpdatedAt: null,
      lastSyncedAt: null,
      createdByUserId: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
      ...overrides,
    },
    companyName: "Partner Co",
    assignedUserName: "PAM A",
  };
}

// ---- Mocked HubSpot transport -------------------------------------------------

interface FetchCall {
  method: string;
  url: string;
}

type Handler = (url: URL) => { status: number; body: unknown };

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
});

function mockHubSpot(handlers: Array<[RegExp, Handler]>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", url: url.toString() });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(url.pathname)) {
        const { status, body } = handler(url);
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ message: "unmocked" }), { status: 500 });
  }) as typeof fetch;
}

function companyAssociations(rows: Array<{ id: string; type?: string }>): Handler {
  return () => ({ status: 200, body: { id: HUBSPOT_COMPANY_ID, associations: { deals: { results: rows } } } });
}

interface DealSpec {
  name?: string;
  pipeline?: string;
  stage?: string;
  owner?: string | null;
  closed?: string;
  won?: string;
  lost?: string;
  companies?: string[];
  stageHistory?: Array<{ value: string; timestamp: string }>;
}

function dealBody(id: string, spec: DealSpec = {}) {
  return {
    id,
    properties: {
      dealname: spec.name ?? `Deal ${id}`,
      amount: "5000",
      deal_currency_code: "EUR",
      pipeline: spec.pipeline ?? "default",
      dealstage: spec.stage ?? "qualified",
      closedate: "2026-12-31T00:00:00.000Z",
      createdate: "2026-01-15T10:00:00.000Z",
      hs_is_closed: spec.closed ?? "false",
      hs_is_closed_won: spec.won ?? "false",
      hs_is_closed_lost: spec.lost ?? "false",
      hubspot_owner_id: spec.owner === undefined ? "77" : spec.owner,
      hs_lastmodifieddate: "2026-09-01T00:00:00.000Z",
    },
    propertiesWithHistory: {
      dealstage: (spec.stageHistory ?? [{ value: spec.stage ?? "qualified", timestamp: "2026-01-15T10:00:00.000Z" }]).map((h) => ({
        value: h.value,
        timestamp: h.timestamp,
        sourceType: "CRM_UI",
      })),
    },
    associations: {
      companies: { results: (spec.companies ?? [HUBSPOT_COMPANY_ID]).map((c) => ({ id: c, type: "deal_to_company" })) },
    },
  };
}

function deals(specs: Record<string, DealSpec>): Handler {
  return (url) => {
    const id = url.pathname.split("/").pop()!;
    const spec = specs[id];
    return spec ? { status: 200, body: dealBody(id, spec) } : { status: 404, body: {} };
  };
}

// Two pipelines deliberately share the stage ID "closedwon" with different
// labels, so a correct label proves per-pipeline resolution.
const pipelinesOk: Handler = () => ({
  status: 200,
  body: {
    results: [
      {
        id: "default",
        label: "Sales",
        displayOrder: 0,
        stages: [
          { id: "qualified", label: "Qualified", displayOrder: 0, metadata: { isClosed: "false", probability: "0.2" } },
          { id: "closedwon", label: "Won (Sales)", displayOrder: 1, metadata: { isClosed: "true", probability: "1.0" } },
        ],
      },
      {
        id: "partners",
        label: "Partner Pipeline",
        displayOrder: 1,
        stages: [{ id: "closedwon", label: "Won (Partners)", displayOrder: 0, metadata: { isClosed: "true", probability: "1.0" } }],
      },
    ],
  },
});

const ownerOk: Handler = (url) => ({
  status: 200,
  body: { id: url.pathname.split("/").pop(), firstName: "Casey", lastName: "Crm", email: "casey@crm.example", archived: false },
});

const COMPANY_PATH = /^\/crm\/v3\/objects\/companies\/\d+$/;
const DEAL_PATH = /^\/crm\/v3\/objects\/deals\/\d+$/;
const PIPELINES_PATH = /^\/crm\/v3\/pipelines\/deals$/;
const OWNER_PATH = /^\/crm\/v3\/owners\/\d+$/;

function deps(overrides: Partial<CommercialDealsDependencies> & { druidRows?: DruidOpportunityRow[] } = {}): CommercialDealsDependencies & {
  tokenRequests: number;
  druidLookups: string[][];
} {
  const state = { tokenRequests: 0, druidLookups: [] as string[][] };
  const { druidRows = [], ...rest } = overrides;
  return Object.assign(state, {
    resolveAccessToken: async () => {
      state.tokenRequests++;
      return TOKEN;
    },
    listCompanyDealAssociations,
    getDealWithHistory,
    listDealPipelines,
    getOwner,
    loadDruidOpportunitiesByDealIds: async (ids: readonly string[]) => {
      state.druidLookups.push([...ids]);
      return druidRows.filter((r) => r.opportunity.externalId !== null && ids.includes(r.opportunity.externalId));
    },
    ...rest,
  });
}

// ---- Authorization / eligibility ----------------------------------------------

test("normal PAM cannot request another PAM's workspace; own or omitted resolves to self", () => {
  assert.throws(() => resolveCommercialWorkspaceUserId(pamA, PAM_B), ForbiddenScopeError);
  assert.equal(resolveCommercialWorkspaceUserId(pamA, PAM_A), PAM_A);
  assert.equal(resolveCommercialWorkspaceUserId(pamA, undefined), PAM_A);
  assert.equal(resolveCommercialWorkspaceUserId(pamA, null), PAM_A);
});

test("global roles may select any PAM (existing GLOBAL_ROLES) and must select one explicitly", () => {
  assert.equal(resolveCommercialWorkspaceUserId(head, PAM_B), PAM_B);
  assert.equal(resolveCommercialWorkspaceUserId(actingUser(HEAD, "admin"), PAM_A), PAM_A);
  assert.throws(() => resolveCommercialWorkspaceUserId(head, undefined), PamSelectionRequiredError);
  assert.throws(() => resolveCommercialWorkspaceUserId(actingUser(HEAD, "admin"), "  "), PamSelectionRequiredError);
});

test("relationship access is canonical assignment, not territory", () => {
  assert.doesNotThrow(() => assertCommercialRelationshipAccess(pamA, { assignedUserId: PAM_A }));
  assert.throws(() => assertCommercialRelationshipAccess(pamA, { assignedUserId: PAM_B }), ForbiddenScopeError);
  assert.throws(() => assertCommercialRelationshipAccess(pamA, { assignedUserId: null }), ForbiddenScopeError);
  assert.doesNotThrow(() => assertCommercialRelationshipAccess(head, { assignedUserId: PAM_B }));
});

test("active/dormant are confirmed; needs_review is eligible but not confirmed; closed is excluded", () => {
  assert.equal(isConfirmedPartnerStatus("active"), true);
  assert.equal(isConfirmedPartnerStatus("dormant"), true);
  assert.equal(isConfirmedPartnerStatus("needs_review"), false);
  assert.equal(isCommercialWorkspaceStatus("needs_review"), true);
  assert.equal(isCommercialWorkspaceStatus("closed"), false);
});

// ---- Unknown vs zero ----------------------------------------------------------

test("no hubspot_company_id: not_linked, deals unknown (null), no token or HubSpot request", async () => {
  mockHubSpot([]);
  const d = deps();
  const result = await readRelationshipDeals(relationship({ hubspot_company_id: null, hubspot_link_status: "not_linked" }), pamA, d);
  assert.equal(result.hubspot.availability, "not_linked");
  assert.equal(result.deals, null);
  assert.equal(result.association, null);
  assert.equal(d.tokenRequests, 0);
  assert.equal(calls.length, 0);
});

test("successful company lookup with no associations is a known zero", async () => {
  mockHubSpot([[COMPANY_PATH, companyAssociations([])]]);
  const result = await readRelationshipDeals(relationship(), pamA, deps());
  assert.equal(result.hubspot.availability, "available");
  assert.deepEqual(result.deals, []);
  assert.deepEqual(result.association, { returned_count: 0, truncated: false });
  assert.equal(result.pipeline_metadata, "not_requested");
  assert.equal(calls.length, 1);
});

test("integration unavailability maps to safe states and never reports zero", async (t) => {
  await t.test("not configured", async () => {
    mockHubSpot([]);
    const result = await readRelationshipDeals(relationship(), pamA, deps({ resolveAccessToken: async () => null }));
    assert.equal(result.hubspot.availability, "not_configured");
    assert.equal(result.deals, null);
    assert.equal(calls.length, 0);
  });

  await t.test("credential decryption failure", async () => {
    mockHubSpot([]);
    const result = await readRelationshipDeals(
      relationship(),
      pamA,
      deps({
        resolveAccessToken: async () => {
          throw new SecretDecryptionError();
        },
      }),
    );
    assert.equal(result.hubspot.availability, "credential_error");
    assert.equal(result.deals, null);
  });

  for (const [status, availability] of [
    [401, "authentication_failed"],
    [403, "permission_denied"],
    [429, "rate_limited"],
    [500, "provider_error"],
    [404, "hubspot_company_not_found"],
  ] as const) {
    await t.test(`HTTP ${status}`, async () => {
      mockHubSpot([[COMPANY_PATH, () => ({ status, body: { message: `echo ${TOKEN}` } })]]);
      const result = await readRelationshipDeals(relationship(), pamA, deps());
      assert.equal(result.hubspot.availability, availability);
      assert.equal(result.deals, null);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
    });
  }

  await t.test("non-numeric stored HubSpot company ID", async () => {
    mockHubSpot([]);
    const result = await readRelationshipDeals(relationship({ hubspot_company_id: "not-a-number" }), pamA, deps());
    assert.equal(result.hubspot.availability, "invalid_hubspot_company_id");
    assert.equal(calls.length, 0);
  });
});

// ---- Deal membership ----------------------------------------------------------

test("live HubSpot associations define membership; DRUID-only deal IDs are never added and HubSpot-only deals appear", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101", type: "company_to_deal" }, { id: "102", type: "company_to_deal" }, { id: "103" }])],
    [DEAL_PATH, deals({ "101": {}, "102": {}, "103": {} })],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const d = deps({ druidRows: [druidRow({ id: "opp-101", externalId: "101" }), druidRow({ id: "opp-999", externalId: "999" })] });
  const result = await readRelationshipDeals(relationship(), pamA, d);

  assert.deepEqual(result.deals!.map((deal) => deal.deal_id), ["101", "102", "103"]);
  assert.deepEqual(d.druidLookups, [["101", "102", "103"]]);
  assert.equal(result.deals!.some((deal) => deal.deal_id === "999"), false);
  assert.equal(result.deals![0]!.druid_opportunities.match_status, "matched");
  for (const deal of result.deals!.slice(1)) {
    assert.equal(deal.load_status, "loaded");
    assert.equal(deal.druid_opportunities.match_status, "no_match");
    assert.deepEqual(deal.druid_opportunities.records, []);
  }
});

test("duplicate association rows remain one deal with merged association-type evidence", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101", type: "company_to_deal" }, { id: "101", type: "company_to_deal_unlabeled" }, { id: "101", type: "company_to_deal" }])],
    [DEAL_PATH, deals({ "101": {} })],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const result = await readRelationshipDeals(relationship(), pamA, deps());
  assert.equal(result.deals!.length, 1);
  assert.equal(result.association!.returned_count, 1);
  assert.deepEqual(result.deals![0]!.association_types, ["company_to_deal", "company_to_deal_unlabeled"]);
  assert.equal(calls.filter((c) => DEAL_PATH.test(new URL(c.url).pathname)).length, 1);
});

test("multi-company deals are kept, with every associated company listed and no primary invented", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }])],
    [DEAL_PATH, deals({ "101": { companies: ["5555", HUBSPOT_COMPANY_ID] } })],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const result = await readRelationshipDeals(relationship(), pamA, deps());
  const facts = result.deals![0]!.facts!;
  assert.deepEqual(
    facts.associated_companies.map((c) => c.hubspot_company_id),
    ["5555", HUBSPOT_COMPANY_ID],
  );
  assert.equal("primary_company" in facts, false);
});

test("truncated associations expose returned_count/truncated and no invented total", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ id: String(1000 + i), type: "company_to_deal" }));
  const specs = Object.fromEntries(rows.map((r) => [r.id, {}]));
  mockHubSpot([
    [COMPANY_PATH, companyAssociations(rows)],
    [DEAL_PATH, deals(specs)],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const result = await readRelationshipDeals(relationship(), pamA, deps());
  assert.deepEqual(result.association, { returned_count: 50, truncated: true });
  assert.equal(result.deals!.length, 50);
  assert.equal("total" in result.association!, false);
  assert.equal("total_count" in result, false);
});

// ---- Deal facts ---------------------------------------------------------------

test("deal facts use Slice A state and per-pipeline stage labels", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }, { id: "102" }, { id: "103" }])],
    [
      DEAL_PATH,
      deals({
        "101": { pipeline: "partners", stage: "closedwon", closed: "true", won: "true" },
        "102": { pipeline: "default", stage: "closedwon", closed: "true", won: "false", lost: "false" },
        "103": { pipeline: "default", stage: "qualified", closed: "false", won: "false" },
      }),
    ],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const result = await readRelationshipDeals(relationship(), pamA, deps());
  const [won, unknownOutcome, open] = result.deals!.map((d) => d.facts!);

  assert.equal(result.pipeline_metadata, "available");
  assert.deepEqual(won!.pipeline, { id: "partners", label: "Partner Pipeline" });
  assert.deepEqual(won!.stage, { id: "closedwon", label: "Won (Partners)" });
  assert.equal(won!.deal_state, "closed_won");
  // Closed with won=false and no explicit lost flag is NOT inferred as lost.
  assert.deepEqual(unknownOutcome!.stage, { id: "closedwon", label: "Won (Sales)" });
  assert.equal(unknownOutcome!.deal_state, "closed_outcome_unknown");
  assert.equal(open!.deal_state, "open");
  assert.equal(open!.amount, "5000");
  assert.equal(open!.currency, "EUR");
  assert.equal(open!.close_date, "2026-12-31T00:00:00.000Z");
  assert.equal(open!.create_date, "2026-01-15T10:00:00.000Z");
  assert.equal(open!.last_modified_at, "2026-09-01T00:00:00.000Z");
});

test("property history is the normalized factual event list", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }])],
    [
      DEAL_PATH,
      deals({
        "101": {
          stageHistory: [
            { value: "closedwon", timestamp: "2026-03-01T00:00:00.000Z" },
            { value: "qualified", timestamp: "2026-01-01T00:00:00.000Z" },
          ],
        },
      }),
    ],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const result = await readRelationshipDeals(relationship(), pamA, deps());
  const history = result.deals![0]!.facts!.property_history;
  assert.deepEqual(
    history.map((e) => [e.property, e.kind, e.previous_value, e.new_value, e.changed_at]),
    [
      ["dealstage", "initial", null, "qualified", "2026-01-01T00:00:00.000Z"],
      ["dealstage", "changed", "qualified", "closedwon", "2026-03-01T00:00:00.000Z"],
    ],
  );
  for (const event of history) assert.deepEqual(Object.keys(event).sort(), ["changed_at", "kind", "new_label", "new_value", "previous_label", "previous_value", "property", "source_type"]);
});

test("pipeline metadata failure preserves raw pipeline/stage IDs and deal facts", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }])],
    [DEAL_PATH, deals({ "101": { pipeline: "partners", stage: "closedwon", closed: "true", won: "true" } })],
    [PIPELINES_PATH, () => ({ status: 500, body: {} })],
    [OWNER_PATH, ownerOk],
  ]);
  const result = await readRelationshipDeals(relationship(), pamA, deps());
  const facts = result.deals![0]!.facts!;
  assert.equal(result.pipeline_metadata, "unavailable");
  assert.equal(result.deals![0]!.load_status, "loaded");
  assert.deepEqual(facts.pipeline, { id: "partners", label: null });
  assert.deepEqual(facts.stage, { id: "closedwon", label: null });
  assert.equal(facts.deal_state, "closed_won");
  assert.equal(facts.deal_name, "Deal 101");
});

// ---- CRM owner ----------------------------------------------------------------

test("CRM owner stays distinct from PAM ownership, and unique owners are requested once", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }, { id: "102" }, { id: "103" }])],
    [DEAL_PATH, deals({ "101": { owner: "77" }, "102": { owner: "77" }, "103": { owner: null } })],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const rel = relationship();
  const result = await readRelationshipDeals(rel, pamA, deps());

  assert.equal(result.relationship.assigned_user_id, PAM_A);
  const owner = result.deals![0]!.facts!.crm_owner!;
  assert.equal(owner.owner_id, "77");
  assert.equal(owner.resolution, "resolved");
  assert.equal(owner.email, "casey@crm.example");
  assert.notEqual(owner.owner_id, rel.assigned_user_id);
  assert.equal(result.deals![2]!.facts!.crm_owner, null);
  assert.equal(calls.filter((c) => OWNER_PATH.test(new URL(c.url).pathname)).length, 1);
});

test("owner resolution failure preserves the raw owner ID", async (t) => {
  await t.test("provider failure -> unavailable", async () => {
    mockHubSpot([
      [COMPANY_PATH, companyAssociations([{ id: "101" }])],
      [DEAL_PATH, deals({ "101": { owner: "77" } })],
      [PIPELINES_PATH, pipelinesOk],
      [OWNER_PATH, () => ({ status: 500, body: {} })],
    ]);
    const result = await readRelationshipDeals(relationship(), pamA, deps());
    assert.deepEqual(result.deals![0]!.facts!.crm_owner, {
      owner_id: "77",
      resolution: "unavailable",
      first_name: null,
      last_name: null,
      email: null,
      archived: null,
    });
    assert.equal(result.deals![0]!.load_status, "loaded");
  });

  await t.test("active and archived both 404 -> not_found", async () => {
    mockHubSpot([
      [COMPANY_PATH, companyAssociations([{ id: "101" }])],
      [DEAL_PATH, deals({ "101": { owner: "77" } })],
      [PIPELINES_PATH, pipelinesOk],
      [OWNER_PATH, () => ({ status: 404, body: {} })],
    ]);
    const result = await readRelationshipDeals(relationship(), pamA, deps());
    assert.equal(result.deals![0]!.facts!.crm_owner!.owner_id, "77");
    assert.equal(result.deals![0]!.facts!.crm_owner!.resolution, "not_found");
    const ownerUrls = calls.filter((c) => OWNER_PATH.test(new URL(c.url).pathname)).map((c) => new URL(c.url).searchParams.get("archived"));
    assert.deepEqual(ownerUrls, ["false", "true"]);
  });
});

// ---- Partial failure ----------------------------------------------------------

test("an individual deal failure keeps its ID and does not erase the other deals", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }, { id: "102" }, { id: "103" }])],
    [
      DEAL_PATH,
      (url) => (url.pathname.endsWith("/102") ? { status: 500, body: {} } : { status: 200, body: dealBody(url.pathname.split("/").pop()!) }),
    ],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const result = await readRelationshipDeals(relationship(), pamA, deps({ druidRows: [druidRow({ externalId: "102" })] }));
  assert.equal(result.hubspot.availability, "available");
  assert.deepEqual(
    result.deals!.map((d) => [d.deal_id, d.load_status, d.error]),
    [
      ["101", "loaded", null],
      ["102", "unavailable", "provider_error"],
      ["103", "loaded", null],
    ],
  );
  assert.equal(result.deals![1]!.facts, null);
  // DRUID enrichment is keyed by deal ID, so it is still shown for the failed read.
  assert.equal(result.deals![1]!.druid_opportunities.match_status, "matched");
});

// ---- DRUID enrichment ---------------------------------------------------------

// The source_system=hubspot restriction lives in the DB query and is covered
// by tests/pamCommercialWorkspace.test.ts; these rows model what it returns.
test("DRUID enrichment matches deal IDs only and records outside the viewer's scope are absent without a trace", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }, { id: "102" }])],
    [DEAL_PATH, deals({ "101": {}, "102": {} })],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  const rows = [
    druidRow({ id: "opp-own", externalId: "101", companyId: "other-company" }),
    druidRow({ id: "opp-other-pam", externalId: "102", assignedUserId: PAM_B }),
  ];

  const asPam = await readRelationshipDeals(relationship(), pamA, deps({ druidRows: rows }));
  const deal101 = asPam.deals![0]!.druid_opportunities;
  assert.equal(deal101.match_status, "matched");
  assert.deepEqual(deal101.records.map((r) => [r.opportunity_id, r.source_system, r.same_company_as_relationship]), [
    ["opp-own", "hubspot", false],
  ]);
  assert.equal(deal101.records[0]!.deal_value, 1000);
  // Another PAM's record: indistinguishable from no record at all.
  const deal102 = asPam.deals![1]!.druid_opportunities;
  assert.deepEqual(deal102, { match_status: "no_match", records: [] });
  assert.equal(JSON.stringify(asPam).includes("opp-other-pam"), false);
  assert.equal(JSON.stringify(asPam).includes("restricted"), false);

  const asHead = await readRelationshipDeals(relationship(), head, deps({ druidRows: rows }));
  assert.equal(asHead.deals![1]!.druid_opportunities.match_status, "matched");
  assert.deepEqual(asHead.deals![1]!.druid_opportunities.records.map((r) => r.opportunity_id), ["opp-other-pam"]);
});

// ---- Request discipline -------------------------------------------------------

test("every HubSpot request is a GET to api.hubapi.com (no writes, no other providers)", async () => {
  mockHubSpot([
    [COMPANY_PATH, companyAssociations([{ id: "101" }, { id: "102" }])],
    [DEAL_PATH, deals({ "101": { owner: "77" }, "102": { owner: "78" } })],
    [PIPELINES_PATH, pipelinesOk],
    [OWNER_PATH, ownerOk],
  ]);
  await readRelationshipDeals(relationship(), pamA, deps());
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.method, "GET", `unexpected ${call.method} ${call.url}`);
    assert.equal(new URL(call.url).origin, "https://api.hubapi.com");
  }
});

test("the commercial service and route import no AI provider", () => {
  for (const file of ["../src/services/pamCommercialService.ts", "../src/routes/pam_commercial.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /discoveryProviders\/ai|aiChannelBrief|pamCopilot|anthropic|openai|deepseek/i, file);
    assert.doesNotMatch(source, /method:\s*"(POST|PATCH|PUT|DELETE)"/, file);
  }
});
