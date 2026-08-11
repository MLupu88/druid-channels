// Hotfix on top of Phase 3A: PAM recruitment-eligibility gate. Pure
// technology/software/platform vendors (a company whose own core business
// is selling its own product -- UiPath/Microsoft/SAP/Genesys-style) must
// never become a Discovery prospect in this motion, even though their
// canonical company identity is still resolved and their evidence is still
// preserved. DB-backed (persistCandidate needs a real transaction), same
// pattern as tests/discoveryDedupe.test.ts.
//
//   DATABASE_URL=... tsx --test tests/discoveryEligibility.test.ts
// or `pnpm run test:discovery-eligibility` with DATABASE_URL exported.
//
// No Tavily/DeepSeek/HubSpot calls: every candidate is hand-built with an
// explicit recruitmentArchetype, exactly as if it had already come back
// from AI qualification.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, companiesTable, territoriesTable, prospectsTable, signalsTable, type Territory } from "@workspace/db";
import { persistCandidate, isEligibleRecruitmentArchetype, qualifyChecks, type Candidate, type FiveChecks } from "../src/services/discoveryEngine";
import { RECRUITMENT_ARCHETYPES, type RecruitmentArchetype } from "../src/services/discoveryProviders/ai";
import { toRegistrableDomain } from "../src/services/companyIdentity";

let territoryA: Territory;
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
  return `phase3a-eligibility-test-${Date.now()}-${domainCounter}.example`;
}

function buildCandidate(
  domain: string,
  companyName: string,
  sourceUrl: string,
  recruitmentArchetype: RecruitmentArchetype,
  checks: FiveChecks = ALL_TRUE_CHECKS,
): Candidate {
  return {
    companyName,
    domain,
    country: "Unknown",
    partnerType: "Test partner type",
    recruitmentArchetype,
    checks,
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
  const [t] = await db.insert(territoriesTable).values({ name: `Phase3A-Eligibility-Test-${Date.now()}` }).returning();
  territoryA = t!;
  createdTerritoryIds.push(territoryA.id);
});

after(async () => {
  for (const companyId of createdCompanyIds) {
    await db.delete(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    await db.delete(signalsTable).where(eq(signalsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  for (const territoryId of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  await pool.end();
});

// ---- pure gate coverage: application code owns the eligibility rule -------

test("technology_vendor (e.g. 'Automation platform vendor', UiPath-style) is never eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("technology_vendor"), false);
});

test("a generic software/platform vendor is never eligible (same technology_vendor archetype)", () => {
  assert.equal(isEligibleRecruitmentArchetype("technology_vendor"), false);
});

test("system integrator is eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("system_integrator"), true);
});

test("reseller is eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("reseller"), true);
});

test("distributor is eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("distributor"), true);
});

test("managed service provider is eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("managed_service_provider"), true);
});

test("consultancy and implementation partner are eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("consultancy"), true);
  assert.equal(isEligibleRecruitmentArchetype("implementation_partner"), true);
});

test("bpo_service_provider is eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("bpo_service_provider"), true);
});

test("unknown/other is not eligible by default -- no clear qualifying channel-delivery evidence signal exists yet, so it never silently becomes eligible", () => {
  assert.equal(isEligibleRecruitmentArchetype("other"), false);
});

test("every declared archetype has an explicit eligibility verdict -- none silently falls through", () => {
  for (const archetype of RECRUITMENT_ARCHETYPES) {
    assert.equal(typeof isEligibleRecruitmentArchetype(archetype), "boolean");
  }
});

// ---- DB-backed: persistCandidate end-to-end --------------------------------

test("technology_vendor candidate: no prospect created, company + evidence still preserved", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "UiPath-style Vendor", `https://${domain}/investors`, "technology_vendor");

  const created = await persistCandidate(candidate, qualification, territoryA, "demo");
  assert.equal(created, false, "a technology vendor must never become a prospect");

  const companies = await findCanonicalCompanies(domain);
  assert.equal(companies.length, 1, "the canonical company row must still be created/preserved");
  createdCompanyIds.push(companies[0]!.id);

  const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companies[0]!.id));
  assert.equal(prospects.length, 0, "no prospect must exist for this company in this territory");

  const signals = await db.select().from(signalsTable).where(eq(signalsTable.companyId, companies[0]!.id));
  assert.equal(signals.length, 1, "evidence must still be preserved even though no prospect was created");
});

test("UiPath-style case: canonical identity still resolves (subdomain evidence collapses to one company), but no prospect is created", async () => {
  const domain = uniqueTestDomain();
  const c1 = buildCandidate(domain, "UiPath-style Vendor", `https://ir.${domain}/press`, "technology_vendor");
  const c2 = buildCandidate(domain, "UiPath-style Vendor", `https://careers.${domain}/jobs`, "technology_vendor");

  const created1 = await persistCandidate(c1, qualification, territoryA, "demo");
  const created2 = await persistCandidate(c2, qualification, territoryA, "demo");
  assert.equal(created1, false);
  assert.equal(created2, false);

  const companies = await findCanonicalCompanies(domain);
  assert.equal(companies.length, 1, "canonical identity must still collapse subdomain evidence to one company row (Phase 3A behavior unchanged)");
  createdCompanyIds.push(companies[0]!.id);

  const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companies[0]!.id));
  assert.equal(prospects.length, 0);

  const signals = await db.select().from(signalsTable).where(eq(signalsTable.companyId, companies[0]!.id));
  assert.equal(signals.length, 2, "both evidence items preserved on the one canonical company");
});

test("system integrator candidate: prospect created as usual", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "Test SI Co", `https://${domain}/a`, "system_integrator");
  const created = await persistCandidate(candidate, qualification, territoryA, "demo");
  assert.equal(created, true);
  const companies = await findCanonicalCompanies(domain);
  createdCompanyIds.push(companies[0]!.id);
  const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companies[0]!.id));
  assert.equal(prospects.length, 1);
});

test("reseller candidate: prospect created as usual", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "Test Reseller Co", `https://${domain}/a`, "reseller");
  const created = await persistCandidate(candidate, qualification, territoryA, "demo");
  assert.equal(created, true);
  const companies = await findCanonicalCompanies(domain);
  createdCompanyIds.push(companies[0]!.id);
});

test("MSP candidate: prospect created as usual", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "Test MSP Co", `https://${domain}/a`, "managed_service_provider");
  const created = await persistCandidate(candidate, qualification, territoryA, "demo");
  assert.equal(created, true);
  const companies = await findCanonicalCompanies(domain);
  createdCompanyIds.push(companies[0]!.id);
});

test("consultancy and implementation-partner candidates: prospect created as usual", async () => {
  const domainA = uniqueTestDomain();
  const candidateA = buildCandidate(domainA, "Test Consultancy Co", `https://${domainA}/a`, "consultancy");
  const createdA = await persistCandidate(candidateA, qualification, territoryA, "demo");
  assert.equal(createdA, true);
  const companiesA = await findCanonicalCompanies(domainA);
  createdCompanyIds.push(companiesA[0]!.id);

  const domainB = uniqueTestDomain();
  const candidateB = buildCandidate(domainB, "Test Implementation Co", `https://${domainB}/a`, "implementation_partner");
  const createdB = await persistCandidate(candidateB, qualification, territoryA, "demo");
  assert.equal(createdB, true);
  const companiesB = await findCanonicalCompanies(domainB);
  createdCompanyIds.push(companiesB[0]!.id);
});

test("unknown/other candidate without a clear channel-delivery signal: no prospect created, evidence still preserved", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "Test Ambiguous Co", `https://${domain}/a`, "other");
  const created = await persistCandidate(candidate, qualification, territoryA, "demo");
  assert.equal(created, false);

  const companies = await findCanonicalCompanies(domain);
  createdCompanyIds.push(companies[0]!.id);
  const signals = await db.select().from(signalsTable).where(eq(signalsTable.companyId, companies[0]!.id));
  assert.equal(signals.length, 1, "evidence is still preserved for an ambiguous/other candidate");
});

test("technology_adjacency=true (and all five checks true) does not override the technology_vendor exclusion", async () => {
  const domain = uniqueTestDomain();
  const strongChecks: FiveChecks = {
    enterpriseAccess: true,
    relevantCapability: true,
    technologyAdjacency: true,
    partnershipOpenness: true,
    recentTrigger: true,
  };
  const candidate = buildCandidate(domain, "Strong Vendor Co", `https://${domain}/a`, "technology_vendor", strongChecks);
  const strongQualification = qualifyChecks(strongChecks, 1);
  assert.equal(strongQualification.priority, "A", "sanity check: this candidate would have been Priority A on the five-check gate alone");

  const created = await persistCandidate(candidate, strongQualification, territoryA, "demo");
  assert.equal(created, false, "Priority A / strong technology adjacency must never override the recruitment-archetype eligibility gate");
});

test("a filtered technology_vendor candidate does not break scan counters/progress", async () => {
  const domain = uniqueTestDomain();
  const candidate = buildCandidate(domain, "Countable Vendor Co", `https://${domain}/a`, "technology_vendor");

  // Mirrors exactly what attemptLiveDiscovery/runDiscoveryForConfig do with
  // persistCandidate's return value: `if (created) prospectsCreated++`.
  let prospectsCreated = 0;
  const created = await persistCandidate(candidate, qualification, territoryA, "demo");
  if (created) prospectsCreated++;

  assert.equal(created, false);
  assert.equal(prospectsCreated, 0, "a filtered candidate contributes 0 to prospectsCreated, never throws, never corrupts the counter");

  const companies = await findCanonicalCompanies(domain);
  createdCompanyIds.push(companies[0]!.id);
});
