// Pure unit test for the Stage 6.1 target period-selection fix -- no React,
// no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findExistingTarget } from "../src/lib/metric-target-selection";

const targets = [
  { id: "q1-ro", period: "q1", territory_id: "ro" },
  { id: "q3-ro", period: "q3", territory_id: "ro" },
  { id: "q3-global", period: "q3", territory_id: null },
];

test("resolves the target matching both territory_id and period", () => {
  assert.equal(findExistingTarget(targets, "ro", "q3")?.id, "q3-ro");
});

test("never preloads a different period's target for the same territory (the bug)", () => {
  const result = findExistingTarget(targets, "ro", "q2");
  assert.equal(result, undefined, "Q2 has no target for this territory -- must not fall back to Q1's");
  assert.notEqual(findExistingTarget(targets, "ro", "q1")?.id, "q3-ro");
});

test("global (null territory_id) resolves independently of a specific territory's target", () => {
  assert.equal(findExistingTarget(targets, null, "q3")?.id, "q3-global");
});

test("no matching row at all returns undefined, not a wrong-period fallback", () => {
  assert.equal(findExistingTarget(targets, "uk", "q3"), undefined);
});

test("undefined targets list resolves to undefined without throwing", () => {
  assert.equal(findExistingTarget(undefined, "ro", "q3"), undefined);
});
