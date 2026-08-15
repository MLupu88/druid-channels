// Phase 11.5A: regression coverage for "don't suggest this company again"
// exclusions -- created via DELETE /prospects/:id's exclude_company option,
// restored via POST /discovery-exclusions/:id/restore, and consumed by
// Discovery through services/discoveryExclusions.ts's
// loadActiveExclusionDomains/isDomainExcluded (see discoveryEngine.ts's two
// insertion points). Same harness convention as prospectDeleteGuard.test.ts
// (Phase 11.1): DB-backed, in-process HTTP, own fixtures, child-first
// teardown.
//
//   DATABASE_URL=... SESSION_SECRET=... tsx --test tests/discoveryExclusionsFlow.test.ts
// or `pnpm run test:discovery-exclusions-flow` with the same env exported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  territoriesTable,
  companiesTable,
  prospectsTable,
  prospectActivityTable,
  discoveryExclusionsTable,
} from "@workspace/db";
import app from "../src/app";
import { issueSessionToken } from "../src/services/session";
import { loadActiveExclusionDomains, isDomainExcluded } from "../src/services/discoveryExclusions";

let server: Server;
let baseUrl: string;

const createdUserIds: string[] = [];
const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];

let pamAId = "";
let pamAToken = "";
let pamBId = "";
let pamBToken = "";
let territoryAId = "";
let territoryBId = "";

let runId = 0;
function uniqueDomain(): string {
  runId++;
  return `phase11-5a-exclusions-${Date.now()}-${runId}.example`;
}

async function insertUser(name: string, role: "pam" | "head_of_channels", territory: string | null) {
  const [user] = await db
    .insert(usersTable)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, ".")}.${Date.now()}.${Math.random().toString(36).slice(2)}@phase11-test.example`, role, territory, active: true })
    .returning();
  createdUserIds.push(user!.id);
  const { token } = issueSessionToken(user!.id);
  return { id: user!.id, token };
}

async function insertCompany(): Promise<{ id: string; domain: string }> {
  const domain = uniqueDomain();
  const [company] = await db.insert(companiesTable).values({ name: `Phase 11.5A Co ${runId}`, domain, country: "Portugal" }).returning();
  createdCompanyIds.push(company!.id);
  return { id: company!.id, domain };
}

async function insertProspect(companyId: string, territoryId: string, assignedUserId: string) {
  const [prospect] = await db
    .insert(prospectsTable)
    .values({
      companyId,
      territoryId,
      assignedUserId,
      partnerType: "System integrator",
      priority: "A",
      whyItFits: "Phase 11.5A fixture",
      whyNow: "Phase 11.5A fixture",
      status: "accepted",
      acceptedAt: new Date(),
    })
    .returning();
  await db.insert(prospectActivityTable).values({ prospectId: prospect!.id, eventType: "accepted", timestamp: new Date() });
  return prospect!;
}

function authedFetch(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  baseUrl = `http://127.0.0.1:${address.port}/api`;

  const [territoryA] = await db.insert(territoriesTable).values({ name: `Phase 11.5A Territory A ${Date.now()}`, countries: ["PT"] }).returning();
  territoryAId = territoryA!.id;
  createdTerritoryIds.push(territoryAId);

  const [territoryB] = await db.insert(territoriesTable).values({ name: `Phase 11.5A Territory B ${Date.now()}`, countries: ["GB"] }).returning();
  territoryBId = territoryB!.id;
  createdTerritoryIds.push(territoryBId);

  const pamA = await insertUser("Phase115a PamA", "pam", territoryA!.name);
  pamAId = pamA.id;
  pamAToken = pamA.token;
  await db.update(territoriesTable).set({ ownerUserId: pamAId }).where(eq(territoriesTable.id, territoryAId));

  const pamB = await insertUser("Phase115a PamB", "pam", territoryB!.name);
  pamBId = pamB.id;
  pamBToken = pamB.token;
  await db.update(territoriesTable).set({ ownerUserId: pamBId }).where(eq(territoriesTable.id, territoryBId));
});

after(async () => {
  for (const companyId of createdCompanyIds) {
    const rows = await db.select({ id: prospectsTable.id }).from(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    for (const row of rows) {
      await db.delete(prospectActivityTable).where(eq(prospectActivityTable.prospectId, row.id));
      await db.delete(prospectsTable).where(eq(prospectsTable.id, row.id));
    }
    await db.delete(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  for (const territoryId of createdTerritoryIds) {
    await db.update(territoriesTable).set({ ownerUserId: null }).where(eq(territoriesTable.id, territoryId));
  }
  for (const userId of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
  for (const territoryId of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("removing a prospect with exclude_company creates an active exclusion Discovery would honor", async () => {
  const company = await insertCompany();
  const prospect = await insertProspect(company.id, territoryAId, pamAId);

  const res = await authedFetch(`/prospects/${prospect.id}`, pamAToken, {
    method: "DELETE",
    body: JSON.stringify({ reason: "not_relevant", exclude_company: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal(body.excluded, true, "response must confirm the exclusion was created");

  // The exact composition discoveryEngine.ts uses at both insertion points.
  const exclusionDomains = await loadActiveExclusionDomains(territoryAId);
  assert.equal(isDomainExcluded(company.domain, exclusionDomains), true, "the excluded domain must be skipped by Discovery");
  assert.equal(isDomainExcluded(`app.${company.domain}`, exclusionDomains), true, "a subdomain must also be skipped");

  const [row] = await db.select().from(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.companyId, company.id));
  assert.ok(row, "an exclusion row must exist");
  assert.equal(row!.reason, "not_relevant");
  assert.equal(row!.active, true);
  assert.equal(row!.territoryId, territoryAId, "exclusion must be scoped to the prospect's territory, not global");
  assert.equal(row!.createdByUserId, pamAId);
});

test("a PAM cannot restore an exclusion -- restore is admin-only, matching Settings' uniform requireAdmin gate", async () => {
  const company = await insertCompany();
  const prospect = await insertProspect(company.id, territoryAId, pamAId);
  await authedFetch(`/prospects/${prospect.id}`, pamAToken, {
    method: "DELETE",
    body: JSON.stringify({ reason: "bad_source", exclude_company: true }),
  });
  const [row] = await db.select().from(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.companyId, company.id));

  const restoreRes = await authedFetch(`/discovery-exclusions/${row!.id}/restore`, pamAToken, { method: "POST" });
  assert.equal(restoreRes.status, 403);

  const [stillRow] = await db.select().from(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.id, row!.id));
  assert.equal(stillRow!.active, true, "a forbidden restore attempt must not change anything");
});

test("an admin restores an exclusion, and the company becomes eligible for Discovery again", async () => {
  const head = await insertUser("Phase115a Head", "head_of_channels", null);
  const company = await insertCompany();
  const prospect = await insertProspect(company.id, territoryAId, pamAId);
  await authedFetch(`/prospects/${prospect.id}`, pamAToken, {
    method: "DELETE",
    body: JSON.stringify({ reason: "wrong_match", exclude_company: true }),
  });
  const [row] = await db.select().from(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.companyId, company.id));

  const restoreRes = await authedFetch(`/discovery-exclusions/${row!.id}/restore`, head.token, { method: "POST" });
  assert.equal(restoreRes.status, 200);
  const restored = await restoreRes.json();
  assert.equal(restored.active, false);
  assert.ok(restored.restored_at);

  const afterRestore = await loadActiveExclusionDomains(territoryAId);
  assert.equal(isDomainExcluded(company.domain, afterRestore), false, "restored company must be eligible for Discovery again");

  const listRes = await authedFetch("/discovery-exclusions", head.token);
  const list = await listRes.json();
  assert.ok(!list.some((e: any) => e.id === row!.id), "restored exclusion must not appear in the active list");
});

test("'duplicate' reason never creates an exclusion, even when exclude_company is requested", async () => {
  const company = await insertCompany();
  const prospect = await insertProspect(company.id, territoryAId, pamAId);

  const res = await authedFetch(`/prospects/${prospect.id}`, pamAToken, {
    method: "DELETE",
    body: JSON.stringify({ reason: "duplicate", exclude_company: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal(body.excluded, false, "a duplicate result must never suppress the underlying company");

  const [row] = await db.select().from(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.companyId, company.id));
  assert.equal(row, undefined, "no exclusion row should exist for a duplicate removal");

  const exclusionDomains = await loadActiveExclusionDomains(territoryAId);
  assert.equal(isDomainExcluded(company.domain, exclusionDomains), false, "the legitimate canonical company must remain fully discoverable");
});

test("plain removal (no exclude_company) still works exactly as before and creates no exclusion", async () => {
  const company = await insertCompany();
  const prospect = await insertProspect(company.id, territoryAId, pamAId);

  const res = await authedFetch(`/prospects/${prospect.id}`, pamAToken, { method: "DELETE" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal(body.excluded, false);

  const [row] = await db.select().from(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.companyId, company.id));
  assert.equal(row, undefined);
});

test("exclusion creation is scoped by the same authorization as prospect removal -- a cross-territory PAM cannot remove or exclude", async () => {
  const company = await insertCompany();
  const prospect = await insertProspect(company.id, territoryAId, pamAId);

  const res = await authedFetch(`/prospects/${prospect.id}`, pamBToken, {
    method: "DELETE",
    body: JSON.stringify({ reason: "not_relevant", exclude_company: true }),
  });
  assert.equal(res.status, 403, "existing territory-scoped authorization must still block this, unchanged");

  const [prospectRow] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, prospect.id));
  assert.ok(prospectRow, "prospect must remain intact");
  const [exclusionRow] = await db.select().from(discoveryExclusionsTable).where(eq(discoveryExclusionsTable.companyId, company.id));
  assert.equal(exclusionRow, undefined, "no exclusion may be created when the underlying removal was forbidden");
});
