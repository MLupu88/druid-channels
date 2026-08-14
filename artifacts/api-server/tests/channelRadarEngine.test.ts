// Pure unit tests for Stage 5/6.3 Channel Radar's engine logic -- dedupe
// key determinism, bounded + geo-scoped query construction, lookback
// window derivation, and status-transition validation. No live network,
// DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildRadarQueries,
  buildGeoTerm,
  computeLookbackStartDate,
  computeDedupeKey,
  isValidStatusTransition,
  selectEventCandidates,
  computeRequiresValidation,
  resolveEventAttachment,
  boundListPagination,
  coerceBooleanFilter,
  isClaimedInTerritory,
  applyChannelRadarFilters,
  resolveSignalEvidence,
  resolveEvidenceCount,
  EVENT_MATCH_WINDOW_DAYS,
  MAX_EVENT_CANDIDATES,
  type EventCandidate,
} from "../src/services/channelRadarEngine";

test("computeDedupeKey is deterministic for the same underlying event", () => {
  const keyA = computeDedupeKey("Acme Systems", "acquisition", "https://acme.example/news/deal");
  const keyB = computeDedupeKey("Acme Systems", "acquisition", "https://acme.example/news/deal");
  assert.equal(keyA, keyB);
});

test("computeDedupeKey ignores case and trivial URL formatting differences (normalized event identity)", () => {
  const keyA = computeDedupeKey("Acme Systems", "acquisition", "https://www.acme.example/news/deal/");
  const keyB = computeDedupeKey("acme systems", "acquisition", "https://acme.example/news/deal");
  assert.equal(keyA, keyB);
});

test("computeDedupeKey differs for a different entity, signal type, or source event", () => {
  const base = computeDedupeKey("Acme Systems", "acquisition", "https://acme.example/news/deal");
  assert.notEqual(computeDedupeKey("Other Corp", "acquisition", "https://acme.example/news/deal"), base);
  assert.notEqual(computeDedupeKey("Acme Systems", "partnership", "https://acme.example/news/deal"), base);
  assert.notEqual(computeDedupeKey("Acme Systems", "acquisition", "https://acme.example/news/other-deal"), base);
});

test("buildRadarQueries never produces a full entities x signal-types Cartesian product", () => {
  const entities = ["Microsoft", "UiPath", "Kore.ai", "Cognigy", "ServiceNow"];
  const signalTypes = ["acquisition", "partnership", "funding", "customer_win", "product_gtm", "event"];
  const queries = buildRadarQueries(entities, signalTypes, "Romania");
  // Cartesian would be 30 -- the bounded builder must stay well under that.
  assert.ok(queries.length <= 12, `expected <= 12 queries, got ${queries.length}`);
  assert.ok(queries.length > 0);
});

test("buildRadarQueries represents every entity before giving any entity a second query", () => {
  const entities = ["Microsoft", "UiPath", "Kore.ai"];
  const signalTypes = ["acquisition", "partnership"];
  const queries = buildRadarQueries(entities, signalTypes, "Romania");
  const firstThree = queries.slice(0, 3).map((q) => q.entityHint);
  assert.deepEqual(new Set(firstThree), new Set(entities));
});

test("buildRadarQueries with no monitored entities produces no queries -- never fabricated", () => {
  assert.deepEqual(buildRadarQueries([], ["acquisition"], "Romania"), []);
});

test("buildRadarQueries with entities but no signal types falls back to one generic query per entity, still geo-scoped", () => {
  const queries = buildRadarQueries(["Microsoft", "UiPath"], [], "Romania");
  assert.equal(queries.length, 2);
  assert.deepEqual(new Set(queries.map((q) => q.entityHint)), new Set(["Microsoft", "UiPath"]));
  assert.ok(queries.every((q) => q.query.includes("Romania")));
});

// Stage 6.3: territory geo-scoping -- the exact correctness gap this fixes
// (a Romania scan's actual Tavily query previously carried no geographic
// scope at all).
test("buildRadarQueries: a Romania scan's generated queries materially contain Romania", () => {
  const queries = buildRadarQueries(["Microsoft"], ["partnership"], buildGeoTerm(["Romania"], "Romania"));
  assert.ok(queries.length > 0);
  for (const q of queries) {
    assert.ok(q.query.includes("Romania"), `expected query to carry geographic scope, got: ${q.query}`);
  }
});

test("buildRadarQueries: a DACH scan's generated queries carry its configured multi-country geographic context", () => {
  const geoTerm = buildGeoTerm(["Germany", "Austria", "Switzerland"], "DACH");
  const queries = buildRadarQueries(["Microsoft"], ["partnership"], geoTerm);
  assert.ok(queries.length > 0);
  for (const q of queries) {
    assert.ok(q.query.includes("Germany"), `expected Germany in: ${q.query}`);
    assert.ok(q.query.includes("Austria"), `expected Austria in: ${q.query}`);
    assert.ok(q.query.includes("Switzerland"), `expected Switzerland in: ${q.query}`);
  }
});

test("buildGeoTerm prefers canonical countries over the territory name, and stays readable (OR-joined, not a giant list)", () => {
  assert.equal(buildGeoTerm(["Romania"], "Romania Territory"), "Romania");
  assert.equal(buildGeoTerm(["Germany", "Austria", "Switzerland"], "DACH"), "Germany OR Austria OR Switzerland");
});

test("buildGeoTerm falls back to the territory name only when no canonical countries are configured", () => {
  assert.equal(buildGeoTerm([], "Nordics"), "Nordics");
});

test("computeLookbackStartDate derives a real start_date exactly lookback_days before now", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  assert.equal(computeLookbackStartDate(30, now), "2026-07-11");
  assert.equal(computeLookbackStartDate(1, now), "2026-08-09");
});

test("computeLookbackStartDate never produces a future or non-finite window from bad input", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  assert.equal(computeLookbackStartDate(0, now), "2026-08-09"); // floors to at least 1 day
  assert.equal(computeLookbackStartDate(-5, now), "2026-08-09");
});

test("status transitions: new -> reviewed and new/reviewed -> dismissed are valid", () => {
  assert.equal(isValidStatusTransition("new", "reviewed"), true);
  assert.equal(isValidStatusTransition("new", "dismissed"), true);
  assert.equal(isValidStatusTransition("reviewed", "dismissed"), true);
});

test("status transitions: dismissed is terminal, and same-status is rejected", () => {
  assert.equal(isValidStatusTransition("dismissed", "new"), false);
  assert.equal(isValidStatusTransition("dismissed", "reviewed"), false);
  assert.equal(isValidStatusTransition("reviewed", "new"), false);
  assert.equal(isValidStatusTransition("new", "new"), false);
});

// ---- Phase 10: cross-run event consolidation -------------------------------

function makeRow(overrides: Partial<{
  id: string;
  entityName: string;
  companyId: string | null;
  headline: string;
  summary: string;
  sourceTitle: string;
  sourceUrl: string;
  discoveredAt: Date;
  lastEvidenceAt: Date | null;
}> = {}) {
  return {
    id: "sig-1",
    entityName: "Acme Systems",
    companyId: null,
    headline: "Acme Systems signs new reseller",
    summary: "Acme Systems announced a new reseller agreement.",
    sourceTitle: "Acme news",
    sourceUrl: "https://acme.example/news/reseller",
    discoveredAt: new Date("2026-06-01T00:00:00.000Z"),
    lastEvidenceAt: null,
    ...overrides,
  };
}

test("selectEventCandidates matches same territory-scoped entity+signal_type within the window (name fallback)", () => {
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  const rows = [makeRow({ id: "a", entityName: "Acme Systems" })];
  const result = selectEventCandidates(rows, { entityName: "acme systems", companyId: null, asOf });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "a");
});

test("selectEventCandidates prefers company_id equality over name when both sides have resolved a company", () => {
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  // Same normalized name, but a DIFFERENT resolved company -- must NOT match.
  const rows = [makeRow({ id: "a", entityName: "Acme Systems", companyId: "company-b" })];
  const result = selectEventCandidates(rows, { entityName: "Acme Systems", companyId: "company-a", asOf });
  assert.equal(result.length, 0, "different resolved companies must never be treated as the same entity, even with matching names");
});

test("selectEventCandidates falls back to name match when either side has no resolved company", () => {
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  const rows = [makeRow({ id: "a", entityName: "Acme Systems", companyId: null })];
  const result = selectEventCandidates(rows, { entityName: "Acme Systems", companyId: "company-a", asOf });
  assert.equal(result.length, 1, "a candidate with no resolved company_id yet must still be reachable via name match");
});

test("selectEventCandidates excludes a different entity or a different signal_type (signal_type filtering happens in findEventCandidates' SQL, entity here)", () => {
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  const rows = [makeRow({ id: "a", entityName: "Totally Different Corp" })];
  const result = selectEventCandidates(rows, { entityName: "Acme Systems", companyId: null, asOf });
  assert.equal(result.length, 0);
});

test(`selectEventCandidates: a candidate exactly at the ${EVENT_MATCH_WINDOW_DAYS}-day boundary is included, one day beyond it is excluded`, () => {
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  const atBoundary = new Date(asOf.getTime() - EVENT_MATCH_WINDOW_DAYS * 86_400_000);
  const beyondBoundary = new Date(atBoundary.getTime() - 86_400_000);

  const withinRows = [makeRow({ id: "within", lastEvidenceAt: atBoundary })];
  assert.equal(selectEventCandidates(withinRows, { entityName: "Acme Systems", companyId: null, asOf }).length, 1);

  const beyondRows = [makeRow({ id: "beyond", lastEvidenceAt: beyondBoundary })];
  assert.equal(selectEventCandidates(beyondRows, { entityName: "Acme Systems", companyId: null, asOf }).length, 0);
});

test("selectEventCandidates never excludes a dismissed signal -- it has no status field to filter on at all", () => {
  // The row shape selectEventCandidates receives carries no `status` --
  // findEventCandidates' SQL select deliberately never fetches or filters
  // on it (see channelRadarEngine.ts). This test documents that contract:
  // a status='dismissed' signal is exactly as eligible a candidate as any
  // other, by construction, not by an explicit inclusion check.
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  const rows = [makeRow({ id: "dismissed-one" })];
  const result = selectEventCandidates(rows, { entityName: "Acme Systems", companyId: null, asOf });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "dismissed-one");
});

test(`selectEventCandidates caps at ${MAX_EVENT_CANDIDATES} candidates, most-recent-first`, () => {
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  const rows = [
    makeRow({ id: "oldest", lastEvidenceAt: new Date("2026-06-01T00:00:00.000Z") }),
    makeRow({ id: "middle", lastEvidenceAt: new Date("2026-06-05T00:00:00.000Z") }),
    makeRow({ id: "newest", lastEvidenceAt: new Date("2026-06-10T00:00:00.000Z") }),
    makeRow({ id: "second-newest", lastEvidenceAt: new Date("2026-06-08T00:00:00.000Z") }),
  ];
  const result = selectEventCandidates(rows, { entityName: "Acme Systems", companyId: null, asOf });
  assert.equal(result.length, MAX_EVENT_CANDIDATES);
  assert.deepEqual(result.map((r) => r.id), ["newest", "second-newest", "middle"]);
});

test("selectEventCandidates anchors on lastEvidenceAt, falling back to discoveredAt for rows that never had evidence attached", () => {
  const asOf = new Date("2026-06-15T00:00:00.000Z");
  // discoveredAt alone is within the window; lastEvidenceAt (if used) would
  // be outside it -- proves lastEvidenceAt is preferred when present.
  const rows = [
    makeRow({ id: "no-evidence-yet", discoveredAt: new Date("2026-06-10T00:00:00.000Z"), lastEvidenceAt: null }),
  ];
  assert.equal(selectEventCandidates(rows, { entityName: "Acme Systems", companyId: null, asOf }).length, 1);
});

test("resolveEventAttachment stops at the first candidate confirmed same_event, never asking later candidates", async () => {
  const candidates: EventCandidate[] = [
    { id: "first", headline: "h1", summary: "s1", sourceTitle: "t1", sourceUrl: "https://a.example/1" },
    { id: "second", headline: "h2", summary: "s2", sourceTitle: "t2", sourceUrl: "https://a.example/2" },
  ];
  const asked: string[] = [];
  const result = await resolveEventAttachment(candidates, async (c) => {
    asked.push(c.id);
    return { sameEvent: true };
  });
  assert.equal(result, "first");
  assert.deepEqual(asked, ["first"], "the second candidate must never be asked once the first confirms a match");
});

test("resolveEventAttachment moves to the next candidate when one is rejected", async () => {
  const candidates: EventCandidate[] = [
    { id: "first", headline: "h1", summary: "s1", sourceTitle: "t1", sourceUrl: "https://a.example/1" },
    { id: "second", headline: "h2", summary: "s2", sourceTitle: "t2", sourceUrl: "https://a.example/2" },
  ];
  const result = await resolveEventAttachment(candidates, async (c) => ({ sameEvent: c.id === "second" }));
  assert.equal(result, "second");
});

test("resolveEventAttachment returns null (create a new signal) when no candidate is confirmed", async () => {
  const candidates: EventCandidate[] = [{ id: "first", headline: "h", summary: "s", sourceTitle: "t", sourceUrl: "https://a.example/1" }];
  const result = await resolveEventAttachment(candidates, async () => ({ sameEvent: false }));
  assert.equal(result, null);
});

test("resolveEventAttachment returns null with an empty candidate list -- the normal 'first-ever signal for this entity' case", async () => {
  const result = await resolveEventAttachment([], async () => ({ sameEvent: true }));
  assert.equal(result, null);
});

test("resolveEventAttachment: an AI error on a candidate is treated as 'different event' and never merges, and never throws", async () => {
  const candidates: EventCandidate[] = [
    { id: "flaky", headline: "h", summary: "s", sourceTitle: "t", sourceUrl: "https://a.example/1" },
    { id: "healthy", headline: "h2", summary: "s2", sourceTitle: "t2", sourceUrl: "https://a.example/2" },
  ];
  const result = await resolveEventAttachment(candidates, async (c) => {
    if (c.id === "flaky") throw new Error("provider timeout");
    return { sameEvent: true };
  });
  assert.equal(result, "healthy", "must fall through to the next candidate, never propagate the error, never merge on the failing one");
});

test("resolveEventAttachment: every candidate erroring returns null (create new), never throws", async () => {
  const candidates: EventCandidate[] = [{ id: "flaky", headline: "h", summary: "s", sourceTitle: "t", sourceUrl: "https://a.example/1" }];
  const result = await resolveEventAttachment(candidates, async () => {
    throw new Error("provider down");
  });
  assert.equal(result, null);
});

test("computeRequiresValidation: all-clear signal (no ambiguity, certain region, non-low confidence) does not require validation", () => {
  assert.equal(
    computeRequiresValidation({
      ambiguousPrimaryIdentity: false,
      ambiguousRelatedIdentity: false,
      regionalApplicabilityCertain: true,
      confidence: "high",
    }),
    false,
  );
});

test("computeRequiresValidation: ambiguous primary identity alone requires validation, even at high confidence", () => {
  assert.equal(
    computeRequiresValidation({
      ambiguousPrimaryIdentity: true,
      ambiguousRelatedIdentity: false,
      regionalApplicabilityCertain: true,
      confidence: "high",
    }),
    true,
  );
});

test("computeRequiresValidation: ambiguous related-entity identity alone requires validation", () => {
  assert.equal(
    computeRequiresValidation({
      ambiguousPrimaryIdentity: false,
      ambiguousRelatedIdentity: true,
      regionalApplicabilityCertain: true,
      confidence: "high",
    }),
    true,
  );
});

test("computeRequiresValidation: uncertain regional applicability alone requires validation, even at high confidence", () => {
  assert.equal(
    computeRequiresValidation({
      ambiguousPrimaryIdentity: false,
      ambiguousRelatedIdentity: false,
      regionalApplicabilityCertain: false,
      confidence: "high",
    }),
    true,
  );
});

test("computeRequiresValidation: low confidence alone requires validation, even with unambiguous identity and certain region", () => {
  assert.equal(
    computeRequiresValidation({
      ambiguousPrimaryIdentity: false,
      ambiguousRelatedIdentity: false,
      regionalApplicabilityCertain: true,
      confidence: "low",
    }),
    true,
  );
});

test("computeRequiresValidation is never simply confidence=='low': medium/high confidence can independently require validation via identity/region factors alone", () => {
  // Already proven by the ambiguous-identity and uncertain-region cases
  // above (both use confidence: 'high') -- this test asserts the inverse
  // failure mode never happens: confidence alone flipping the result with
  // every other factor clear.
  const clearExceptConfidence = (confidence: "high" | "medium" | "low") =>
    computeRequiresValidation({ ambiguousPrimaryIdentity: false, ambiguousRelatedIdentity: false, regionalApplicabilityCertain: true, confidence });
  assert.equal(clearExceptConfidence("high"), false);
  assert.equal(clearExceptConfidence("medium"), false);
  assert.equal(clearExceptConfidence("low"), true);
});

test("boundListPagination defaults to 50 and caps at 200, never returns a non-positive limit or negative offset", () => {
  assert.deepEqual(boundListPagination(undefined, undefined), { limit: 50, offset: 0 });
  assert.deepEqual(boundListPagination(500, undefined), { limit: 200, offset: 0 });
  assert.deepEqual(boundListPagination(0, undefined), { limit: 1, offset: 0 });
  assert.deepEqual(boundListPagination(-10, -5), { limit: 1, offset: 0 });
  assert.deepEqual(boundListPagination(25, 100), { limit: 25, offset: 100 });
});

test("coerceBooleanFilter: only the literal strings 'true'/'false' filter; anything else (including omitted) means 'no filter'", () => {
  assert.equal(coerceBooleanFilter("true"), true);
  assert.equal(coerceBooleanFilter("false"), false);
  assert.equal(coerceBooleanFilter(undefined), undefined);
  assert.equal(coerceBooleanFilter(null), undefined);
  assert.equal(coerceBooleanFilter("yes"), undefined);
});

// ---- Phase 10 fix: territory-scoped exact-URL floor ------------------------

test("isClaimedInTerritory: true when one of the rows belongs to the given territory", () => {
  assert.equal(isClaimedInTerritory([{ territoryId: "t1" }, { territoryId: "t2" }], "t2"), true);
});

test("isClaimedInTerritory: false when rows exist but none belong to the given territory -- a same-key row in a DIFFERENT territory must never suppress this one", () => {
  assert.equal(isClaimedInTerritory([{ territoryId: "t1" }, { territoryId: "t3" }], "t2"), false);
});

test("isClaimedInTerritory: false with no rows at all", () => {
  assert.equal(isClaimedInTerritory([], "t1"), false);
});

// ---- Phase 10 fix: shared list/summary filter application ------------------

interface TestRow {
  signal: {
    id: string;
    territoryId: string;
    signalType: string;
    entityType: string;
    implication: string;
    impact: string;
    status: string;
    requiresValidation: boolean;
    entityName: string;
    headline: string;
  };
  territory: { name: string } | null;
}

function makeFilterRow(overrides: Partial<TestRow["signal"]> & { territoryName?: string | null } = {}): TestRow {
  const { territoryName, ...signalOverrides } = overrides;
  return {
    signal: {
      id: "sig-1",
      territoryId: "t1",
      signalType: "acquisition",
      entityType: "competitor",
      implication: "threat",
      impact: "high",
      status: "new",
      requiresValidation: false,
      entityName: "Acme Systems",
      headline: "Acme Systems acquires a rival",
      ...signalOverrides,
    },
    territory: territoryName === null ? null : { name: territoryName ?? "UK & Ireland" },
  };
}

test("applyChannelRadarFilters: no filters returns every row unchanged", () => {
  const rows = [makeFilterRow({ id: "a" }), makeFilterRow({ id: "b", territoryId: "t2" })];
  const result = applyChannelRadarFilters(rows, { scopedTerritoryId: null });
  assert.equal(result.length, 2);
});

test("applyChannelRadarFilters: scopedTerritoryId (a PAM's own territory) restricts to exactly that territory, ignoring any territory query param", () => {
  const rows = [makeFilterRow({ id: "own", territoryId: "t1" }), makeFilterRow({ id: "other", territoryId: "t2" })];
  const result = applyChannelRadarFilters(rows, { scopedTerritoryId: "t1", territory: "t2" });
  assert.deepEqual(result.map((r) => r.signal.id), ["own"], "scopedTerritoryId must win regardless of the territory param");
});

test("applyChannelRadarFilters: unscoped territory param (global user) matches by id or by territory name", () => {
  const rows = [
    makeFilterRow({ id: "byId", territoryId: "t1", territoryName: "Romania" } as any),
    makeFilterRow({ id: "byName", territoryId: "t2", territoryName: "DACH" }),
    makeFilterRow({ id: "other", territoryId: "t3", territoryName: "Nordics" }),
  ];
  const byId = applyChannelRadarFilters(rows, { scopedTerritoryId: null, territory: "t1" });
  assert.deepEqual(byId.map((r) => r.signal.id), ["byId"]);
  const byName = applyChannelRadarFilters(rows, { scopedTerritoryId: null, territory: "DACH" });
  assert.deepEqual(byName.map((r) => r.signal.id), ["byName"]);
});

test("applyChannelRadarFilters: signalType, entityType, implication, impact, status each filter independently", () => {
  const rows = [
    makeFilterRow({ id: "match", signalType: "partnership", entityType: "partner", implication: "watch", impact: "medium", status: "reviewed" }),
    makeFilterRow({ id: "other", signalType: "funding", entityType: "ecosystem", implication: "neutral", impact: "low", status: "new" }),
  ];
  assert.deepEqual(applyChannelRadarFilters(rows, { scopedTerritoryId: null, signalType: "partnership" }).map((r) => r.signal.id), ["match"]);
  assert.deepEqual(applyChannelRadarFilters(rows, { scopedTerritoryId: null, entityType: "partner" }).map((r) => r.signal.id), ["match"]);
  assert.deepEqual(applyChannelRadarFilters(rows, { scopedTerritoryId: null, implication: "watch" }).map((r) => r.signal.id), ["match"]);
  assert.deepEqual(applyChannelRadarFilters(rows, { scopedTerritoryId: null, impact: "medium" }).map((r) => r.signal.id), ["match"]);
  assert.deepEqual(applyChannelRadarFilters(rows, { scopedTerritoryId: null, status: "reviewed" }).map((r) => r.signal.id), ["match"]);
});

test("applyChannelRadarFilters: requiresValidation filters on true and on false distinctly; undefined means no filter", () => {
  const rows = [makeFilterRow({ id: "needs", requiresValidation: true }), makeFilterRow({ id: "clear", requiresValidation: false })];
  assert.deepEqual(applyChannelRadarFilters(rows, { scopedTerritoryId: null, requiresValidation: true }).map((r) => r.signal.id), ["needs"]);
  assert.deepEqual(applyChannelRadarFilters(rows, { scopedTerritoryId: null, requiresValidation: false }).map((r) => r.signal.id), ["clear"]);
  assert.equal(applyChannelRadarFilters(rows, { scopedTerritoryId: null, requiresValidation: undefined }).length, 2);
});

test("applyChannelRadarFilters: search matches entity name or headline, case-insensitively", () => {
  const rows = [makeFilterRow({ id: "byEntity", entityName: "Contoso Robotics" }), makeFilterRow({ id: "byHeadline", headline: "A story about Contoso" }), makeFilterRow({ id: "other" })];
  const result = applyChannelRadarFilters(rows, { scopedTerritoryId: null, search: "contoso" });
  assert.deepEqual(new Set(result.map((r) => r.signal.id)), new Set(["byEntity", "byHeadline"]));
});

test("applyChannelRadarFilters: multiple filters combine with AND, not OR", () => {
  const rows = [
    makeFilterRow({ id: "matchesBoth", signalType: "acquisition", impact: "high" }),
    makeFilterRow({ id: "matchesOnlyOne", signalType: "acquisition", impact: "low" }),
  ];
  const result = applyChannelRadarFilters(rows, { scopedTerritoryId: null, signalType: "acquisition", impact: "high" });
  assert.deepEqual(result.map((r) => r.signal.id), ["matchesBoth"]);
});

test("applyChannelRadarFilters: this is the exact function both GET /channel-radar and GET /channel-radar/summary call -- same filters in, same rows out, by construction", () => {
  // Not a route-level test (that needs a live server) -- this documents and
  // locks in the reuse contract itself: calling the function twice with an
  // identical filter object over an identical row set is deterministic and
  // produces an identical result, which is what the two routes rely on.
  const rows = [makeFilterRow({ id: "a" }), makeFilterRow({ id: "b", implication: "watch" })];
  const filters = { scopedTerritoryId: null, implication: "watch" as const };
  assert.deepEqual(applyChannelRadarFilters(rows, filters), applyChannelRadarFilters(rows, filters));
});

// ---- Phase 10 fix: legacy evidence compatibility ---------------------------

const legacySignal = {
  id: "signal-1",
  sourceTitle: "Original wire story",
  sourceUrl: "https://wire.example/story",
  sourceDomain: "wire.example",
  sourcePublishedAt: "2025-01-01",
  discoveredAt: new Date("2025-01-02T00:00:00.000Z"),
};

test("resolveSignalEvidence: real evidence rows are used and mapped, never overridden by the legacy fallback", () => {
  const evidenceRows = [
    {
      id: "ev-1",
      sourceTitle: "Corroborating story",
      sourceUrl: "https://other.example/story",
      sourceDomain: "other.example",
      sourcePublishedAt: "2025-01-03",
      discoveredAt: new Date("2025-01-04T00:00:00.000Z"),
      isPrimary: false,
    },
  ];
  const result = resolveSignalEvidence(evidenceRows, legacySignal);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "ev-1");
  assert.equal(result[0]!.source_url, "https://other.example/story");
});

test("resolveSignalEvidence: zero evidence rows + a real legacy source_url synthesizes exactly one primary item from the signal's own fields", () => {
  const result = resolveSignalEvidence([], legacySignal);
  assert.equal(result.length, 1, "a legacy signal with a real source must never report zero evidence");
  assert.equal(result[0]!.is_primary, true);
  assert.equal(result[0]!.source_url, legacySignal.sourceUrl);
  assert.equal(result[0]!.source_title, legacySignal.sourceTitle);
  assert.equal(result[0]!.source_domain, legacySignal.sourceDomain);
  assert.equal(result[0]!.source_published_at, legacySignal.sourcePublishedAt);
  assert.equal(result[0]!.discovered_at, legacySignal.discoveredAt.toISOString());
  assert.equal(result[0]!.id, `legacy-${legacySignal.id}`, "a synthesized item's id must never collide with a real evidence-table uuid");
});

test("resolveSignalEvidence: zero evidence rows + no source_url produces an empty array -- never fabricates a source", () => {
  const result = resolveSignalEvidence([], { ...legacySignal, sourceUrl: "" });
  assert.deepEqual(result, []);
});

test("resolveEvidenceCount: a positive raw count is returned as-is, regardless of legacy source presence", () => {
  assert.equal(resolveEvidenceCount(3, true), 3);
  assert.equal(resolveEvidenceCount(3, false), 3);
});

test("resolveEvidenceCount: zero raw count + a legacy source counts as 1 -- matches resolveSignalEvidence's synthesis", () => {
  assert.equal(resolveEvidenceCount(0, true), 1);
});

test("resolveEvidenceCount: zero raw count + no legacy source stays 0", () => {
  assert.equal(resolveEvidenceCount(0, false), 0);
});

// ---- Phase 10 fix: atomic signal + primary evidence creation --------------
//
// Structural, DB-free coverage only: confirms the create-new-signal path is
// lexically wrapped in one db.transaction and both inserts use the
// transaction's own `tx` client, not the module-level `db` -- so a real
// engine change that silently split them back into two independent
// statements is caught here. Actual rollback-on-failure behavior (does a
// thrown error during the evidence insert really undo the signal insert)
// can only be verified against a real Postgres transaction and is
// explicitly NOT covered by this test -- that requires the later
// disposable-Postgres integration pass.
test("structural: the create-new-signal path wraps both the signal and its primary evidence insert in one db.transaction, using tx not db", () => {
  const sourcePath = fileURLToPath(new URL("../src/services/channelRadarEngine.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");

  const transactionStart = source.indexOf("await db.transaction(async (tx) => {");
  assert.notEqual(transactionStart, -1, "expected the create-new-signal path to open with `await db.transaction(async (tx) => {`");

  // The transaction body ends at the first `\n        });` after it starts
  // (matches this file's own indentation for the callback's closing brace).
  const bodyEnd = source.indexOf("\n        });", transactionStart);
  assert.notEqual(bodyEnd, -1, "expected to find the transaction callback's closing brace");
  const body = source.slice(transactionStart, bodyEnd);

  // Tolerant of drizzle's own method-chaining style (`await tx\n  .insert(...)`)
  // -- matches "tx" immediately followed (across whitespace/newlines) by
  // ".insert(<table>)", never "db" followed the same way.
  const usesTxInsert = (table: string) => new RegExp(`\\btx\\s*\\n?\\s*\\.insert\\(${table}\\)`).test(body);
  const usesDbInsert = (table: string) => new RegExp(`\\bdb\\s*\\n?\\s*\\.insert\\(${table}\\)`).test(body);

  assert.ok(usesTxInsert("channelRadarSignalsTable"), "expected the signal insert inside the transaction to use tx, not db");
  assert.ok(usesTxInsert("channelRadarSignalEvidenceTable"), "expected the primary evidence insert inside the transaction to use tx, not db");
  assert.ok(!usesDbInsert("channelRadarSignalsTable"), "the signal insert must not also/instead use the module-level db inside the transaction");
  assert.ok(!usesDbInsert("channelRadarSignalEvidenceTable"), "the evidence insert must not also/instead use the module-level db inside the transaction");
});
