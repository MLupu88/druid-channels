// Partner Radar recall fix (novelty prioritization): DB-backed integration
// tests for the discovery_evaluations ledger wired into attemptLiveDiscovery
// -- needs real territory/company/prospect/scan_run rows, real transactions.
// Same pattern as tests/attemptLiveDiscoveryPipeline.test.ts: every actual
// provider call (search, subject extraction, identity resolution,
// qualification) is injected via LiveDiscoveryDeps -- no live network call,
// no real credential, ever.
//
//   DATABASE_URL=... tsx --test tests/discoveryEvaluationsFlow.test.ts
// or `pnpm run test:discovery-evaluations-flow` with DATABASE_URL exported.
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
  discoveryEvaluationsTable,
  type Territory,
} from "@workspace/db";
import { attemptLiveDiscovery, type LiveDiscoveryDeps } from "../src/services/discoveryEngine";
import { AiProviderError } from "../src/services/discoveryProviders/ai";
import type { WebSearchResult } from "../src/services/discoveryProviders/search";
import type { AiQualificationInput, AiQualificationOutput, SubjectExtractionBatchInput, SubjectExtractionResult } from "../src/services/discoveryProviders/ai";

const suffix = Date.now();
const DUMMY_CRED_ENV_VAR = "DISCOVERY_EVALUATIONS_TEST_DUMMY_CRED";
process.env[DUMMY_CRED_ENV_VAR] = "dummy-value-never-used-for-a-real-provider-call";

let territory: Territory;
let scanConfigId: string;
const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdScanRunIds: string[] = [];
const connectionRestore: Array<{ providerType: "web_search" | "ai"; existed: boolean; original?: typeof connectionsTable.$inferSelect }> = [];

const ALL_TRUE_CHECKS = { enterpriseAccess: true, relevantCapability: true, technologyAdjacency: true, partnershipOpenness: true, recentTrigger: true };
const ALL_FALSE_CHECKS = { enterpriseAccess: false, relevantCapability: false, technologyAdjacency: false, partnershipOpenness: false, recentTrigger: false };

function qualificationOutput(overrides: Partial<AiQualificationOutput> & { checks?: Partial<typeof ALL_TRUE_CHECKS> } = {}): AiQualificationOutput {
  const { checks: checksOverride, ...rest } = overrides;
  const checks = { ...ALL_TRUE_CHECKS, ...(checksOverride ?? {}) };
  return {
    partnerType: "System integrator",
    recruitmentArchetype: "system_integrator",
    signalType: "partnership",
    subjectCompanyName: "Test Co",
    sourceIsFirstParty: true,
    ...checks,
    whyItFits: "Test fixture.",
    whyNow: "Test fixture.",
    suggestedAngle: "Test fixture.",
    suggestedTargetRole: "VP Partnerships",
    suggestedMessage: "Test fixture.",
    evidenceUrls: [],
    ...rest,
  };
}

async function newScanRun(): Promise<string> {
  const [run] = await db.insert(scanRunsTable).values({ scanConfigId, status: "running", dataStatus: "demo" }).returning();
  createdScanRunIds.push(run!.id);
  return run!.id;
}

async function cleanupDomain(domain: string): Promise<void> {
  await db.delete(discoveryEvaluationsTable).where(eq(discoveryEvaluationsTable.domain, domain));
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.domain, domain));
  if (company) {
    await db.delete(prospectsTable).where(eq(prospectsTable.companyId, company.id));
    await db.delete(companiesTable).where(eq(companiesTable.id, company.id));
  }
}

before(async () => {
  const [t] = await db.insert(territoriesTable).values({ name: `DiscoveryEvaluationsFlow-Test-${suffix}`, countries: ["Romania"] }).returning();
  territory = t!;
  createdTerritoryIds.push(territory.id);

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

  const [config] = await db
    .insert(scanConfigsTable)
    .values({
      territoryId: territory.id,
      name: `Discovery Evaluations Flow Test ${suffix}`,
      searchQueries: ["test query"],
      minChecksRequired: 3,
      maxResults: 10,
      recencyWindowDays: 90,
      active: true,
    })
    .returning();
  scanConfigId = config!.id;
});

after(async () => {
  for (const restore of connectionRestore) {
    if (restore.existed && restore.original) {
      await db.update(connectionsTable).set({ credentialEnvVar: restore.original.credentialEnvVar, enabled: restore.original.enabled }).where(eq(connectionsTable.id, restore.original.id));
    } else {
      await db.delete(connectionsTable).where(eq(connectionsTable.providerType, restore.providerType));
    }
  }
  for (const companyId of createdCompanyIds) {
    await db.delete(discoveryEvaluationsTable).where(eq(discoveryEvaluationsTable.territoryId, territory.id));
    await db.delete(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  for (const runId of createdScanRunIds) {
    await db.delete(scanRunsTable).where(eq(scanRunsTable.id, runId));
  }
  await db.delete(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));
  for (const territoryId of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  await pool.end();
});

test("a rejected candidate gets a durable 'rejected' evaluation row after a valid AI decision; a repeat first-party scan is filtered before it's even collected (Stage 1), never reaching qualify() again", async () => {
  const domain = `rejected-a-${suffix}.example`;
  const mockResults: WebSearchResult[] = [{ url: `https://${domain}/company`, title: "Rejected Co A", snippet: "A small firm.", publishedAt: null, score: 0.9 }];
  const searchFn = async (): Promise<WebSearchResult[]> => mockResults;
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput): Promise<SubjectExtractionResult[]> =>
    input.candidates.map((c) => ({ resultId: c.resultId, subjectCompanyName: "Rejected Co A", sourceIsFirstParty: true, identityStatus: "resolved" }));
  let qualifyCallCount = 0;
  const qualifyFn = async (): Promise<AiQualificationOutput> => {
    qualifyCallCount++;
    return qualificationOutput({ checks: ALL_FALSE_CHECKS, subjectCompanyName: "Rejected Co A" });
  };
  const [config] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));
  const deps: LiveDiscoveryDeps = { searchFn, qualifyFn, extractSubjectsFn };

  // ---- Run A: first time -- evidence is sent, rejected, recorded ----------
  const runIdA = await newScanRun();
  const resultA = await attemptLiveDiscovery(config!, territory, runIdA, deps);
  assert.ok(resultA);
  assert.equal(resultA!.stats.candidatesSentToLlm, 1, "the first time, this genuinely unseen domain must be sent for qualification");
  assert.equal(resultA!.stats.candidatesQualified, 0, "it failed qualifyChecks (all checks false)");
  assert.equal(resultA!.stats.prospectsCreated, 0);
  assert.equal(qualifyCallCount, 1);

  const evalRowsAfterA = await db.select().from(discoveryEvaluationsTable).where(eq(discoveryEvaluationsTable.domain, domain));
  assert.equal(evalRowsAfterA.length, 1, "a durable evaluation row must exist after a valid (non-throwing) AI decision, even though it was a rejection");
  assert.equal(evalRowsAfterA[0]!.outcome, "rejected");
  assert.equal(evalRowsAfterA[0]!.territoryId, territory.id);
  assert.equal(evalRowsAfterA[0]!.scanRunId, runIdA);

  // ---- Run B: shortly afterward, same first-party URL again ---------------
  const runIdB = await newScanRun();
  const resultB = await attemptLiveDiscovery(config!, territory, runIdB, deps);
  assert.ok(resultB);
  assert.equal(qualifyCallCount, 1, "qualify() must NOT be called again for this recently-rejected domain");
  assert.equal(resultB!.stats.candidatesSentToLlm, 0, "candidates_sent_to_llm must reflect the true count of actual qualification calls this run -- zero");
  assert.equal(resultB!.stats.uniqueCompaniesSeen, 0, "caught at Stage 1's existing known-domain freshness check, before it's even collected as a candidate");

  await cleanupDomain(domain);
});

test("previously-known evidence about a rejected company, arriving via a DIFFERENT (third-party) URL, is caught by the new post-grouping freshness filter and counted in candidates_skipped_recent -- proving the case Stage 1's evidenceDomain-only check cannot catch", async () => {
  const domain = `rejected-b-${suffix}.example`;
  const wireDomain = `wire-b-${suffix}.example`;

  // Run C: reject via first-party evidence, exactly as above.
  const firstPartyResults: WebSearchResult[] = [{ url: `https://${domain}/company`, title: "Rejected Co B", snippet: "Another small firm.", publishedAt: null, score: 0.9 }];
  const extractFirstParty = async (input: SubjectExtractionBatchInput): Promise<SubjectExtractionResult[]> =>
    input.candidates.map((c) => ({ resultId: c.resultId, subjectCompanyName: "Rejected Co B", sourceIsFirstParty: true, identityStatus: "resolved" }));
  const qualifyReject = async (): Promise<AiQualificationOutput> => qualificationOutput({ checks: ALL_FALSE_CHECKS, subjectCompanyName: "Rejected Co B" });

  const [config] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));
  const runIdC = await newScanRun();
  await attemptLiveDiscovery(config!, territory, runIdC, { searchFn: async () => firstPartyResults, qualifyFn: qualifyReject, extractSubjectsFn: extractFirstParty });

  const evalRows = await db.select().from(discoveryEvaluationsTable).where(eq(discoveryEvaluationsTable.domain, domain));
  assert.equal(evalRows.length, 1, "sanity check: Run C recorded the rejection, same as the previous test");

  // Run D: a DIFFERENT wire URL, never seen before, whose evidence is about
  // the SAME company -- Stage 1 cannot skip this (its evidenceDomain is
  // wireDomain, not `domain`, so knownDomainRecords.has(wireDomain) is
  // false). It must reach subject-extraction + contextual resolution,
  // resolve to the SAME canonical domain, and only THEN get skipped.
  const thirdPartyResults: WebSearchResult[] = [{ url: `https://${wireDomain}/article`, title: "Wire: Rejected Co B in the news", snippet: "A wire story about Rejected Co B.", publishedAt: null, score: 0.7 }];
  const extractThirdParty = async (input: SubjectExtractionBatchInput): Promise<SubjectExtractionResult[]> =>
    input.candidates.map((c) => ({ resultId: c.resultId, subjectCompanyName: "Rejected Co B", sourceIsFirstParty: false, identityStatus: "resolved" }));
  const resolveIdentityWithContext: LiveDiscoveryDeps["resolveIdentityWithContext"] = async (name) => (name === "Rejected Co B" ? { name: "Rejected Co B", domain } : null);
  let qualifyCallCountD = 0;
  const qualifyFnD = async (): Promise<AiQualificationOutput> => {
    qualifyCallCountD++;
    return qualificationOutput({ checks: ALL_FALSE_CHECKS });
  };

  const runIdD = await newScanRun();
  const resultD = await attemptLiveDiscovery(config!, territory, runIdD, {
    searchFn: async () => thirdPartyResults,
    qualifyFn: qualifyFnD,
    extractSubjectsFn: extractThirdParty,
    resolveIdentityWithContext,
  });

  assert.ok(resultD);
  assert.equal(resultD!.stats.uniqueCompaniesSeen, 1, "the wire URL itself is genuinely new to Stage 1's evidenceDomain-keyed check");
  assert.equal(qualifyCallCountD, 0, "qualify() must never be called -- the post-grouping filter caught it before the MAX_CANDIDATES_TO_LLM slice");
  assert.equal(resultD!.stats.candidatesSentToLlm, 0);
  assert.equal(resultD!.stats.candidatesSkippedRecent, 1, "candidates_skipped_recent must report exactly the one group entry skipped this way");

  await cleanupDomain(domain);
});

test("a candidate-level AI failure (malformed/schema-invalid response) is never recorded as a rejection", async () => {
  const domain = `failure-${suffix}.example`;
  const mockResults: WebSearchResult[] = [{ url: `https://${domain}/company`, title: "Failure Co", snippet: "Evidence.", publishedAt: null, score: 0.9 }];
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput): Promise<SubjectExtractionResult[]> =>
    input.candidates.map((c) => ({ resultId: c.resultId, subjectCompanyName: "Failure Co", sourceIsFirstParty: true, identityStatus: "resolved" }));
  const qualifyFn = async (): Promise<AiQualificationOutput> => {
    throw new AiProviderError("schema_invalid");
  };
  const [config] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));
  const runId = await newScanRun();

  const result = await attemptLiveDiscovery(config!, territory, runId, { searchFn: async () => mockResults, qualifyFn, extractSubjectsFn });
  assert.ok(result, "a candidate-level AI error must not fail the whole scan");
  assert.equal(result!.stats.candidatesSentToLlm, 1, "still counted as sent -- the call genuinely happened");
  assert.equal(result!.stats.candidatesQualified, 0);

  const evalRows = await db.select().from(discoveryEvaluationsTable).where(eq(discoveryEvaluationsTable.domain, domain));
  assert.equal(evalRows.length, 0, "a malformed/unusable AI response must never be persisted as a real business rejection");

  await cleanupDomain(domain);
});

test("a qualified candidate ALSO gets a durable 'qualified' evaluation row, and its original prospect stays visible and untouched on a repeat scan (novelty affects budget allocation, never whether existing good prospects disappear)", async () => {
  const domain = `qualified-${suffix}.example`;
  const mockResults: WebSearchResult[] = [{ url: `https://${domain}/company`, title: "Qualified Co", snippet: "A strong fit.", publishedAt: null, score: 0.9 }];
  const searchFn = async (): Promise<WebSearchResult[]> => mockResults;
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput): Promise<SubjectExtractionResult[]> =>
    input.candidates.map((c) => ({ resultId: c.resultId, subjectCompanyName: "Qualified Co", sourceIsFirstParty: true, identityStatus: "resolved" }));
  let qualifyCallCount = 0;
  const qualifyFn = async (): Promise<AiQualificationOutput> => {
    qualifyCallCount++;
    return qualificationOutput({ checks: ALL_TRUE_CHECKS, subjectCompanyName: "Qualified Co", sourceIsFirstParty: true });
  };
  const [config] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));
  const deps: LiveDiscoveryDeps = { searchFn, qualifyFn, extractSubjectsFn };

  const runIdA = await newScanRun();
  const resultA = await attemptLiveDiscovery(config!, territory, runIdA, deps);
  assert.ok(resultA);
  assert.equal(resultA!.stats.prospectsCreated, 1);

  const company = (await db.select().from(companiesTable).where(eq(companiesTable.domain, domain)))[0];
  assert.ok(company, "a qualified candidate must still create a canonical company row exactly as before this fix");
  createdCompanyIds.push(company!.id);
  const prospectsAfterA = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, company!.id));
  assert.equal(prospectsAfterA.length, 1);
  const originalProspectId = prospectsAfterA[0]!.id;

  const evalRows = await db.select().from(discoveryEvaluationsTable).where(eq(discoveryEvaluationsTable.domain, domain));
  assert.equal(evalRows.length, 1, "a qualified outcome must also be recorded, at zero extra identity-resolution cost (its identity was already resolved for persistence)");
  assert.equal(evalRows[0]!.outcome, "qualified");

  // Repeat scan shortly afterward.
  const runIdB = await newScanRun();
  const resultB = await attemptLiveDiscovery(config!, territory, runIdB, deps);
  assert.ok(resultB);
  assert.equal(qualifyCallCount, 1, "qualify() must not be called again for this recently-qualified domain");
  assert.equal(resultB!.stats.prospectsCreated, 0, "no NEW prospect on the repeat scan -- not because it was rejected, but because it's a recently-known, already-fresh company");

  // The original prospect must remain exactly as it was.
  const prospectsAfterB = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, company!.id));
  assert.equal(prospectsAfterB.length, 1, "the previously-qualified prospect must still be visible -- novelty affects qualification-budget allocation only, never persisted product visibility");
  assert.equal(prospectsAfterB[0]!.id, originalProspectId);
});
