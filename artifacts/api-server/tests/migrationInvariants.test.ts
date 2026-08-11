// Phase 3B: DB-backed tests proving the ACTUAL unique indexes -- not just
// their schema declaration -- enforce the target invariants directly
// against Postgres. Independent of (and in addition to) Phase 3A's
// application-level dedupe/suppression logic, which is covered separately
// in discoveryDedupe.test.ts / discoveryEligibility.test.ts.
//
// Needs the Phase 3B migration (drizzle/0014_polite_cerebro.sql) already
// applied to whatever DATABASE_URL this runs against -- same
// disposable-Postgres pattern as every other DB-backed suite in this
// project:
//
//   DATABASE_URL=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... tsx --test tests/migrationInvariants.test.ts
// or `pnpm run test:migration-invariants` with DATABASE_URL exported and
// the migration already applied.
//
// No Tavily/DeepSeek/HubSpot calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, companiesTable, territoriesTable, prospectsTable, type Territory } from "@workspace/db";
import { resolveOrCreateCanonicalCompany, type Candidate } from "../src/services/discoveryEngine";

let territoryA: Territory;
let territoryB: Territory;
const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];

// node-postgres attaches the real Postgres error (SQLSTATE 23505 =
// unique_violation, message "duplicate key value violates unique
// constraint ...") as `.cause` on drizzle's wrapping "Failed query: ..."
// error -- assert.rejects' regex form matches the OUTER message, which
// never contains the constraint name, so a validator function checking the
// actual cause is required.
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  return cause?.code === "23505" && !!cause.message?.includes(constraintName);
}

let domainCounter = 0;
function uniqueTestDomain(): string {
  domainCounter++;
  return `phase3b-migration-test-${Date.now()}-${domainCounter}.example`;
}

function baseProspect(overrides: { companyId: string; territoryId: string; status?: string }) {
  return {
    companyId: overrides.companyId,
    territoryId: overrides.territoryId,
    assignedUserId: null,
    partnerType: "System integrator",
    priority: "A" as const,
    whyItFits: "test fixture",
    whyNow: "test fixture",
    status: (overrides.status ?? "new") as any,
  };
}

function buildCandidate(domain: string, companyName: string): Candidate {
  return {
    companyName,
    domain,
    country: "Unknown",
    partnerType: "System integrator",
    recruitmentArchetype: "system_integrator",
    checks: { enterpriseAccess: true, relevantCapability: true, technologyAdjacency: true, partnershipOpenness: true, recentTrigger: true },
    whyItFits: "test fixture",
    whyNow: "test fixture",
    suggestedAngle: "test fixture",
    suggestedTargetRole: "test fixture",
    signals: [],
  };
}

before(async () => {
  const [tA] = await db.insert(territoriesTable).values({ name: `Phase3B-Migration-Test-A-${Date.now()}` }).returning();
  const [tB] = await db.insert(territoriesTable).values({ name: `Phase3B-Migration-Test-B-${Date.now()}` }).returning();
  territoryA = tA!;
  territoryB = tB!;
  createdTerritoryIds.push(territoryA.id, territoryB.id);
});

after(async () => {
  for (const companyId of createdCompanyIds) {
    await db.delete(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  for (const territoryId of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  await pool.end();
});

// ---- companies_domain_unique -------------------------------------------------

test("companies_domain_unique: a second company row with the same stored domain is rejected by Postgres", async () => {
  const domain = uniqueTestDomain();
  const [c1] = await db.insert(companiesTable).values({ name: "Co A", domain, country: "Unknown" }).returning();
  createdCompanyIds.push(c1!.id);

  await assert.rejects(
    () => db.insert(companiesTable).values({ name: "Co A duplicate", domain, country: "Unknown" }),
    (err: unknown) => isUniqueViolation(err, "companies_domain_unique"),
  );
});

test("companies_domain_unique: multiple companies with a null domain are all allowed", async () => {
  const [c1] = await db.insert(companiesTable).values({ name: "No Domain A", domain: null, country: "Unknown" }).returning();
  const [c2] = await db.insert(companiesTable).values({ name: "No Domain B", domain: null, country: "Unknown" }).returning();
  createdCompanyIds.push(c1!.id, c2!.id);
  assert.notEqual(c1!.id, c2!.id);
});

// ---- prospects_company_territory_active_unique -------------------------------

test("prospects_company_territory_active_unique: a second 'new' prospect for the same company+territory is rejected", async () => {
  const [company] = await db.insert(companiesTable).values({ name: "Co C", domain: uniqueTestDomain(), country: "Unknown" }).returning();
  createdCompanyIds.push(company!.id);
  await db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryA.id, status: "new" }));

  await assert.rejects(
    () => db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryA.id, status: "new" })),
    (err: unknown) => isUniqueViolation(err, "prospects_company_territory_active_unique"),
  );
});

test("prospects_company_territory_active_unique: after the first prospect is rejected, a new one for the same company+territory is allowed (reconsideration preserved)", async () => {
  const [company] = await db.insert(companiesTable).values({ name: "Co D", domain: uniqueTestDomain(), country: "Unknown" }).returning();
  createdCompanyIds.push(company!.id);
  const [p1] = await db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryA.id, status: "new" })).returning();
  await db.update(prospectsTable).set({ status: "rejected" }).where(eq(prospectsTable.id, p1!.id));

  const [p2] = await db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryA.id, status: "new" })).returning();
  assert.ok(p2, "a fresh prospect must be insertable once the prior one is rejected");
});

test("prospects_company_territory_active_unique: the same company can have independent active prospects in two different territories", async () => {
  const [company] = await db.insert(companiesTable).values({ name: "Co E", domain: uniqueTestDomain(), country: "Unknown" }).returning();
  createdCompanyIds.push(company!.id);
  await db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryA.id, status: "new" }));
  const [p2] = await db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryB.id, status: "new" })).returning();
  assert.ok(p2, "a different territory must never be blocked by another territory's active prospect");
});

test("prospects_company_territory_active_unique: an 'accepted' (not just 'new') prospect also blocks a second active prospect in the same territory", async () => {
  const [company] = await db.insert(companiesTable).values({ name: "Co F", domain: uniqueTestDomain(), country: "Unknown" }).returning();
  createdCompanyIds.push(company!.id);
  await db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryA.id, status: "accepted" }));

  await assert.rejects(
    () => db.insert(prospectsTable).values(baseProspect({ companyId: company!.id, territoryId: territoryA.id, status: "new" })),
    (err: unknown) => isUniqueViolation(err, "prospects_company_territory_active_unique"),
  );
});

// ---- advisory lock still resolves cleanly now that the index exists ---------

test("resolveOrCreateCanonicalCompany: concurrent calls for a brand-new domain still resolve cleanly (no raw unique-violation reaches the caller) now that the DB index exists", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "Co G");

  const results = await Promise.all(
    Array.from({ length: 5 }, () => db.transaction((tx) => resolveOrCreateCanonicalCompany(tx, candidate))),
  );

  const uniqueIds = new Set(results);
  assert.equal(uniqueIds.size, 1, "all 5 concurrent attempts must resolve to the same single company id, with no unhandled unique-violation");
  createdCompanyIds.push(results[0]!);
});
