// Phase 11.6.1 P3A: pure/injected unit tests for resolveCandidateIdentities
// -- the pre-qualification pipeline stage that turns raw eligible results
// into company-level candidate identities WITHOUT any name-only grouping.
// No live network, no DB: both aiProvider.extractSubjects and the
// identity-resolution call are injected, same convention as
// tests/discoveryIdentity.test.ts's injected resolveIdentity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCandidateIdentities,
  groupAnnotatedResults,
  CONTEXTUAL_RESOLUTION_MAX_K,
  SUBJECT_EXTRACTION_BATCH_SIZE,
  type EligibleResult,
} from "../src/services/discoveryEngine";
import type { SubjectExtractionBatchInput, SubjectExtractionResult, SubjectIdentityStatus } from "../src/services/discoveryProviders/ai";

function eligibleResult(overrides: Partial<EligibleResult>): EligibleResult {
  return {
    resultId: "0",
    url: "https://example.com/a",
    title: "Example",
    snippet: "Example snippet",
    publishedAt: null,
    score: 0.5,
    evidenceDomain: "example.com",
    text: "Example text",
    ...overrides,
  };
}

function extraction(resultId: string, subjectCompanyName: string | null, sourceIsFirstParty: boolean, identityStatus: SubjectIdentityStatus): SubjectExtractionResult {
  return { resultId, subjectCompanyName, sourceIsFirstParty, identityStatus };
}

// ---- B: same company, multiple sources (first-party + two third-party) ---

test("B: uipath.com (first-party) + Reuters + Microsoft-hosted article all about UiPath -> one candidate group, source provenance retained, only the two third-party items spend a resolution call", async () => {
  const items: EligibleResult[] = [
    eligibleResult({ resultId: "0", url: "https://uipath.com/company", evidenceDomain: "uipath.com", score: 0.9 }),
    eligibleResult({ resultId: "1", url: "https://reuters.com/article-1", evidenceDomain: "reuters.com", score: 0.7 }),
    eligibleResult({ resultId: "2", url: "https://microsoft.com/partners/uipath", evidenceDomain: "microsoft.com", score: 0.6 }),
  ];

  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) =>
    input.candidates.map((c) =>
      c.resultId === "0" ? extraction("0", "UiPath", true, "resolved") : extraction(c.resultId, "UiPath", false, "resolved"),
    );

  const resolveCalls: string[] = [];
  const resolveIdentityWithContext = async (_name: string, context: { evidenceUrl?: string }) => {
    resolveCalls.push(context.evidenceUrl!);
    return { name: "UiPath", domain: "uipath.com" };
  };

  const { results, summary } = await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);
  const entries = groupAnnotatedResults(results);

  assert.equal(entries.length, 1, "expected exactly one candidate entry");
  assert.equal(entries[0]!.kind, "group");
  const group = entries[0] as Extract<typeof entries[0], { kind: "group" }>;
  assert.equal(group.canonicalDomain, "uipath.com");
  assert.equal(group.items.length, 3, "all three items must be in the same group");
  assert.deepEqual(
    group.items.map((i) => i.url).sort(),
    ["https://microsoft.com/partners/uipath", "https://reuters.com/article-1", "https://uipath.com/company"],
    "source provenance (each item's own url) must remain attached to every evidence item",
  );

  // The first-party item established the domain for free -- only the two
  // third-party items should have spent an external resolution call.
  assert.equal(resolveCalls.length, 2);
  assert.deepEqual(resolveCalls.sort(), ["https://microsoft.com/partners/uipath", "https://reuters.com/article-1"].sort());
  assert.equal(summary.freeFirstPartyResolutions, 1);
  assert.equal(summary.contextualResolutionAttempted, 2);
  assert.equal(summary.contextualResolutionSucceeded, 2);
});

// ---- C: same company, two third-party sources, no first-party item -------

test("C: Reuters + Forbes both about UiPath, no first-party item -> each independently resolves -> one group once both agree on the same canonical domain", async () => {
  const items: EligibleResult[] = [
    eligibleResult({ resultId: "0", url: "https://reuters.com/uipath-1", evidenceDomain: "reuters.com", score: 0.8 }),
    eligibleResult({ resultId: "1", url: "https://forbes.com/uipath-2", evidenceDomain: "forbes.com", score: 0.75 }),
  ];

  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) =>
    input.candidates.map((c) => extraction(c.resultId, "UiPath", false, "resolved"));

  const resolveCalls: Array<{ url: string; snippet: string | undefined }> = [];
  const resolveIdentityWithContext = async (_name: string, context: { evidenceUrl?: string; evidenceSnippet?: string }) => {
    resolveCalls.push({ url: context.evidenceUrl!, snippet: context.evidenceSnippet });
    return { name: "UiPath", domain: "uipath.com" }; // both independently agree
  };

  const { results } = await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);
  const entries = groupAnnotatedResults(results);

  assert.equal(entries.length, 1);
  assert.equal((entries[0] as any).canonicalDomain, "uipath.com");
  assert.equal((entries[0] as any).items.length, 2);

  // Two INDEPENDENT resolution calls, never one shared/cached-by-name call.
  assert.equal(resolveCalls.length, 2, "each third-party item must trigger its OWN resolution call, never reused across items by name");
  assert.deepEqual(resolveCalls.map((c) => c.url).sort(), ["https://forbes.com/uipath-2", "https://reuters.com/uipath-1"].sort());
});

// ---- D: same-name unrelated companies -- never merged by name alone ------

test("D: two different real companies both extracted as 'Apex Consulting' -- independent, context-aware resolution keeps them as two separate groups, never merged by name", async () => {
  const items: EligibleResult[] = [
    eligibleResult({ resultId: "0", url: "https://romanianews.example/apex-ro", evidenceDomain: "romanianews.example", score: 0.6 }),
    eligibleResult({ resultId: "1", url: "https://uknews.example/apex-uk", evidenceDomain: "uknews.example", score: 0.6 }),
  ];

  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) =>
    input.candidates.map((c) => extraction(c.resultId, "Apex Consulting", false, "resolved"));

  // Each resolution independently uses ITS OWN evidence context to pick a
  // DIFFERENT real company -- exactly the fix this design requires.
  const resolveIdentityWithContext = async (_name: string, context: { evidenceUrl?: string }) => {
    if (context.evidenceUrl?.includes("romanianews")) return { name: "Apex Consulting SRL", domain: "apexconsulting.ro" };
    if (context.evidenceUrl?.includes("uknews")) return { name: "Apex Consulting Ltd", domain: "apexconsulting.co.uk" };
    return null;
  };

  const { results } = await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);
  const entries = groupAnnotatedResults(results);

  assert.equal(entries.length, 2, "must form two SEPARATE candidate entries, never one merged-by-name group");
  const domains = entries.map((e) => (e.kind === "group" ? e.canonicalDomain : null)).sort();
  assert.deepEqual(domains, ["apexconsulting.co.uk", "apexconsulting.ro"]);
});

test("D: same-name companies where resolution cannot confidently distinguish them -- both stay standalone/unresolved, never merged as a fallback", async () => {
  const items: EligibleResult[] = [
    eligibleResult({ resultId: "0", url: "https://news-a.example/apex", evidenceDomain: "news-a.example", score: 0.6 }),
    eligibleResult({ resultId: "1", url: "https://news-b.example/apex", evidenceDomain: "news-b.example", score: 0.6 }),
  ];

  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) =>
    input.candidates.map((c) => extraction(c.resultId, "Apex Consulting", false, "resolved"));

  // Resolver honestly can't tell them apart from the given context -- returns
  // unresolved for both, exactly as identifyCompanyViaDeepSeek's own
  // "respond resolved: false rather than guessing" rule specifies.
  const resolveIdentityWithContext = async () => null;

  const { results, summary } = await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);
  const entries = groupAnnotatedResults(results);

  assert.equal(entries.length, 2, "both must remain standalone -- never merged just because the extracted name matched");
  assert.ok(entries.every((e) => e.kind === "standalone"));
  assert.equal(summary.contextualResolutionFailed, 2);
});

// ---- E: unknown/ambiguous evidence remains standalone, never resolved ----

test("E: unknown-identity evidence never triggers a resolution call and remains a standalone candidate entry", async () => {
  const items: EligibleResult[] = [eligibleResult({ resultId: "0", url: "https://blog.example/post", evidenceDomain: "blog.example" })];
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) => input.candidates.map((c) => extraction(c.resultId, null, false, "unknown"));

  let resolveCalled = false;
  const resolveIdentityWithContext = async () => {
    resolveCalled = true;
    return null;
  };

  const { results } = await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);
  const entries = groupAnnotatedResults(results);

  assert.equal(resolveCalled, false, "an unknown-identity item must never spend an external resolution call");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "standalone");
});

test("E: ambiguous multi-subject evidence also never triggers a resolution call and remains standalone", async () => {
  const items: EligibleResult[] = [eligibleResult({ resultId: "0", url: "https://analyst.example/listicle", evidenceDomain: "analyst.example" })];
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) => input.candidates.map((c) => extraction(c.resultId, null, false, "ambiguous"));

  let resolveCalled = false;
  const resolveIdentityWithContext = async () => {
    resolveCalled = true;
    return null;
  };

  const { results } = await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);
  const entries = groupAnnotatedResults(results);

  assert.equal(resolveCalled, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "standalone");
});

// ---- J: cost bounds -- K cap and batch size are actually enforced --------

test("J: contextual resolution never exceeds CONTEXTUAL_RESOLUTION_MAX_K calls, even with far more unresolved candidates", async () => {
  const count = CONTEXTUAL_RESOLUTION_MAX_K + 8;
  const items: EligibleResult[] = Array.from({ length: count }, (_, i) =>
    eligibleResult({ resultId: String(i), url: `https://news.example/co-${i}`, evidenceDomain: "news.example", score: i }),
  );
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) =>
    input.candidates.map((c) => extraction(c.resultId, `Company ${c.resultId}`, false, "resolved"));

  let resolveCallCount = 0;
  const resolveIdentityWithContext = async (name: string) => {
    resolveCallCount++;
    return { name, domain: `${name.toLowerCase().replace(/\s+/g, "")}.example.com` };
  };

  const { summary } = await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);

  assert.equal(resolveCallCount, CONTEXTUAL_RESOLUTION_MAX_K, "external resolution must never exceed the hard K cap");
  assert.equal(summary.contextualResolutionAttempted, CONTEXTUAL_RESOLUTION_MAX_K);
});

test("J: the K-capped resolution slots go to the HIGHEST-scored unresolved items first, never an arbitrary subset", async () => {
  const count = CONTEXTUAL_RESOLUTION_MAX_K + 3;
  const items: EligibleResult[] = Array.from({ length: count }, (_, i) =>
    eligibleResult({ resultId: String(i), url: `https://news.example/co-${i}`, evidenceDomain: "news.example", score: i }), // ascending score by index
  );
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) =>
    input.candidates.map((c) => extraction(c.resultId, `Company ${c.resultId}`, false, "resolved"));

  const resolvedUrls: string[] = [];
  const resolveIdentityWithContext = async (name: string, context: { evidenceUrl?: string }) => {
    resolvedUrls.push(context.evidenceUrl!);
    return { name, domain: `${name.toLowerCase().replace(/\s+/g, "")}.example.com` };
  };

  await resolveCandidateIdentities(items, [], resolveIdentityWithContext, extractSubjectsFn);

  // Highest-index items have the highest score -- the top CONTEXTUAL_RESOLUTION_MAX_K by score must be exactly the last K result_ids.
  const expectedTopIds = Array.from({ length: CONTEXTUAL_RESOLUTION_MAX_K }, (_, i) => count - 1 - i);
  const expectedTopUrls = expectedTopIds.map((id) => `https://news.example/co-${id}`).sort();
  assert.deepEqual(resolvedUrls.sort(), expectedTopUrls);
});

test("J: subject-extraction batching is bounded to SUBJECT_EXTRACTION_BATCH_SIZE per call", async () => {
  const count = SUBJECT_EXTRACTION_BATCH_SIZE + 5;
  const items: EligibleResult[] = Array.from({ length: count }, (_, i) => eligibleResult({ resultId: String(i), url: `https://x.example/${i}` }));

  const batchSizes: number[] = [];
  const extractSubjectsFn = async (input: SubjectExtractionBatchInput) => {
    batchSizes.push(input.candidates.length);
    return input.candidates.map((c) => extraction(c.resultId, null, false, "unknown"));
  };

  await resolveCandidateIdentities(items, [], async () => null, extractSubjectsFn);

  assert.deepEqual(batchSizes, [SUBJECT_EXTRACTION_BATCH_SIZE, 5]);
});

test("J: a failed subject-extraction batch degrades that batch's items to standalone/unknown, never aborts the whole identity stage", async () => {
  const items: EligibleResult[] = [eligibleResult({ resultId: "0", url: "https://example.com/a" })];
  const extractSubjectsFn = async (): Promise<SubjectExtractionResult[]> => {
    throw new Error("simulated provider outage");
  };

  const { results, summary } = await resolveCandidateIdentities(items, [], async () => null, extractSubjectsFn);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.identityStatus, "unknown");
  assert.equal(results[0]!.canonicalDomain, null);
  assert.equal(summary.subjectExtractionUnknown, 1);
});
