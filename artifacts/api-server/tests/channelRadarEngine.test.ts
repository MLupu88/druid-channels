// Pure unit tests for Stage 5/6.3 Channel Radar's engine logic -- dedupe
// key determinism, bounded + geo-scoped query construction, lookback
// window derivation, and status-transition validation. No live network,
// DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRadarQueries,
  buildGeoTerm,
  computeLookbackStartDate,
  computeDedupeKey,
  isValidStatusTransition,
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
