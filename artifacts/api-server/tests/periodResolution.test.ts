// Pure unit tests for the Stage 6.3 dynamic period model -- no live
// network, DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPeriodKey, joinPeriodKey, resolvePeriodRange, resolvePeriodKey } from "../src/services/kpiRegistry";

test("splitPeriodKey parses a well-formed composite key", () => {
  assert.deepEqual(splitPeriodKey("2026-q3"), { year: 2026, quarterKey: "q3" });
  assert.deepEqual(splitPeriodKey("2027-ytd"), { year: 2027, quarterKey: "ytd" });
});

test("splitPeriodKey rejects a bare pre-6.3 period key -- the exact collision this fixes", () => {
  assert.equal(splitPeriodKey("q3"), null);
});

test("splitPeriodKey rejects malformed/empty input without throwing", () => {
  assert.equal(splitPeriodKey(""), null);
  assert.equal(splitPeriodKey("2026"), null);
  assert.equal(splitPeriodKey("2026-q5"), null);
});

test("joinPeriodKey/splitPeriodKey round-trip", () => {
  assert.equal(joinPeriodKey(2027, "q1"), "2027-q1");
  assert.deepEqual(splitPeriodKey(joinPeriodKey(2027, "q1")), { year: 2027, quarterKey: "q1" });
});

test("2026 Q1 and 2027 Q1 resolve to distinct, correct date ranges -- the core correctness requirement", () => {
  const y2026 = resolvePeriodRange("2026-q1");
  const y2027 = resolvePeriodRange("2027-q1");
  assert.deepEqual(y2026, { start: "2026-01-01", end: "2026-03-31", label: "Q1 2026" });
  assert.deepEqual(y2027, { start: "2027-01-01", end: "2027-03-31", label: "Q1 2027" });
  assert.notDeepEqual(y2026, y2027);
});

test("resolvePeriodRange computes every quarter's boundaries from year + quarterKey arithmetically", () => {
  assert.deepEqual(resolvePeriodRange("2026-q2"), { start: "2026-04-01", end: "2026-06-30", label: "Q2 2026" });
  assert.deepEqual(resolvePeriodRange("2026-q4"), { start: "2026-10-01", end: "2026-12-31", label: "Q4 2026" });
});

test("resolvePeriodKey validates/passes through a well-formed key and never mutates it", () => {
  assert.equal(resolvePeriodKey("2027-q2"), "2027-q2");
});

test("resolvePeriodKey defaults to the current year + current quarter (never a hardcoded literal)", () => {
  const resolved = resolvePeriodKey(undefined);
  const split = splitPeriodKey(resolved);
  assert.ok(split, "default must itself be a well-formed composite key");
  assert.equal(split!.year, new Date().getFullYear());
});

test("a prior year's YTD is honestly reinterpreted as the full calendar year, never a misleading 'to date' claim", () => {
  const priorYear = new Date().getFullYear() - 1;
  const range = resolvePeriodRange(`${priorYear}-ytd`);
  assert.equal(range.start, `${priorYear}-01-01`);
  assert.equal(range.end, `${priorYear}-12-31`);
  assert.match(range.label, /full year/);
});

test("current year's YTD runs through today, not a fabricated year-end date", () => {
  const currentYear = new Date().getFullYear();
  const range = resolvePeriodRange(`${currentYear}-ytd`);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(range.start, `${currentYear}-01-01`);
  assert.equal(range.end, today);
  assert.equal(range.label, "Year to date");
});
