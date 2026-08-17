// Phase 11.6.1: Channel Radar recency correctness regression suite.
//
// Originally an INVESTIGATION-ONLY reproduction of the production bug
// ("Radar's 10-day lookback still surfaces year-old articles"). Now a full
// regression suite (scenarios A-N below) proving the fix: NEWS-LIKE query
// families are searched under Tavily's own "news" topic and their results
// are verified against a real publish date before ever being interpreted
// or persisted -- a stale or unverifiable date is rejected, never assumed
// recent. The one genuinely evergreen/directorial family (marketplace_
// listing) is left on its existing honest terms and never subjected to a
// fabricated date.
//
// Root-cause context (corrected pass -- see channelRadarEngine.ts's
// NEWS_LIKE_SIGNAL_TYPES comment for the full classification audit):
// Tavily's own REST API reference documents `published_date` as an
// optional per-result field for topic="news" results (the JS SDK exposes
// the same value as `publishedDate`; this codebase talks to the REST
// endpoint directly, so `published_date` is the real wire field -- see
// discoveryProviders/search.ts). It is optional/best-effort even for news
// results, so a genuine news result can still legitimately omit it; the
// hard rule is unchanged either way -- a missing or unverifiable date is
// never treated as recent (scenario N), only ever admitted when Tavily
// actually supplies one at or after the lookback cutoff (scenario M closes
// the original bug: a real but stale date is rejected too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchViaTavily, type WebSearchResult } from "../src/services/discoveryProviders/search";
import {
  buildRadarQueries,
  computeLookbackStartDate,
  topicForSignalType,
  evaluateNewsRecency,
} from "../src/services/channelRadarEngine";

const originalFetch = globalThis.fetch;
function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// A. Discovery stays "general": its own live-search call site never passes
//    a topic argument at all -- structural, source-text-boundary proof
//    (mirrors this repo's existing convention of asserting on source text
//    where no render harness / DB-free path exists), not just "it happened
//    to default correctly in this one test run."
// ---------------------------------------------------------------------------
test("A: Discovery's live-search call site never passes a topic argument to searchProvider.search (stays topic:general by construction)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("../src/services/discoveryEngine.ts", import.meta.url));
  const source = readFileSync(path, "utf8");
  const callSite = source.match(/searchProvider\.search\([^;]*\);/s);
  assert.ok(callSite, "expected to find Discovery's searchProvider.search call site");
  assert.ok(!callSite![0].includes("topic"), `Discovery's search call must never pass topic -- found: ${callSite![0]}`);
});

// ---------------------------------------------------------------------------
// B / C. topic threading into the actual Tavily request body.
// ---------------------------------------------------------------------------
test("B: searchViaTavily defaults the Tavily request body's topic to 'general' when the caller omits it (Discovery, and Radar's own non-news queries)", async () => {
  let capturedBody: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await searchViaTavily("test-key", "query", { maxResults: 5 });
    assert.equal(capturedBody.topic, "general");
  } finally {
    restoreFetch();
  }
});

test("C: searchViaTavily passes topic:'news' through to the Tavily request body when the caller specifies it (Radar's NEWS-LIKE queries only)", async () => {
  let capturedBody: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await searchViaTavily("test-key", '"Acme" partnership Romania', { maxResults: 3, topic: "news" });
    assert.equal(capturedBody.topic, "news");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// D / E. NEWS-LIKE vs NON-NEWS/WEB SIGNAL classification of every existing
//         signal-type query family -- using only the existing architecture
//         (SIGNAL_TYPE_SEARCH_TERMS' own entries), no invented categories.
// Corrected classification (see channelRadarEngine.ts's NEWS_LIKE_SIGNAL_
// TYPES comment for the full per-family audit): only marketplace_listing
// is genuinely evergreen/directorial. reseller_distributor and
// customer_win were previously misclassified as general merely because an
// evergreen page COULD exist for those terms -- both are dated ecosystem
// moves and get their own explicit tests below (D1/D2), same as event's
// audited query semantics (D3).
// ---------------------------------------------------------------------------
test("D: every NEWS-LIKE signal-type family classifies to topic 'news'", () => {
  const newsLike = [
    "acquisition",
    "partnership",
    "reseller_distributor",
    "regional_expansion",
    "leadership_hire",
    "funding",
    "customer_win",
    "product_gtm",
    "event",
    "other",
  ];
  for (const signalType of newsLike) {
    assert.equal(topicForSignalType(signalType), "news", `expected ${signalType} to classify as news`);
  }
});

test("D1: reseller_distributor classifies as NEWS-LIKE -- a new reseller/distributor/systems-integrator relationship is a dated ecosystem move, not merely a directory listing", () => {
  assert.equal(topicForSignalType("reseller_distributor"), "news");
});

test("D2: customer_win classifies as NEWS-LIKE -- a customer-win announcement is a dated event; 'case study' is one possible result shape, not proof the whole family is evergreen", () => {
  assert.equal(topicForSignalType("customer_win"), "news");
});

test("D3: event classifies as NEWS-LIKE per its actual query wording ('conference OR webinar OR keynote' targets participation/mention of a dated occurrence, not an evergreen events-calendar or listing page)", () => {
  assert.equal(topicForSignalType("event"), "news");
});

test("E: marketplace_listing is the one remaining NON-NEWS/WEB SIGNAL family -- its query text ('marketplace listing OR app store') is structurally directorial, not a dated announcement, and is never subjected to the hard news-date rule", () => {
  assert.equal(topicForSignalType("marketplace_listing"), "general");
});

// ---------------------------------------------------------------------------
// F / G / H. The classification actually reaches buildRadarQueries' output,
//             end to end -- not just the classifier function in isolation.
// ---------------------------------------------------------------------------
test("F: buildRadarQueries assigns topic 'news' to queries built for a NEWS-LIKE signal type", () => {
  const queries = buildRadarQueries(["Acme"], ["acquisition"], "Romania");
  assert.ok(queries.length > 0);
  assert.ok(queries.every((q) => q.topic === "news"));
});

test("G: buildRadarQueries assigns topic 'general' to queries built for a NON-NEWS signal type", () => {
  const queries = buildRadarQueries(["Acme"], ["marketplace_listing"], "Romania");
  assert.ok(queries.length > 0);
  assert.ok(queries.every((q) => q.topic === "general"));
});

test("H: a mixed NEWS-LIKE + NON-NEWS config produces a correctly split set of query topics -- Radar is never globally switched to one mode", () => {
  const queries = buildRadarQueries(["Acme"], ["acquisition", "marketplace_listing"], "Romania");
  const topics = new Set(queries.map((q) => q.topic));
  assert.ok(topics.has("news"), "expected at least one news-topic query for acquisition");
  assert.ok(topics.has("general"), "expected at least one general-topic query for marketplace_listing");
});

// ---------------------------------------------------------------------------
// I / J / K. Publication-date mapping from Tavily's documented
//             `published_date` field (optional/best-effort, populated for
//             topic="news" results) -- valid, missing, and invalid cases.
//             Never guessed from URL/title/content.
// ---------------------------------------------------------------------------
test("I: searchViaTavily maps a real provider-supplied published_date onto publishedAt, normalized to YYYY-MM-DD", async () => {
  mockFetchOnce(200, {
    results: [{ title: "Acme raises Series B", url: "https://example.com/a", content: "...", score: 0.9, published_date: "2026-08-15T10:00:00Z" }],
  });
  try {
    const results = await searchViaTavily("test-key", "Acme funding", { maxResults: 3, topic: "news" });
    assert.equal(results[0]!.publishedAt, "2026-08-15");
  } finally {
    restoreFetch();
  }
});

test("J: searchViaTavily maps a missing published_date to publishedAt: null -- never fabricated, never defaulted to 'today'", async () => {
  mockFetchOnce(200, {
    results: [{ title: "Retrospective", url: "https://example.com/b", content: "...", score: 0.8 }],
  });
  try {
    const results = await searchViaTavily("test-key", "Acme news", { maxResults: 3, topic: "news" });
    assert.equal(results[0]!.publishedAt, null);
  } finally {
    restoreFetch();
  }
});

test("K: searchViaTavily maps an unparseable published_date value to publishedAt: null -- never crashes, never guesses", async () => {
  mockFetchOnce(200, {
    results: [{ title: "Garbage date", url: "https://example.com/c", content: "...", score: 0.5, published_date: "not-a-real-date" }],
  });
  try {
    const results = await searchViaTavily("test-key", "Acme news", { maxResults: 3, topic: "news" });
    assert.equal(results[0]!.publishedAt, null);
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// L / M / N. The hard NEWS-LIKE recency rule itself -- pure and DB-free
//             (evaluateNewsRecency), directly proving the two production
//             failure modes are now closed: a stale article is rejected
//             (M, the original bug), and an unverifiable date is rejected
//             rather than assumed recent (N, the other half of the bug).
// ---------------------------------------------------------------------------
test("L: evaluateNewsRecency admits a news result whose publishedAt is at or after the cutoff", () => {
  const cutoff = computeLookbackStartDate(10, new Date("2026-08-17T00:00:00Z"));
  assert.equal(cutoff, "2026-08-07");
  assert.deepEqual(evaluateNewsRecency("2026-08-07", cutoff), { admit: true });
  assert.deepEqual(evaluateNewsRecency("2026-08-16", cutoff), { admit: true });
});

test("M (the production bug, closed): evaluateNewsRecency rejects a news result whose real publish date is older than the cutoff, as 'stale'", () => {
  const cutoff = computeLookbackStartDate(10, new Date("2026-08-17T00:00:00Z"));
  // The exact reported symptom: a 10-day lookback, but the article is from
  // over a year ago.
  const decision = evaluateNewsRecency("2025-06-01", cutoff);
  assert.deepEqual(decision, { admit: false, reason: "stale" });
});

test("N (the other half of the bug, closed): evaluateNewsRecency rejects a null/unverifiable publishedAt as 'publication-date-unverified' -- never treated as recent", () => {
  const cutoff = computeLookbackStartDate(10, new Date("2026-08-17T00:00:00Z"));
  const decision = evaluateNewsRecency(null, cutoff);
  assert.deepEqual(decision, { admit: false, reason: "publication-date-unverified" });
});

// ---------------------------------------------------------------------------
// Retained from the original investigation: the request-level start_date
// construction was never the bug, and remains correct after this fix.
// ---------------------------------------------------------------------------
test("computeLookbackStartDate still derives a real, correct start_date -- the request-level recency constraint was never the defect", () => {
  const lookbackDays = 10;
  const now = new Date("2026-08-17T00:00:00Z");
  assert.equal(computeLookbackStartDate(lookbackDays, now), "2026-08-07");
});

test("WebSearchResult.score still maps correctly alongside the new publishedAt mapping (no regression to the P3A ranking signal)", async () => {
  mockFetchOnce(200, {
    results: [{ title: "T", url: "https://example.com/d", content: "c", score: 0.42 }],
  });
  try {
    const results: WebSearchResult[] = await searchViaTavily("test-key", "query", { maxResults: 3 });
    assert.equal(results[0]!.score, 0.42);
  } finally {
    restoreFetch();
  }
});
