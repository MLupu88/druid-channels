// Phase 6: route-level authz/behavior regression tests for the marketing
// activities (campaigns) endpoints, including the new opportunity-linkage
// surface (POST /campaigns opportunity_ids, PATCH /campaigns/:id
// opportunity_ids, PUT /campaigns/:id/opportunities) and commercial-impact
// derivation. Same pattern as tests/opportunitiesAuthz.test.ts: run against
// a live dev server backed by a real (disposable) Postgres.
//
//   DATABASE_URL=... SEED_PASSWORD_IRINA=... SEED_PASSWORD_DENNY=... SEED_PASSWORD_JAMES=... \
//     BASE_URL=http://localhost:8080/api tsx --test tests/campaignsAuthz.test.ts
//
// NOT executed in this sandbox: the dev machine's default Docker context
// runs the live production stack (druid-channels-db/api/web), and the user
// has explicitly asked that no container be started/stopped/removed here
// until a truly isolated local Docker/Postgres environment is established.
// This file is written and ready to run once that environment exists --
// verify it there before relying on it as passing.
//
// No Tavily/DeepSeek/HubSpot/live-FX calls: every fixture uses currency
// "USD" only, so commercial-impact assertions never depend on a live FX
// fetch (services/fx.ts short-circuits USD->USD at rate 1, no network call).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, companiesTable, campaignsTable, campaignOpportunitiesTable, partnerOpportunitiesTable } from "@workspace/db";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";

const CREDENTIALS = {
  irina: { email: "irina.dochitu@druidai.com", password: process.env.SEED_PASSWORD_IRINA, envVar: "SEED_PASSWORD_IRINA" }, // head_of_channels
  denny: { email: "denny.morais@druidai.com", password: process.env.SEED_PASSWORD_DENNY, envVar: "SEED_PASSWORD_DENNY" }, // PAM A
  james: { email: "james.bradley@druidai.com", password: process.env.SEED_PASSWORD_JAMES, envVar: "SEED_PASSWORD_JAMES" }, // PAM B
};

const missingEnvVars = Object.values(CREDENTIALS)
  .filter((c) => !c.password || c.password.trim() === "")
  .map((c) => c.envVar);
if (missingEnvVars.length > 0) {
  throw new Error(`Missing required seed password environment variable(s): ${missingEnvVars.join(", ")}. Set these to the same values used when seeding the database.`);
}

const tokens: Record<string, string> = {};
let dennyId = "";
let jamesId = "";
let dennyTerritoryName = "";
let jamesTerritoryName = "";
let companyId = "";
let otherCompanyId = "";
const createdCompanyIds: string[] = [];
const createdCampaignIds: string[] = [];
const createdOpportunityIds: string[] = [];

async function login(email: string, password: string) {
  const res = await fetch(`${BASE_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path: string, token?: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function patch(path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function put(path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function del(path: string, token?: string) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function campaignInput(overrides: Record<string, unknown> = {}) {
  return {
    name: `Authz Test Activity ${Date.now()}-${Math.random()}`,
    type: "joint_campaign",
    territory: dennyTerritoryName,
    owner_user_id: dennyId,
    partner_company_id: companyId,
    ...overrides,
  };
}

async function createOpportunity(token: string, overrides: Record<string, unknown> = {}) {
  const { status, body } = await post("/opportunities", token, {
    name: `Authz Test Deal ${Date.now()}-${Math.random()}`,
    company_id: companyId,
    territory_id: undefined, // filled by caller via overrides (needs a real territory_id, resolved below)
    assigned_user_id: dennyId,
    attribution_type: "partner_sourced",
    deal_value: 1000,
    currency: "USD",
    opportunity_date: "2026-07-01",
    ...overrides,
  });
  if (status === 201) createdOpportunityIds.push(body.id);
  return { status, body };
}

before(async () => {
  for (const [key, cred] of Object.entries(CREDENTIALS)) {
    const { status, body } = await login(cred.email, cred.password);
    assert.equal(status, 200, `expected ${key} to log in, got ${status}: ${JSON.stringify(body)}`);
    tokens[key] = body.token;
  }

  dennyId = (await get("/auth/me", tokens.denny)).body.id;
  jamesId = (await get("/auth/me", tokens.james)).body.id;
  assert.ok(dennyId && jamesId, "expected auth/me to resolve both PAM ids");

  const territories = await get("/territories", tokens.irina);
  assert.equal(territories.status, 200);
  const dennyTerritory = territories.body.find((t: any) => t.name === "Portugal, Canada and South America");
  const jamesTerritory = territories.body.find((t: any) => t.name === "UK & Ireland");
  assert.ok(dennyTerritory && jamesTerritory, "expected both seeded territories to exist");
  dennyTerritoryName = dennyTerritory.name;
  jamesTerritoryName = jamesTerritory.name;

  const [company] = await db.insert(companiesTable).values({ name: `Campaigns-Authz-Test-Co-${Date.now()}`, country: "Unknown" }).returning();
  companyId = company!.id;
  createdCompanyIds.push(companyId);

  const [other] = await db.insert(companiesTable).values({ name: `Campaigns-Authz-Test-Other-Co-${Date.now()}`, country: "Unknown" }).returning();
  otherCompanyId = other!.id;
  createdCompanyIds.push(otherCompanyId);
});

after(async () => {
  for (const id of createdCampaignIds) {
    await db.delete(campaignOpportunitiesTable).where(eq(campaignOpportunitiesTable.campaignId, id));
    await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  }
  for (const id of createdOpportunityIds) {
    await db.delete(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  }
  for (const id of createdCompanyIds) {
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
  await pool.end();
});

// ---- Partner required on create -------------------------------------------

test("POST /campaigns: partner_company_id is required for a new activity (400)", async () => {
  const { status, body } = await post("/campaigns", tokens.denny, campaignInput({ partner_company_id: null }));
  assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
});

test("POST /campaigns: PAM can create with a partner, assigned to themselves", async () => {
  const { status, body } = await post("/campaigns", tokens.denny, campaignInput());
  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.owner_user_id, dennyId);
  assert.equal(body.partner_company_id, companyId);
  assert.deepEqual(body.linked_opportunity_ids, []);
  assert.equal(body.linked_opportunity_count, 0);
  assert.equal(body.linked_open_pipeline, null);
  assert.equal(body.linked_closed_revenue, null);
  createdCampaignIds.push(body.id);
});

test("POST /campaigns: PAM cannot create owned by another PAM (403)", async () => {
  const { status } = await post("/campaigns", tokens.denny, campaignInput({ owner_user_id: jamesId }));
  assert.equal(status, 403);
});

// ---- Legacy null-partner rows stay editable --------------------------------

test("PATCH /campaigns/:id: an existing null-partner activity remains fully editable without being forced to add a partner", async () => {
  const [legacy] = await db
    .insert(campaignsTable)
    .values({ name: "Legacy no-partner activity", type: "event", territory: dennyTerritoryName, ownerUserId: dennyId, partnerCompanyId: null })
    .returning();
  createdCampaignIds.push(legacy!.id);

  const { status, body } = await patch(`/campaigns/${legacy!.id}`, tokens.denny, { notes: "still editable" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.partner_company_id, null);
  assert.equal(body.notes, "still editable");
});

// ---- Opportunity linkage: constrained to partner + caller access ----------

test("POST /campaigns: opportunity_ids must belong to the activity's partner (400 if not)", async () => {
  const otherCoOpp = await createOpportunity(tokens.denny, { company_id: otherCompanyId, territory_id: undefined });
  // territory_id is required by CreateOpportunityBody; resolve via a second call using the real id.
  assert.notEqual(otherCoOpp.status, undefined);

  const dennyTerritory = (await get("/territories", tokens.irina)).body.find((t: any) => t.name === dennyTerritoryName);
  const opp = await createOpportunity(tokens.denny, { company_id: otherCompanyId, territory_id: dennyTerritory.id });
  assert.equal(opp.status, 201, JSON.stringify(opp.body));

  const { status, body } = await post("/campaigns", tokens.denny, campaignInput({ opportunity_ids: [opp.body.id] }));
  assert.equal(status, 400, `expected 400 (opportunity belongs to a different company), got ${status}: ${JSON.stringify(body)}`);
});

test("POST /campaigns: PAM cannot link an opportunity assigned to another PAM (403)", async () => {
  const jamesTerritory = (await get("/territories", tokens.irina)).body.find((t: any) => t.name === jamesTerritoryName);
  const jamesOpp = await createOpportunity(tokens.james, { company_id: companyId, territory_id: jamesTerritory.id, assigned_user_id: jamesId });
  assert.equal(jamesOpp.status, 201, JSON.stringify(jamesOpp.body));

  const { status, body } = await post("/campaigns", tokens.denny, campaignInput({ opportunity_ids: [jamesOpp.body.id] }));
  assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body)}`);
});

test("POST /campaigns then PUT /campaigns/:id/opportunities: PAM can link their own matching-partner opportunity, and commercial impact derives from real deal_value/status, never credit_value", async () => {
  const dennyTerritory = (await get("/territories", tokens.irina)).body.find((t: any) => t.name === dennyTerritoryName);

  const openOpp = await createOpportunity(tokens.denny, {
    company_id: companyId,
    territory_id: dennyTerritory.id,
    deal_value: 4000,
    status: "open",
  });
  assert.equal(openOpp.status, 201, JSON.stringify(openOpp.body));

  const wonOpp = await createOpportunity(tokens.denny, {
    company_id: companyId,
    territory_id: dennyTerritory.id,
    deal_value: 6000,
    status: "won",
    closed_at: "2026-07-20T00:00:00.000Z",
    credit_value: 999999, // deliberately absurd -- must NEVER be reflected in linked_closed_revenue
    credit_date: "2027-01-01",
  });
  assert.equal(wonOpp.status, 201, JSON.stringify(wonOpp.body));

  const created = await post("/campaigns", tokens.denny, campaignInput({ opportunity_ids: [openOpp.body.id, wonOpp.body.id] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdCampaignIds.push(created.body.id);

  assert.deepEqual(new Set(created.body.linked_opportunity_ids), new Set([openOpp.body.id, wonOpp.body.id]));
  assert.equal(created.body.linked_opportunity_count, 2);
  assert.equal(created.body.linked_open_pipeline?.amount, 4000, "open pipeline must equal the open opportunity's real deal_value");
  assert.equal(created.body.linked_closed_revenue?.amount, 6000, "closed revenue must equal the won opportunity's real deal_value, never credit_value (999999)");

  // Unlink everything via the dedicated endpoint -- opportunities themselves
  // must be untouched (still open/won with their original deal_value).
  const unlinked = await put(`/campaigns/${created.body.id}/opportunities`, tokens.denny, { opportunity_ids: [] });
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
  assert.equal(unlinked.body.linked_opportunity_count, 0);
  assert.equal(unlinked.body.linked_open_pipeline, null);
  assert.equal(unlinked.body.linked_closed_revenue, null);

  const stillOpen = await get(`/opportunities`, tokens.denny);
  const openRow = stillOpen.body.find((o: any) => o.id === openOpp.body.id);
  assert.equal(openRow.status, "open", "unlinking must never mutate the opportunity's own status");
  assert.equal(openRow.deal_value, 4000, "unlinking must never mutate deal_value");
});

// ---- Visibility: a PAM's commercial-impact view never includes another PAM's opportunity, even if Head links it ----

test("Head/Admin can link an opportunity assigned to a different PAM than the activity's owner, but that PAM's own view excludes it from count/pipeline", async () => {
  const jamesTerritory = (await get("/territories", tokens.irina)).body.find((t: any) => t.name === jamesTerritoryName);
  const jamesOpp = await createOpportunity(tokens.james, { company_id: companyId, territory_id: jamesTerritory.id, assigned_user_id: jamesId, deal_value: 2500, status: "open" });
  assert.equal(jamesOpp.status, 201, JSON.stringify(jamesOpp.body));

  // Head creates an activity owned by Denny but links James's opportunity --
  // global users are unrestricted on which opportunity they may link.
  const created = await post("/campaigns", tokens.irina, campaignInput({ owner_user_id: dennyId, opportunity_ids: [jamesOpp.body.id] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdCampaignIds.push(created.body.id);
  assert.equal(created.body.linked_opportunity_count, 1, "Head's own view sees the link (global, unrestricted)");

  const asDenny = await get(`/campaigns`, tokens.denny);
  const dennysCopy = asDenny.body.find((c: any) => c.id === created.body.id);
  assert.ok(dennysCopy, "Denny must still see the activity itself (he owns it)");
  assert.equal(dennysCopy.linked_opportunity_count, 0, "Denny's view must exclude an opportunity he is not authorized to see, even though it is linked");
  assert.deepEqual(dennysCopy.linked_opportunity_ids, []);
});

// ---- List scoping -----------------------------------------------------------

test("GET /campaigns: PAM sees only their own; Head/Admin sees all and can filter by owner_user_id", async () => {
  const asDenny = await get("/campaigns", tokens.denny);
  assert.equal(asDenny.status, 200);
  assert.ok(asDenny.body.every((c: any) => c.owner_user_id === dennyId), "Denny's list must never include another PAM's activity");

  const asHeadFiltered = await get(`/campaigns?owner_user_id=${dennyId}`, tokens.irina);
  assert.equal(asHeadFiltered.status, 200);
  assert.ok(asHeadFiltered.body.every((c: any) => c.owner_user_id === dennyId), "Head/Admin filtering by owner_user_id must scope the list to that owner");

  const asJamesIgnoresOwnerParam = await get(`/campaigns?owner_user_id=${dennyId}`, tokens.james);
  assert.equal(asJamesIgnoresOwnerParam.status, 200);
  assert.ok(
    asJamesIgnoresOwnerParam.body.every((c: any) => c.owner_user_id === jamesId),
    "a PAM's owner_user_id query param must be ignored, never widening them into another PAM's activities",
  );
});

// ---- Partner-change safety --------------------------------------------------

test("PATCH /campaigns/:id: changing partner_company_id while opportunities are linked is rejected unless the new partner still matches", async () => {
  const dennyTerritory = (await get("/territories", tokens.irina)).body.find((t: any) => t.name === dennyTerritoryName);
  const opp = await createOpportunity(tokens.denny, { company_id: companyId, territory_id: dennyTerritory.id });
  assert.equal(opp.status, 201, JSON.stringify(opp.body));

  const created = await post("/campaigns", tokens.denny, campaignInput({ opportunity_ids: [opp.body.id] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdCampaignIds.push(created.body.id);

  const badChange = await patch(`/campaigns/${created.body.id}`, tokens.denny, { partner_company_id: otherCompanyId });
  assert.equal(badChange.status, 400, `expected 400, got ${badChange.status}: ${JSON.stringify(badChange.body)}`);

  // Same request, but also clearing the link set in the same call -- must succeed.
  const okChange = await patch(`/campaigns/${created.body.id}`, tokens.denny, { partner_company_id: otherCompanyId, opportunity_ids: [] });
  assert.equal(okChange.status, 200, `expected 200, got ${okChange.status}: ${JSON.stringify(okChange.body)}`);
  assert.equal(okChange.body.partner_company_id, otherCompanyId);
  assert.equal(okChange.body.linked_opportunity_count, 0);
});
