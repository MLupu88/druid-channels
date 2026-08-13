// Phase 5A: route-level authz regression tests for the opportunities CRUD
// endpoints and the annual-target write/read endpoints. Run against a live
// dev server backed by a real (disposable) Postgres -- same pattern as
// tests/roleSeparation.test.ts.
//
//   DATABASE_URL=... SEED_PASSWORD_IRINA=... SEED_PASSWORD_DENNY=... SEED_PASSWORD_JAMES=... \
//     BASE_URL=http://localhost:8080/api tsx --test tests/opportunitiesAuthz.test.ts
//
// No Tavily/DeepSeek/HubSpot/live-FX calls: every fixture uses currency
// "USD" only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, companiesTable, partnerOpportunitiesTable } from "@workspace/db";

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
let dennyTerritoryId = "";
let jamesTerritoryId = "";
let companyId = "";
const createdCompanyIds: string[] = [];
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

function opportunityInput(overrides: Record<string, unknown> = {}) {
  return {
    name: `Authz Test Deal ${Date.now()}-${Math.random()}`,
    company_id: companyId,
    territory_id: dennyTerritoryId,
    assigned_user_id: dennyId,
    attribution_type: "partner_sourced",
    deal_value: 1000,
    currency: "USD",
    opportunity_date: "2026-07-01",
    ...overrides,
  };
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
  dennyTerritoryId = dennyTerritory.id;
  jamesTerritoryId = jamesTerritory.id;

  const [company] = await db.insert(companiesTable).values({ name: `Opportunities-Authz-Test-Co-${Date.now()}`, country: "Unknown" }).returning();
  companyId = company!.id;
  createdCompanyIds.push(companyId);
});

after(async () => {
  for (const id of createdOpportunityIds) {
    await db.delete(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  }
  for (const id of createdCompanyIds) {
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
  await pool.end();
});

// ---- Create ------------------------------------------------------------------

test("POST /opportunities: PAM can create an opportunity in their own territory, assigned to themselves", async () => {
  const { status, body } = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.assigned_user_id, dennyId);
  assert.equal(body.territory_id, dennyTerritoryId);
  createdOpportunityIds.push(body.id);
});

test("POST /opportunities: PAM cannot create in another territory (403)", async () => {
  const { status } = await post("/opportunities", tokens.denny, opportunityInput({ territory_id: jamesTerritoryId }));
  assert.equal(status, 403);
});

test("POST /opportunities: PAM cannot create assigned to another PAM (403)", async () => {
  const { status } = await post("/opportunities", tokens.denny, opportunityInput({ assigned_user_id: jamesId }));
  assert.equal(status, 403);
});

test("POST /opportunities: status=won without closed_at is rejected (400)", async () => {
  const { status, body } = await post("/opportunities", tokens.denny, opportunityInput({ status: "won" }));
  assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
});

test("POST /opportunities: status=won with closed_at is accepted", async () => {
  const { status, body } = await post("/opportunities", tokens.denny, opportunityInput({ status: "won", closed_at: "2026-07-15T00:00:00.000Z" }));
  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  createdOpportunityIds.push(body.id);
});

test("POST /opportunities: Head/Admin can create for any valid PAM/territory", async () => {
  const { status, body } = await post("/opportunities", tokens.irina, opportunityInput({ territory_id: jamesTerritoryId, assigned_user_id: jamesId }));
  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.assigned_user_id, jamesId);
  createdOpportunityIds.push(body.id);
});

// Phase 5B-3: the historical-cutover CSV importer relies on
// source_system+external_id uniqueness (see partnerOpportunities.test.ts's
// partner_opportunities_source_external_unique) to make a repeat file
// upload safe. That DB constraint already rejected a duplicate insert
// before this phase; what changed here is the route now catches the 23505
// unique-violation on EXACTLY that constraint (checked structurally via the
// underlying pg DatabaseError's `.constraint` field, not message-text
// matching -- see routes/opportunities.ts's isSourceExternalUniqueViolation)
// and reports it as a clean 409, so the importer can surface it as "already
// imported" instead of a raw 500. This end-to-end test exercises the real
// constraint; the narrowing itself (any OTHER 23505 must rethrow unchanged,
// never get mislabeled as an import duplicate) is unit-tested in isolation
// in tests/opportunitiesImportDuplicateDetection.test.ts, since this table
// has no second live unique constraint to trigger that case against here.
test("POST /opportunities: a repeat source_system+external_id is rejected with 409, not a raw 500", async () => {
  const externalId = `import-dup-${Date.now()}`;
  const first = await post("/opportunities", tokens.irina, opportunityInput({ source_system: "import", external_id: externalId }));
  assert.equal(first.status, 201, `expected 201, got ${first.status}: ${JSON.stringify(first.body)}`);
  createdOpportunityIds.push(first.body.id);

  const second = await post("/opportunities", tokens.irina, opportunityInput({ source_system: "import", external_id: externalId, name: "Different name, same external_id" }));
  assert.equal(second.status, 409, `expected 409, got ${second.status}: ${JSON.stringify(second.body)}`);
  assert.ok(second.body?.error, "expected a clear error message on the 409 response");
});

// ---- Read ----------------------------------------------------------------

test("GET /opportunities/:id: PAM can read their own opportunity", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status, body } = await get(`/opportunities/${created.body.id}`, tokens.denny);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.id, created.body.id);
});

test("GET /opportunities/:id: PAM cannot read another PAM's opportunity (403)", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status } = await get(`/opportunities/${created.body.id}`, tokens.james);
  assert.equal(status, 403);
});

test("GET /opportunities: Head/Admin sees all opportunities; PAM sees only their own", async () => {
  const asHead = await get("/opportunities", tokens.irina);
  assert.equal(asHead.status, 200);
  assert.ok(asHead.body.some((o: any) => o.assigned_user_id === dennyId), "Head/Admin's list must include Denny's opportunities");
  assert.ok(asHead.body.some((o: any) => o.assigned_user_id === jamesId), "Head/Admin's list must include James's opportunities");

  const asDenny = await get("/opportunities", tokens.denny);
  assert.equal(asDenny.status, 200);
  assert.ok(asDenny.body.every((o: any) => o.assigned_user_id === dennyId), "Denny's list must never include another PAM's opportunity");
});

test("GET /opportunities/:id: Head/Admin can read any opportunity", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status } = await get(`/opportunities/${created.body.id}`, tokens.irina);
  assert.equal(status, 200);
});

// ---- Update ----------------------------------------------------------------

test("PATCH /opportunities/:id: PAM can update their own opportunity", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status, body } = await patch(`/opportunities/${created.body.id}`, tokens.denny, { deal_value: 4200, note: "updated by owner" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.deal_value, 4200);
});

test("PATCH /opportunities/:id: PAM cannot update another PAM's opportunity (403)", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status } = await patch(`/opportunities/${created.body.id}`, tokens.james, { deal_value: 1 });
  assert.equal(status, 403);
});

test("PATCH /opportunities/:id: PAM cannot reassign their own opportunity to another PAM (403), and the assignment is left unchanged", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status } = await patch(`/opportunities/${created.body.id}`, tokens.denny, { assigned_user_id: jamesId });
  assert.equal(status, 403);

  const verify = await get(`/opportunities/${created.body.id}`, tokens.denny);
  assert.equal(verify.body.assigned_user_id, dennyId, "assignment must be unchanged after the blocked reassignment attempt");
});

test("PATCH /opportunities/:id: PAM cannot widen their opportunity's territory scope (403)", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status } = await patch(`/opportunities/${created.body.id}`, tokens.denny, { territory_id: jamesTerritoryId });
  assert.equal(status, 403);
});

test("PATCH /opportunities/:id: setting status=won without an existing or provided closed_at is rejected (400)", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status, body } = await patch(`/opportunities/${created.body.id}`, tokens.denny, { status: "won" });
  assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
});

test("PATCH /opportunities/:id: setting status=won together with closed_at in the same request succeeds", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status, body } = await patch(`/opportunities/${created.body.id}`, tokens.denny, { status: "won", closed_at: "2026-07-20T00:00:00.000Z" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, "won");
});

test("PATCH /opportunities/:id: Head/Admin can update any opportunity, including reassigning it to a different PAM", async () => {
  const created = await post("/opportunities", tokens.denny, opportunityInput());
  assert.equal(created.status, 201);
  createdOpportunityIds.push(created.body.id);

  const { status, body } = await patch(`/opportunities/${created.body.id}`, tokens.irina, { assigned_user_id: jamesId, territory_id: jamesTerritoryId });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.assigned_user_id, jamesId);
  assert.equal(body.territory_id, jamesTerritoryId);
});

// ---- Annual target (Head/Admin only) -----------------------------------------

const SANDBOX_YEAR = 2986;

test("PUT /metric-targets/annual: PAM is blocked (403)", async () => {
  const { status } = await put("/metric-targets/annual", tokens.denny, { metric_key: "closed_revenue", year: SANDBOX_YEAR, target_value: 100000 });
  assert.equal(status, 403);
});

test("PUT /metric-targets/annual: Head/Admin can set the company-wide annual target", async () => {
  const { status, body } = await put("/metric-targets/annual", tokens.irina, { metric_key: "closed_revenue", year: SANDBOX_YEAR, target_value: 100000 });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.target_value, 100000);
});

test("GET /metric-targets/annual: any authenticated user (including a PAM) can read it", async () => {
  const { status, body } = await get(`/metric-targets/annual?metric_key=closed_revenue&year=${SANDBOX_YEAR}`, tokens.denny);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.target_value, 100000);
});

test("GET /metric-targets/annual-cascade: PAM is blocked (403), Head/Admin can read it", async () => {
  const asPam = await get(`/metric-targets/annual-cascade?metric_key=closed_revenue&year=${SANDBOX_YEAR}`, tokens.denny);
  assert.equal(asPam.status, 403);

  const asHead = await get(`/metric-targets/annual-cascade?metric_key=closed_revenue&year=${SANDBOX_YEAR}`, tokens.irina);
  assert.equal(asHead.status, 200, `expected 200, got ${asHead.status}: ${JSON.stringify(asHead.body)}`);
  assert.equal(asHead.body.annual_target, 100000);
  assert.equal(asHead.body.metric_key, "closed_revenue");
});
