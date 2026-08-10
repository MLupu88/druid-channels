// Pure unit tests for Stage 5 Channel Radar's engine logic -- dedupe key
// determinism, bounded query construction, and status-transition
// validation. No live network, DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRadarQueries, computeDedupeKey, isValidStatusTransition } from "../src/services/channelRadarEngine";

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
  const queries = buildRadarQueries(entities, signalTypes);
  // Cartesian would be 30 -- the bounded builder must stay well under that.
  assert.ok(queries.length <= 12, `expected <= 12 queries, got ${queries.length}`);
  assert.ok(queries.length > 0);
});

test("buildRadarQueries represents every entity before giving any entity a second query", () => {
  const entities = ["Microsoft", "UiPath", "Kore.ai"];
  const signalTypes = ["acquisition", "partnership"];
  const queries = buildRadarQueries(entities, signalTypes);
  const firstThree = queries.slice(0, 3).map((q) => q.entityHint);
  assert.deepEqual(new Set(firstThree), new Set(entities));
});

test("buildRadarQueries with no monitored entities produces no queries -- never fabricated", () => {
  assert.deepEqual(buildRadarQueries([], ["acquisition"]), []);
});

test("buildRadarQueries with entities but no signal types falls back to one generic query per entity", () => {
  const queries = buildRadarQueries(["Microsoft", "UiPath"], []);
  assert.equal(queries.length, 2);
  assert.deepEqual(new Set(queries.map((q) => q.entityHint)), new Set(["Microsoft", "UiPath"]));
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
