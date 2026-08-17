// Phase 11.6.1 P3A: pure unit tests for the deterministic, non-semantic
// grouping/ranking/evidence-selection functions in discoveryEngine.ts --
// no network, no DB. See tests/candidateIdentityResolution.test.ts for the
// async identity-resolution stage these build on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkIntoBatches,
  freeFirstPartyDomain,
  groupAnnotatedResults,
  rankCandidateEntries,
  selectEvidenceItems,
  MAX_EVIDENCE_ITEMS_PER_CANDIDATE,
  type AnnotatedResult,
  type CandidateEntry,
} from "../src/services/discoveryEngine";
import { MAX_CANDIDATES_TO_LLM } from "../src/services/discoveryBudget";

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

// ---- chunkIntoBatches -------------------------------------------------------

test("chunkIntoBatches: splits into fixed-size batches, preserving order", () => {
  assert.deepEqual(chunkIntoBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("chunkIntoBatches: empty input produces no batches", () => {
  assert.deepEqual(chunkIntoBatches([], 10), []);
});

// ---- freeFirstPartyDomain / non-corporate guard (F) -----------------------

test("F: freeFirstPartyDomain returns the registrable domain for a resolved, first-party item", () => {
  const r = annotated({ evidenceDomain: "uipath.com", sourceIsFirstParty: true, identityStatus: "resolved", subjectCompanyName: "UiPath" });
  assert.equal(freeFirstPartyDomain(r), "uipath.com");
});

test("F: freeFirstPartyDomain returns null for third-party evidence, even with a confident subject", () => {
  const r = annotated({ evidenceDomain: "reuters.com", sourceIsFirstParty: false, identityStatus: "resolved", subjectCompanyName: "UiPath" });
  assert.equal(freeFirstPartyDomain(r), null);
});

test("F: non-corporate guard remains active -- a known non-corporate domain is never trusted even when marked first-party+resolved", () => {
  const r = annotated({ evidenceDomain: "linkedin.com", sourceIsFirstParty: true, identityStatus: "resolved", subjectCompanyName: "Acme" });
  assert.equal(freeFirstPartyDomain(r), null, "P0's isKnownNonCorporateDomain guard must still block this");
});

test("F: unknown/ambiguous identity status never yields a free first-party domain, even if source_is_first_party is true", () => {
  const unknown = annotated({ evidenceDomain: "acme.example", sourceIsFirstParty: true, identityStatus: "unknown", subjectCompanyName: null });
  const ambiguous = annotated({ evidenceDomain: "acme.example", sourceIsFirstParty: true, identityStatus: "ambiguous", subjectCompanyName: null });
  assert.equal(freeFirstPartyDomain(unknown), null);
  assert.equal(freeFirstPartyDomain(ambiguous), null);
});

// ---- groupAnnotatedResults (F) ---------------------------------------------

test("F: groups strictly by canonicalDomain, never by evidenceDomain/publisher domain", () => {
  const results: AnnotatedResult[] = [
    annotated({ resultId: "0", url: "https://reuters.com/a", evidenceDomain: "reuters.com", canonicalDomain: "uipath.com" }),
    annotated({ resultId: "1", url: "https://reuters.com/b", evidenceDomain: "reuters.com", canonicalDomain: "another-company.com" }),
  ];
  const entries = groupAnnotatedResults(results);
  // Same publisher domain (reuters.com) for both -- but different canonical
  // domains -- must produce two SEPARATE entries, proving publisher domain
  // is never used as the grouping key.
  assert.equal(entries.length, 2);
});

test("F: items with no canonicalDomain become their own standalone entries, never discarded", () => {
  const results: AnnotatedResult[] = [
    annotated({ resultId: "0", canonicalDomain: null }),
    annotated({ resultId: "1", canonicalDomain: null }),
  ];
  const entries = groupAnnotatedResults(results);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.kind === "standalone"));
});

test("F: multiple items sharing the same canonicalDomain form exactly one group", () => {
  const results: AnnotatedResult[] = [
    annotated({ resultId: "0", canonicalDomain: "uipath.com" }),
    annotated({ resultId: "1", canonicalDomain: "uipath.com" }),
    annotated({ resultId: "2", canonicalDomain: "uipath.com" }),
  ];
  const entries = groupAnnotatedResults(results);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "group");
  assert.equal((entries[0] as any).items.length, 3);
});

// ---- rankCandidateEntries (G) ----------------------------------------------

function standaloneEntry(overrides: Partial<AnnotatedResult>): CandidateEntry {
  return { kind: "standalone", item: annotated(overrides) };
}
function groupEntry(items: Partial<AnnotatedResult>[], canonicalDomain = "group.example.com"): CandidateEntry {
  return { kind: "group", canonicalDomain, items: items.map((i) => annotated(i)) };
}

test("G: ranking is deterministic -- the same input always produces the same order", () => {
  const entries = [standaloneEntry({ resultId: "0", score: 0.3 }), standaloneEntry({ resultId: "1", score: 0.9 }), standaloneEntry({ resultId: "2", score: 0.6 })];
  const first = rankCandidateEntries(entries);
  const second = rankCandidateEntries(entries);
  assert.deepEqual(first, second);
});

test("G: Tavily score is used correctly -- higher score ranks first, all else equal", () => {
  const low = standaloneEntry({ resultId: "0", score: 0.2 });
  const high = standaloneEntry({ resultId: "1", score: 0.8 });
  const ranked = rankCandidateEntries([low, high]);
  assert.equal((ranked[0] as any).item.resultId, "1");
});

test("G: stable tiebreak -- equal score falls back to earliest encounter order (lowest resultId)", () => {
  const later = standaloneEntry({ resultId: "5", score: 0.5 });
  const earlier = standaloneEntry({ resultId: "2", score: 0.5 });
  const ranked = rankCandidateEntries([later, earlier]);
  assert.equal((ranked[0] as any).item.resultId, "2");
});

test("G: first-party evidence anywhere in an entry outranks an entry with none, even at a lower score", () => {
  const noFirstParty = standaloneEntry({ resultId: "0", score: 0.95, sourceIsFirstParty: false });
  const hasFirstParty = groupEntry([{ resultId: "1", score: 0.3, sourceIsFirstParty: true }]);
  const ranked = rankCandidateEntries([noFirstParty, hasFirstParty]);
  assert.equal(ranked[0], hasFirstParty);
});

test("G: more evidence items (independent corroboration) outranks fewer, once first-party status is equal", () => {
  const oneItem = groupEntry([{ resultId: "0", score: 0.9, sourceIsFirstParty: false }]);
  const threeItems = groupEntry(
    [
      { resultId: "1", score: 0.5, sourceIsFirstParty: false },
      { resultId: "2", score: 0.5, sourceIsFirstParty: false },
      { resultId: "3", score: 0.5, sourceIsFirstParty: false },
    ],
    "other.example.com",
  );
  const ranked = rankCandidateEntries([oneItem, threeItems]);
  assert.equal(ranked[0], threeItems);
});

test("G: groups and standalone entries rank together in one mixed order, no artificial separation", () => {
  const entries = [
    standaloneEntry({ resultId: "0", score: 0.4 }),
    groupEntry([{ resultId: "1", score: 0.9, sourceIsFirstParty: true }]),
    standaloneEntry({ resultId: "2", score: 0.95 }),
  ];
  const ranked = rankCandidateEntries(entries);
  // The first-party group wins regardless of position/kind in the input.
  assert.equal(ranked[0]!.kind, "group");
});

test("G: top-MAX_CANDIDATES_TO_LLM applies to candidate ENTRIES, not raw URLs -- a 5-URL group still only consumes ONE of the 20 slots", () => {
  const bigGroup = groupEntry(
    Array.from({ length: 5 }, (_, i) => ({ resultId: `g${i}`, score: 0.9, sourceIsFirstParty: i === 0 })),
    "big-company.example.com",
  );
  const standalones = Array.from({ length: MAX_CANDIDATES_TO_LLM + 4 }, (_, i) => standaloneEntry({ resultId: String(i), score: 0.1 }));
  const allEntries = [bigGroup, ...standalones];

  const ranked = rankCandidateEntries(allEntries);
  const selected = ranked.slice(0, MAX_CANDIDATES_TO_LLM);

  assert.equal(selected.length, MAX_CANDIDATES_TO_LLM, "the cap is on entry COUNT, never on how many raw URLs those entries happen to contain");
  assert.ok(selected.includes(bigGroup), "the well-supported group must win a slot ahead of low-scoring standalone items");
  // The group's 5 URLs together still only ever occupied 1 of the 20 slots.
  const totalRawUrlsRepresented = selected.reduce((sum, e) => sum + (e.kind === "group" ? e.items.length : 1), 0);
  assert.ok(totalRawUrlsRepresented > MAX_CANDIDATES_TO_LLM, "sanity check: more raw evidence items are represented than slots spent");
});

// ---- selectEvidenceItems (H) -----------------------------------------------

test("H: selects at most MAX_EVIDENCE_ITEMS_PER_CANDIDATE (3) items", () => {
  const items = Array.from({ length: 6 }, (_, i) => annotated({ resultId: String(i), evidenceDomain: `d${i}.example.com`, score: i }));
  const selected = selectEvidenceItems(items);
  assert.equal(selected.length, MAX_EVIDENCE_ITEMS_PER_CANDIDATE);
});

test("H: prefers the strongest first-party item first", () => {
  const items = [
    annotated({ resultId: "0", evidenceDomain: "weak-fp.example.com", score: 0.2, sourceIsFirstParty: true }),
    annotated({ resultId: "1", evidenceDomain: "strong-fp.example.com", score: 0.9, sourceIsFirstParty: true }),
    annotated({ resultId: "2", evidenceDomain: "third-party.example.com", score: 0.5, sourceIsFirstParty: false }),
  ];
  const selected = selectEvidenceItems(items);
  assert.equal(selected[0]!.resultId, "1", "expected the strongest (highest-score) first-party item to be selected first");
});

test("H: prefers source diversity -- never selects two items from the same domain when a diverse alternative exists", () => {
  const items = [
    annotated({ resultId: "0", evidenceDomain: "reuters.com", score: 0.95 }),
    annotated({ resultId: "1", evidenceDomain: "reuters.com", score: 0.9 }), // second reuters.com item, lower score than item 0 but higher than item 2
    annotated({ resultId: "2", evidenceDomain: "forbes.com", score: 0.3 }),
  ];
  const selected = selectEvidenceItems(items, 2);
  const domains = selected.map((s) => s.evidenceDomain);
  assert.equal(new Set(domains).size, 2, "must prefer the lower-scoring but source-diverse Forbes item over a second same-domain Reuters item");
  assert.ok(domains.includes("forbes.com"));
});

test("H: never pads -- a group with fewer than 3 items returns exactly what's available", () => {
  const items = [annotated({ resultId: "0", evidenceDomain: "only.example.com" })];
  const selected = selectEvidenceItems(items);
  assert.equal(selected.length, 1);
});

test("H: once true source diversity is exhausted, remaining slots fill with the next-best real items rather than staying artificially short", () => {
  // Only one distinct domain exists across 4 items -- no diversity is
  // possible, so up to 3 real items from that one domain should still be
  // selected rather than truncating to 1.
  const items = Array.from({ length: 4 }, (_, i) => annotated({ resultId: String(i), evidenceDomain: "onlydomain.example.com", score: i }));
  const selected = selectEvidenceItems(items);
  assert.equal(selected.length, 3, "no diverse alternative exists, so real same-domain items fill the remaining slots instead of truncating");
});

test("H: standalone candidates (a single item) are unaffected -- selectEvidenceItems on one item returns that one item", () => {
  const items = [annotated({ resultId: "0" })];
  assert.deepEqual(selectEvidenceItems(items), items);
});
