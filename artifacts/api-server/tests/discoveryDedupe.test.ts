// Phase 3A: Discovery candidate-company deduplication, territory-scoped
// suppression, evidence preservation, and concurrency -- DB-backed (needs a
// real transaction, real advisory locks), so this runs against a live
// disposable Postgres, same pattern as tests/roleSeparation.test.ts. No
// HTTP/API server needed -- these tests call the service-layer functions
// directly.
//
//   DATABASE_URL=... tsx --test tests/discoveryDedupe.test.ts
// or `pnpm run test:discovery-dedupe` from artifacts/api-server with
// DATABASE_URL exported.
//
// No Tavily/DeepSeek/HubSpot calls: every candidate here is hand-built with
// an already-canonical domain and a QualificationResult derived from
// qualifyChecks (a pure function) -- persistCandidate/
// resolveOrCreateCanonicalCompany are called directly, never through a live
// provider chain.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  territoriesTable,
  prospectsTable,
  signalsTable,
  partnerRecruitmentsTable,
  partnerRelationshipsTable,
  type Territory,
} from "@workspace/db";
import {
  persistCandidate,
  resolveOrCreateCanonicalCompany,
  qualifyChecks,
  type Candidate,
  type FiveChecks,
} from "../src/services/discoveryEngine";
import { toRegistrableDomain } from "../src/services/companyIdentity";

let territoryA: Territory;
let territoryB: Territory;
const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];

const ALL_TRUE_CHECKS: FiveChecks = {
  enterpriseAccess: true,
  relevantCapability: true,
  technologyAdjacency: true,
  partnershipOpenness: true,
  recentTrigger: true,
};
const qualification = qualifyChecks(ALL_TRUE_CHECKS, 1);

let domainCounter = 0;
function uniqueTestDomain(): string {
  domainCounter++;
  return `phase3a-dedupe-test-${Date.now()}-${domainCounter}.example`;
}

function buildCandidate(domain: string, companyName: string, sourceUrl: string): Candidate {
  return {
    companyName,
    domain,
    country: "Unknown",
    partnerType: "System integrator",
    checks: ALL_TRUE_CHECKS,
    whyItFits: "test fixture",
    whyNow: "test fixture",
    suggestedAngle: "test fixture",
    suggestedTargetRole: "test fixture",
    signals: [
      {
        signalType: "partnership",
        title: "test signal",
        summary: "test summary",
        sourceUrl,
        sourceDomain: new URL(sourceUrl).hostname,
        publishedAt: null,
        confidence: "medium",
        rawExcerpt: null,
      },
    ],
  };
}

async function findCanonicalCompanies(domain: string) {
  const all = await db.select().from(companiesTable);
  return all.filter((c) => toRegistrableDomain(c.domain) === domain);
}

before(async () => {
  const [tA] = await db.insert(territoriesTable).values({ name: `Phase3A-Dedupe-Test-A-${Date.now()}` }).returning();
  const [tB] = await db.insert(territoriesTable).values({ name: `Phase3A-Dedupe-Test-B-${Date.now()}` }).returning();
  territoryA = tA!;
  territoryB = tB!;
  createdTerritoryIds.push(territoryA.id, territoryB.id);
});

after(async () => {
  // Best-effort cleanup, in FK-safe order. This DB is disposable, but each
  // test suite still cleans up what it created.
  for (const companyId of createdCompanyIds) {
    const prospects = await db.select({ id: prospectsTable.id }).from(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    for (const p of prospects) {
      await db.delete(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.prospectId, p.id));
    }
    await db.delete(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    await db.delete(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.companyId, companyId));
    await db.delete(signalsTable).where(eq(signalsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  for (const territoryId of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  await pool.end();
});

// ---- E. same canonical company, same territory -> one active prospect -----

test("E: two qualified candidates for the same canonical company in the same territory produce exactly one prospect", async () => {
  const domain = uniqueTestDomain();
  const c1 = buildCandidate(domain, "Test Co E", `https://${domain}/press-1`);
  const c2 = buildCandidate(domain, "Test Co E", `https://ir.${domain}/press-2`);

  const created1 = await persistCandidate(c1, qualification, territoryA, "demo");
  const created2 = await persistCandidate(c2, qualification, territoryA, "demo");
  assert.equal(created1, true);
  assert.equal(created2, false, "a second qualified candidate for the same canonical company + territory must not create a second prospect");

  const companies = await findCanonicalCompanies(domain);
  assert.equal(companies.length, 1, "must not create a second company row either");
  createdCompanyIds.push(companies[0]!.id);

  const prospects = await db
    .select()
    .from(prospectsTable)
    .where(and(eq(prospectsTable.companyId, companies[0]!.id), eq(prospectsTable.territoryId, territoryA.id)));
  assert.equal(prospects.length, 1);
});

// ---- F. same canonical company, different territories -> independent prospects allowed ----

test("F: the same canonical company gets independent prospects in two different territories", async () => {
  const domain = uniqueTestDomain();
  const cA = buildCandidate(domain, "Test Co F", `https://${domain}/a`);
  const cB = buildCandidate(domain, "Test Co F", `https://${domain}/b`);

  const createdA = await persistCandidate(cA, qualification, territoryA, "demo");
  const createdB = await persistCandidate(cB, qualification, territoryB, "demo");
  assert.equal(createdA, true);
  assert.equal(createdB, true, "the same canonical company must be independently prospectable in a different territory");

  const companies = await findCanonicalCompanies(domain);
  assert.equal(companies.length, 1, "still exactly one canonical company row, shared across both territories");
  createdCompanyIds.push(companies[0]!.id);

  const allProspects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companies[0]!.id));
  assert.equal(allProspects.length, 2);
  assert.ok(allProspects.some((p) => p.territoryId === territoryA.id));
  assert.ok(allProspects.some((p) => p.territoryId === territoryB.id));
});

// ---- G. a rejected prior prospect can be reconsidered ----------------------

test("G: a rejected prospect in the same territory does not suppress rediscovery", async () => {
  const domain = uniqueTestDomain();
  const c1 = buildCandidate(domain, "Test Co G", `https://${domain}/a`);
  const created1 = await persistCandidate(c1, qualification, territoryA, "demo");
  assert.equal(created1, true);

  const companies = await findCanonicalCompanies(domain);
  createdCompanyIds.push(companies[0]!.id);
  const [prospect] = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companies[0]!.id));
  await db.update(prospectsTable).set({ status: "rejected" }).where(eq(prospectsTable.id, prospect!.id));

  const c2 = buildCandidate(domain, "Test Co G", `https://${domain}/b`);
  const created2 = await persistCandidate(c2, qualification, territoryA, "demo");
  assert.equal(created2, true, "a rejected prospect must not block a fresh prospect from being reconsidered");

  const allProspects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companies[0]!.id));
  assert.equal(allProspects.length, 2);
});

// ---- H. existing Recruitment (accepted prospect) suppresses rediscovery ----

test("H: a prospect already in Recruitment (accepted) in the same territory suppresses rediscovery, but evidence is still preserved", async () => {
  const domain = uniqueTestDomain();
  const c1 = buildCandidate(domain, "Test Co H", `https://${domain}/a`);
  await persistCandidate(c1, qualification, territoryA, "demo");

  const companies = await findCanonicalCompanies(domain);
  const companyId = companies[0]!.id;
  createdCompanyIds.push(companyId);
  const [prospect] = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companyId));
  await db.update(prospectsTable).set({ status: "accepted" }).where(eq(prospectsTable.id, prospect!.id));
  await db.insert(partnerRecruitmentsTable).values({ prospectId: prospect!.id, companyId, territoryId: territoryA.id });

  const c2 = buildCandidate(domain, "Test Co H", `https://${domain}/b`);
  const created2 = await persistCandidate(c2, qualification, territoryA, "demo");
  assert.equal(created2, false, "an accepted prospect already in Recruitment must suppress a new prospect in the same territory");

  const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companyId));
  assert.equal(prospects.length, 1, "still only the one original prospect -- no duplicate");

  const signals = await db.select().from(signalsTable).where(eq(signalsTable.companyId, companyId));
  assert.equal(signals.length, 2, "both candidates' evidence must be preserved even though the second was suppressed");
});

// ---- I. existing Portfolio relationship suppresses rediscovery, even with no prospect ----

test("I: an existing Portfolio relationship (no prior prospect at all) suppresses rediscovery in that territory", async () => {
  const domain = uniqueTestDomain();
  const [company] = await db.insert(companiesTable).values({ name: "Test Co I", domain, country: "Unknown" }).returning();
  createdCompanyIds.push(company!.id);
  await db.insert(partnerRelationshipsTable).values({ companyId: company!.id, territoryId: territoryA.id, originType: "manual" });

  const candidate = buildCandidate(domain, "Test Co I", `https://${domain}/a`);
  const created = await persistCandidate(candidate, qualification, territoryA, "demo");
  assert.equal(created, false, "an existing Portfolio relationship must suppress a new prospect, even with no prior prospect row");

  const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, company!.id));
  assert.equal(prospects.length, 0);

  const signals = await db.select().from(signalsTable).where(eq(signalsTable.companyId, company!.id));
  assert.equal(signals.length, 1, "evidence is still preserved even though no prospect was created");
});

// ---- J. multiple evidence signals accumulate on one singular company/prospect ----

test("J: multiple evidence signals for the same canonical company accumulate on one company and one prospect", async () => {
  const domain = uniqueTestDomain();
  const c1 = buildCandidate(domain, "Test Co J", `https://${domain}/press-1`);
  const c2 = buildCandidate(domain, "Test Co J", `https://careers.${domain}/press-2`);
  const c3 = buildCandidate(domain, "Test Co J", `https://${domain}/press-3`);

  await persistCandidate(c1, qualification, territoryA, "demo");
  await persistCandidate(c2, qualification, territoryA, "demo");
  await persistCandidate(c3, qualification, territoryA, "demo");

  const companies = await findCanonicalCompanies(domain);
  assert.equal(companies.length, 1);
  createdCompanyIds.push(companies[0]!.id);

  const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companies[0]!.id));
  assert.equal(prospects.length, 1);

  const signals = await db.select().from(signalsTable).where(eq(signalsTable.companyId, companies[0]!.id));
  assert.equal(signals.length, 3, "all three pieces of evidence must be preserved");
});

// ---- K. concurrent persistence attempts cannot create duplicate company rows ----

test("K: concurrent company-resolution attempts for the same new canonical domain never create two company rows", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "Test Co K", `https://${domain}/a`);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => db.transaction((tx) => resolveOrCreateCanonicalCompany(tx, candidate))),
  );

  const uniqueIds = new Set(results);
  assert.equal(uniqueIds.size, 1, "all 5 concurrent attempts must resolve to the same single company id");

  const companies = await findCanonicalCompanies(domain);
  assert.equal(companies.length, 1);
  createdCompanyIds.push(companies[0]!.id);
});

// ---- L. a pre-existing (including legacy non-canonical) company is recognized, not duplicated ----

test("L: a pre-existing company is recognized as already-known and reused, even if its stored domain is a legacy non-canonical string", async () => {
  const domain = uniqueTestDomain();
  const legacyStoredDomain = `www.${domain}`; // simulates a row written before Phase 3A
  const [existingCompany] = await db
    .insert(companiesTable)
    .values({ name: "Legacy Test Co L", domain: legacyStoredDomain, country: "Unknown" })
    .returning();
  createdCompanyIds.push(existingCompany!.id);

  const candidate = buildCandidate(domain, "Test Co L", `https://${domain}/a`); // candidate.domain is already canonical
  const resolvedId = await db.transaction((tx) => resolveOrCreateCanonicalCompany(tx, candidate));
  assert.equal(resolvedId, existingCompany!.id, "must recognize the legacy-domain row as the same canonical company, not create a new one");

  const companies = await findCanonicalCompanies(domain);
  assert.equal(companies.length, 1);
});
