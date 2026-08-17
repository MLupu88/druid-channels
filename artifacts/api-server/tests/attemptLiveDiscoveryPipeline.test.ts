// Phase 11.6.1 P3A: ONE focused DB-backed integration test for the new
// company-level candidate pipeline wired into attemptLiveDiscovery -- DB-
// backed (needs real territory/company/prospect rows, real transactions),
// same pattern as tests/discoveryDedupe.test.ts. Every actual provider call
// (Tavily search, DeepSeek subject extraction, DeepSeek identity
// resolution, DeepSeek qualification) is injected via attemptLiveDiscovery's
// LiveDiscoveryDeps parameter -- no live network call, no real credential,
// ever. Only extractionProvider.extract runs for real, because it is
// already pure/local (bounds already-supplied text, no network/DB call of
// its own).
//
//   DATABASE_URL=... tsx --test tests/attemptLiveDiscoveryPipeline.test.ts
// or `pnpm run test:attempt-live-discovery-pipeline` with DATABASE_URL
// exported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  territoriesTable,
  companiesTable,
  prospectsTable,
  connectionsTable,
  scanConfigsTable,
  scanRunsTable,
  type Territory,
} from "@workspace/db";
import { attemptLiveDiscovery, type LiveDiscoveryDeps } from "../src/services/discoveryEngine";
import { toRegistrableDomain } from "../src/services/companyIdentity";
import type { WebSearchResult } from "../src/services/discoveryProviders/search";
import type {
  AiQualificationInput,
  AiQualificationOutput,
  SubjectExtractionBatchInput,
  SubjectExtractionResult,
} from "../src/services/discoveryProviders/ai";

const suffix = Date.now();
// Synthetic domains (matching tests/discoveryDedupe.test.ts's own
// convention: .example, timestamp-suffixed) -- never real company domains,
// so this test can never collide with pre-existing companies/prospects
// rows or get silently skipped by the freshness cache.
const UIPATH_DOMAIN = `uipath-p3a-test-${suffix}.example`;
const WIRE_A_DOMAIN = `wire-a-p3a-test-${suffix}.example`;
const WIRE_B_DOMAIN = `wire-b-p3a-test-${suffix}.example`;
const ACME_DOMAIN = `acme-p3a-test-${suffix}.example`;
const BLOG_DOMAIN = `blog-p3a-test-${suffix}.example`;

const DUMMY_CRED_ENV_VAR = "P3A_INTEGRATION_TEST_DUMMY_CRED";
process.env[DUMMY_CRED_ENV_VAR] = "dummy-value-never-used-for-a-real-provider-call";

let territory: Territory;
let scanConfigId: string;
let runId: string;
const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const connectionRestore: Array<{ providerType: "web_search" | "ai"; existed: boolean; original?: typeof connectionsTable.$inferSelect }> = [];

before(async () => {
  const [t] = await db.insert(territoriesTable).values({ name: `Phase11.6.1-P3A-Pipeline-Test-${suffix}`, countries: ["Romania"] }).returning();
  territory = t!;
  createdTerritoryIds.push(territory.id);

  // attemptLiveDiscovery's own top-level `ready` gate needs a resolvable
  // web_search + ai connection to proceed at all -- every actual provider
  // call below is injected, so this dummy credential is never used to
  // reach a real network endpoint. Existing rows (if any) are restored to
  // their original state in `after`, never left mutated.
  for (const providerType of ["web_search", "ai"] as const) {
    const [existing] = await db.select().from(connectionsTable).where(eq(connectionsTable.providerType, providerType));
    if (existing) {
      connectionRestore.push({ providerType, existed: true, original: existing });
      await db.update(connectionsTable).set({ credentialEnvVar: DUMMY_CRED_ENV_VAR, enabled: true }).where(eq(connectionsTable.id, existing.id));
    } else {
      connectionRestore.push({ providerType, existed: false });
      await db.insert(connectionsTable).values({ providerType, providerName: providerType, credentialEnvVar: DUMMY_CRED_ENV_VAR, enabled: true });
    }
  }

  // searchQueries set explicitly (bypasses automatic query planning) --
  // buildSearchQueries returns this array verbatim, so exactly one query
  // runs against the injected searchFn below, deterministically.
  const [config] = await db
    .insert(scanConfigsTable)
    .values({
      territoryId: territory.id,
      name: `P3A Pipeline Test ${suffix}`,
      searchQueries: ["test query"],
      minChecksRequired: 3,
      maxResults: 10,
      recencyWindowDays: 90,
      active: true,
    })
    .returning();
  scanConfigId = config!.id;

  const [run] = await db.insert(scanRunsTable).values({ scanConfigId, status: "running", dataStatus: "demo" }).returning();
  runId = run!.id;
});

after(async () => {
  for (const restore of connectionRestore) {
    if (restore.existed && restore.original) {
      await db
        .update(connectionsTable)
        .set({ credentialEnvVar: restore.original.credentialEnvVar, enabled: restore.original.enabled })
        .where(eq(connectionsTable.id, restore.original.id));
    } else {
      await db.delete(connectionsTable).where(eq(connectionsTable.providerType, restore.providerType));
    }
  }
  for (const companyId of createdCompanyIds) {
    await db.delete(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  await db.delete(scanRunsTable).where(eq(scanRunsTable.id, runId));
  await db.delete(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));
  for (const territoryId of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  await pool.end();
});

test("P3A end-to-end: mixed first-/third-party evidence about one company groups into ONE candidate entry, a separate company and an unresolvable item are handled correctly, and exactly the right prospects are persisted", async () => {
  // ---- Scenario: 5 raw search results from one query -----------------------
  // - 3 URLs about the SAME company from mixed sources (its own site + two
  //   different third-party wires) -- must become ONE candidate group.
  // - 1 URL about a genuinely separate, unrelated company.
  // - 1 URL with no identifiable subject (unknown) -- must stay standalone.
  const mockResults: WebSearchResult[] = [
    { url: `https://${UIPATH_DOMAIN}/company`, title: "Official company site", snippet: "We build enterprise automation software.", publishedAt: null, score: 0.95 },
    { url: `https://${WIRE_A_DOMAIN}/article-1`, title: "Wire A: automation vendor wins deal", snippet: "The automation vendor announced a major enterprise deal.", publishedAt: null, score: 0.8 },
    { url: `https://${WIRE_B_DOMAIN}/article-2`, title: "Wire B: partner spotlight", snippet: "A partner spotlight on the automation vendor's ecosystem.", publishedAt: null, score: 0.7 },
    { url: `https://${ACME_DOMAIN}/about`, title: "Acme Consulting - About", snippet: "Acme Consulting is a systems integrator serving enterprise clients.", publishedAt: null, score: 0.6 },
    { url: `https://${BLOG_DOMAIN}/random-post`, title: "Random musings", snippet: "Just some unrelated thoughts on technology trends.", publishedAt: null, score: 0.1 },
  ];

  const searchFn = async (): Promise<WebSearchResult[]> => mockResults;

  // ---- Subject extraction: mixed first-/third-party, same subject for the
  // first three, a separate subject for Acme, unknown for the blog.
  let extractSubjectsCallCount = 0;
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput): Promise<SubjectExtractionResult[]> => {
    extractSubjectsCallCount++;
    return input.candidates.map((c): SubjectExtractionResult => {
      if (c.url.includes(UIPATH_DOMAIN)) return { resultId: c.resultId, subjectCompanyName: "Automation Vendor Co", sourceIsFirstParty: true, identityStatus: "resolved" };
      if (c.url.includes(WIRE_A_DOMAIN) || c.url.includes(WIRE_B_DOMAIN)) return { resultId: c.resultId, subjectCompanyName: "Automation Vendor Co", sourceIsFirstParty: false, identityStatus: "resolved" };
      if (c.url.includes(ACME_DOMAIN)) return { resultId: c.resultId, subjectCompanyName: "Acme Consulting", sourceIsFirstParty: true, identityStatus: "resolved" };
      return { resultId: c.resultId, subjectCompanyName: null, sourceIsFirstParty: false, identityStatus: "unknown" };
    });
  };

  // ---- Contextual resolution: only the two third-party "Automation Vendor
  // Co" items need this (the first-party item resolves for free) -- each
  // call is independent and evidence-context-aware; both must agree on the
  // same canonical domain based on their OWN context, never via a shared
  // name-keyed cache. This is the exact mechanism proven in isolation by
  // tests/candidateIdentityResolution.test.ts's Case C -- this test proves
  // it again end to end, through the real attemptLiveDiscovery wiring.
  const resolveCalls: string[] = [];
  const resolveIdentityWithContext: LiveDiscoveryDeps["resolveIdentityWithContext"] = async (name, context) => {
    resolveCalls.push(context.evidenceUrl!);
    if (name === "Automation Vendor Co") return { name: "Automation Vendor Co", domain: UIPATH_DOMAIN };
    return null;
  };

  // ---- Qualification: captures every call's evidence array (assertions
  // 3-5), returns a qualifying result for the two real candidates and a
  // non-qualifying result for the unresolved blog item.
  const qualifyCalls: AiQualificationInput[] = [];
  const qualifyFn = async (input: AiQualificationInput): Promise<AiQualificationOutput> => {
    qualifyCalls.push(input);
    const isBlog = input.evidence.every((e) => e.url.includes(BLOG_DOMAIN));
    if (isBlog) {
      return {
        partnerType: "Unknown",
        recruitmentArchetype: "other",
        signalType: "technology",
        subjectCompanyName: "Unknown",
        sourceIsFirstParty: false,
        enterpriseAccess: false,
        relevantCapability: false,
        technologyAdjacency: false,
        partnershipOpenness: false,
        recentTrigger: false,
        whyItFits: "No evidence.",
        whyNow: "No evidence.",
        suggestedAngle: "None.",
        suggestedTargetRole: "None",
        suggestedMessage: "None.",
        evidenceUrls: [],
      };
    }
    const isAutomationVendor = input.evidence.some((e) => e.url.includes(UIPATH_DOMAIN) || e.url.includes(WIRE_A_DOMAIN) || e.url.includes(WIRE_B_DOMAIN));
    return {
      partnerType: isAutomationVendor ? "Automation platform vendor" : "System integrator",
      // Mocked as an eligible archetype for both (this test is about
      // grouping/aggregation wiring, not archetype-exclusion policy --
      // discoveryEligibility.test.ts already covers that exhaustively).
      recruitmentArchetype: "system_integrator",
      signalType: "partnership",
      subjectCompanyName: isAutomationVendor ? "Automation Vendor Co" : "Acme Consulting",
      sourceIsFirstParty: input.evidence[0]!.url.includes(isAutomationVendor ? UIPATH_DOMAIN : ACME_DOMAIN),
      enterpriseAccess: true,
      relevantCapability: true,
      technologyAdjacency: true,
      partnershipOpenness: true,
      recentTrigger: true,
      whyItFits: "Test fixture: strong evidence-grounded fit.",
      whyNow: "Test fixture: recent trigger present.",
      suggestedAngle: "Test fixture: partnership angle.",
      suggestedTargetRole: "VP Partnerships",
      suggestedMessage: "Test fixture: outreach message.",
      // Ground every evidence item given -- proves signals/provenance stay
      // attached per item, not collapsed into one row (assertion 5).
      evidenceUrls: input.evidence.map((e) => e.url),
    };
  };

  const [config] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));

  // ---- 1. attemptLiveDiscovery completes successfully -----------------------
  const result = await attemptLiveDiscovery(config!, territory, runId, {
    searchFn,
    qualifyFn,
    resolveIdentityWithContext,
    extractSubjectsFn,
  });

  assert.ok(result, "attemptLiveDiscovery must complete successfully (non-null) given a ready live provider chain");
  const { candidates, stats } = result!;

  // ---- 9. no name-only grouping anywhere -- each third-party item spent its
  // OWN independent, evidence-context-aware resolution call, never a single
  // shared/cached-by-name call.
  assert.equal(resolveCalls.length, 2, "each third-party 'Automation Vendor Co' item must trigger its own resolution call");
  assert.deepEqual(resolveCalls.sort(), [`https://${WIRE_A_DOMAIN}/article-1`, `https://${WIRE_B_DOMAIN}/article-2`].sort());

  // ---- 2 & 6. multiple URLs for one company -> ONE qualification candidate
  // entry; MAX_CANDIDATES_TO_LLM applies to entries, not raw URLs (5 URLs,
  // 3 candidate entries, 3 qualify() calls -- never 5).
  assert.equal(extractSubjectsCallCount, 1, "5 results fit in one subject-extraction batch (batch size 10)");
  assert.equal(qualifyCalls.length, 3, "3 distinct candidate entries (grouped vendor, Acme, unresolved blog) -- never one qualify() call per raw URL");

  const vendorCall = qualifyCalls.find((c) => c.evidence.some((e) => e.url.includes(UIPATH_DOMAIN)));
  assert.ok(vendorCall, "expected one qualify() call whose evidence includes the grouped vendor's first-party URL");

  // ---- 3, 4 & 5. aggregated, source-diverse evidence reached qualify() -----
  assert.ok(vendorCall!.evidence.length <= 3, "aggregated evidence must never exceed 3 items");
  assert.equal(vendorCall!.evidence.length, 3, "all three real, distinct-source items for this company should be included (no more than 3 existed to select from)");
  const vendorEvidenceDomains = new Set(vendorCall!.evidence.map((e) => new URL(e.url).hostname));
  assert.equal(vendorEvidenceDomains.size, 3, "the three selected evidence items must come from three DIFFERENT source domains (source diversity), never the same domain repeated");
  assert.ok(vendorCall!.evidence.some((e) => e.url.includes(UIPATH_DOMAIN)), "the vendor's own first-party page must be included");
  assert.ok(vendorCall!.evidence.some((e) => e.url.includes(WIRE_A_DOMAIN)));
  assert.ok(vendorCall!.evidence.some((e) => e.url.includes(WIRE_B_DOMAIN)));

  const acmeCall = qualifyCalls.find((c) => c.evidence.some((e) => e.url.includes(ACME_DOMAIN)));
  assert.ok(acmeCall);
  assert.equal(acmeCall!.evidence.length, 1, "Acme only ever had one piece of evidence -- never padded to 3");

  // ---- Returned candidates reflect the same grouping (in-memory, before
  // persistence) -- source provenance preserved per evidence item.
  const vendorCandidate = candidates.find((c) => toRegistrableDomain(c.domain) === UIPATH_DOMAIN);
  assert.ok(vendorCandidate, "expected one Candidate for the grouped vendor");
  assert.equal(vendorCandidate!.signals.length, 3, "one signal per evidence item DeepSeek grounded its answer in, all three preserved");
  assert.deepEqual(
    vendorCandidate!.signals.map((s) => s.sourceDomain).sort(),
    [UIPATH_DOMAIN, WIRE_A_DOMAIN, WIRE_B_DOMAIN].sort(),
    "source provenance (sourceDomain) must remain attached to every individual evidence item, distinctly",
  );

  // ---- 7. exactly one canonical company/prospect persisted for the grouped
  // company (never one per URL), plus one for Acme, none for the blog. ----
  const vendorCompanies = await db.select().from(companiesTable).where(eq(companiesTable.domain, UIPATH_DOMAIN));
  assert.equal(vendorCompanies.length, 1, "exactly one canonical company row for the grouped vendor, never three");
  createdCompanyIds.push(vendorCompanies[0]!.id);
  const vendorProspects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, vendorCompanies[0]!.id));
  assert.equal(vendorProspects.length, 1, "exactly one prospect row for the grouped vendor in this territory");
  assert.equal(vendorProspects[0]!.territoryId, territory.id);

  const acmeCompanies = await db.select().from(companiesTable).where(eq(companiesTable.domain, ACME_DOMAIN));
  assert.equal(acmeCompanies.length, 1);
  createdCompanyIds.push(acmeCompanies[0]!.id);
  const acmeProspects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, acmeCompanies[0]!.id));
  assert.equal(acmeProspects.length, 1);

  const blogCompanies = await db.select().from(companiesTable).where(eq(companiesTable.domain, BLOG_DOMAIN));
  assert.equal(blogCompanies.length, 0, "the unresolved/unqualified blog item must never become a company or prospect");

  // ---- 8. existing scan counters remain internally consistent -------------
  assert.equal(stats.queriesRun, 1);
  assert.equal(stats.uniqueCompaniesSeen, 5, "all five distinct URLs, none excluded/freshness-skipped (all brand-new synthetic domains)");
  assert.equal(stats.newCompaniesCount, 5);
  assert.equal(stats.duplicatesRemoved, 0);
  assert.equal(stats.candidatesSentToLlm, 3, "matches qualifyCalls.length exactly -- the P2 counter semantics are preserved under the new pipeline");
  assert.equal(stats.candidatesQualified, 2, "vendor + Acme pass qualifyChecks; the blog item does not");
  assert.equal(stats.prospectsCreated, 2);
  // The same funnel invariant established in the P2 correction round:
  // results_qualified <= candidates_qualified <= candidates_sent_to_llm <= unique_companies_seen.
  assert.ok(stats.prospectsCreated <= stats.candidatesQualified);
  assert.ok(stats.candidatesQualified <= stats.candidatesSentToLlm);
  assert.ok(stats.candidatesSentToLlm <= stats.uniqueCompaniesSeen);
});
