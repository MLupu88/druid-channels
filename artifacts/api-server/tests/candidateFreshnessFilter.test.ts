// Partner Radar recall fix (novelty prioritization): pure unit tests for
// filterRecentlyEvaluatedEntries (discoveryEngine.ts) -- no network, no DB.
// This is the function that decides which ranked candidate ENTRIES get
// skipped before spending one of the MAX_CANDIDATES_TO_LLM qualification
// slots on them, because their canonical domain was already evaluated
// (qualified or rejected) recently. See candidateGroupingRanking.test.ts for
// grouping/ranking itself, which this builds on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterRecentlyEvaluatedEntries, type AnnotatedResult, type CandidateEntry } from "../src/services/discoveryEngine";
import type { ExistingQualificationRecord } from "../src/services/discoveryBudget";

function annotated(overrides: Partial<AnnotatedResult>): AnnotatedResult {
  return {
    resultId: "0",
    url: "https://example.com/a",
    title: "Example",
    snippet: "snippet",
    publishedAt: null,
    score: 0.5,
    evidenceDomain: "example.com",
    text: "text",
    subjectCompanyName: null,
    sourceIsFirstParty: false,
    identityStatus: "unknown",
    canonicalDomain: null,
    ...overrides,
  };
}

function standaloneEntry(overrides: Partial<AnnotatedResult>): CandidateEntry {
  return { kind: "standalone", item: annotated(overrides) };
}
function groupEntry(canonicalDomain: string, items: Partial<AnnotatedResult>[] = [{}]): CandidateEntry {
  return { kind: "group", canonicalDomain, items: items.map((i) => annotated(i)) };
}

function recordAt(daysAgo: number, now = new Date("2026-08-18T00:00:00.000Z")): ExistingQualificationRecord {
  return { lastResearchedAt: new Date(now.getTime() - daysAgo * 86_400_000), createdAt: new Date(now.getTime() - daysAgo * 86_400_000) };
}

const RECENCY_WINDOW_DAYS = 90;

// ---- basic skip behavior ----------------------------------------------------

test("a group entry with a fresh (within-window) record is skipped, never reaches freshEntries", () => {
  const entries = [groupEntry("fresh.example.com")];
  const known = new Map([["fresh.example.com", recordAt(5)]]);
  const result = filterRecentlyEvaluatedEntries(entries, known, RECENCY_WINDOW_DAYS);
  assert.equal(result.freshEntries.length, 0);
  assert.equal(result.skippedRecentCount, 1);
});

test("a group entry with NO known record at all is never skipped -- genuinely novel", () => {
  const entries = [groupEntry("unknown.example.com")];
  const result = filterRecentlyEvaluatedEntries(entries, new Map(), RECENCY_WINDOW_DAYS);
  assert.equal(result.freshEntries.length, 1);
  assert.equal(result.skippedRecentCount, 0);
});

test("a stale evaluation (outside the recency window) becomes eligible again -- not skipped", () => {
  const entries = [groupEntry("stale.example.com")];
  const known = new Map([["stale.example.com", recordAt(120)]]); // older than the 90-day window
  const result = filterRecentlyEvaluatedEntries(entries, known, RECENCY_WINDOW_DAYS);
  assert.equal(result.freshEntries.length, 1);
  assert.equal(result.skippedRecentCount, 0);
});

// ---- standalone entries are never filtered ---------------------------------

test("a standalone entry is never filtered, even if its (irrelevant, non-canonical) evidence domain happens to match a fresh record -- standalone has no canonical domain to check", () => {
  const entries = [standaloneEntry({ evidenceDomain: "fresh.example.com" })];
  const known = new Map([["fresh.example.com", recordAt(5)]]);
  const result = filterRecentlyEvaluatedEntries(entries, known, RECENCY_WINDOW_DAYS);
  assert.equal(result.freshEntries.length, 1, "standalone entries always pass through unfiltered");
  assert.equal(result.skippedRecentCount, 0);
});

// ---- the documented example: 15 recent + N fresh ---------------------------

test("example: 15 recently-evaluated group entries ranked ahead of 60 fresh ones -- all 15 are skipped, all 60 fresh ones survive filtering (the 50-cap is a separate, later step)", () => {
  const known = new Map<string, ExistingQualificationRecord>();
  const recentEntries: CandidateEntry[] = [];
  for (let i = 0; i < 15; i++) {
    const domain = `recent-${i}.example.com`;
    known.set(domain, recordAt(1));
    recentEntries.push(groupEntry(domain));
  }
  const freshOnes: CandidateEntry[] = [];
  for (let i = 0; i < 60; i++) {
    freshOnes.push(groupEntry(`fresh-${i}.example.com`));
  }
  const ranked = [...recentEntries, ...freshOnes]; // recent ones ranked first, as in the task's example
  const result = filterRecentlyEvaluatedEntries(ranked, known, RECENCY_WINDOW_DAYS);
  assert.equal(result.skippedRecentCount, 15);
  assert.equal(result.freshEntries.length, 60);
  // Slicing to a 50-candidate cap AFTER this filter (the caller's job, not
  // this function's) would then select exactly 50 fresh candidates -- see
  // attemptLiveDiscoveryPipeline.test.ts for the end-to-end version.
  assert.equal(result.freshEntries.slice(0, 50).length, 50);
});

// ---- order preservation -----------------------------------------------------

test("ranking order among surviving (fresh) entries is preserved exactly -- filtering never re-sorts", () => {
  const known = new Map([["skip-me.example.com", recordAt(1)]]);
  const ranked = [groupEntry("first.example.com"), groupEntry("skip-me.example.com"), groupEntry("second.example.com"), standaloneEntry({ resultId: "9" }), groupEntry("third.example.com")];
  const result = filterRecentlyEvaluatedEntries(ranked, known, RECENCY_WINDOW_DAYS);
  // The relative order of survivors matches their relative order in the
  // input, with only "skip-me" removed -- filtering never re-sorts.
  assert.deepEqual(
    result.freshEntries.map((e) => (e.kind === "group" ? e.canonicalDomain : "standalone-9")),
    ["first.example.com", "second.example.com", "standalone-9", "third.example.com"],
  );
});

// ---- empty input --------------------------------------------------------------

test("empty entries list returns empty freshEntries and zero skipped", () => {
  const result = filterRecentlyEvaluatedEntries([], new Map(), RECENCY_WINDOW_DAYS);
  assert.deepEqual(result.freshEntries, []);
  assert.equal(result.skippedRecentCount, 0);
});
