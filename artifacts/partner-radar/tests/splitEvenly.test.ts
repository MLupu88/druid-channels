// Phase 11.6C amendment: pure unit tests for lib/split-evenly.ts -- no
// React, no DOM, no network. Proves the "Split evenly" helper (used by
// components/channel-plan-section.tsx's AllocateAnnualTargetDialog) never
// silently drops currency precision for money metrics, and never produces
// a fractional partner count for count metrics -- in both cases the
// returned shares always reconcile EXACTLY to the input, to the
// appropriate precision, with any rounding remainder assigned
// deterministically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitEvenly, splitMoneyEvenly, splitCountEvenly } from "../src/lib/split-evenly";

// Rounds a floating-point sum of already-2-decimal values back to an exact
// number of cents for comparison -- avoids asserting on a raw float sum,
// which can carry harmless representation noise (e.g. 33.33 + 33.33 +
// 33.34 might print as 99.99999999999999 depending on JS's summation
// order) even when the underlying cents are exactly correct.
function centsOf(values: number[]): number {
  return Math.round(values.reduce((sum, v) => sum + v, 0) * 100);
}

test("splitEvenly: base case, remainder distributed to the first N entries", () => {
  assert.deepEqual(splitEvenly(10, 3), [4, 3, 3]);
  assert.deepEqual(splitEvenly(9, 3), [3, 3, 3]);
  assert.deepEqual(splitEvenly(0, 3), [0, 0, 0]);
  assert.deepEqual(splitEvenly(5, 1), [5]);
  assert.deepEqual(splitEvenly(5, 0), []);
});

test("splitEvenly: sum of the result always equals the input total exactly", () => {
  for (const [total, count] of [[100, 3], [101, 7], [0, 4], [1, 1], [12345, 11]] as const) {
    const shares = splitEvenly(total, count);
    assert.equal(shares.reduce((s, v) => s + v, 0), total, `splitEvenly(${total}, ${count}) must reconcile exactly`);
  }
});

// ---- MONEY metrics -- must preserve currency precision to 2 decimal places ----

test("splitMoneyEvenly: 100 / 3 PAMs totals exactly 100.00", () => {
  const shares = splitMoneyEvenly(100, 3);
  assert.equal(centsOf(shares), 10000);
  for (const s of shares) assert.equal(Math.round(s * 100) / 100, s, "every share must already be at most 2 decimal places");
});

test("splitMoneyEvenly: 100.01 / 3 PAMs totals exactly 100.01 (the cent is never dropped)", () => {
  const shares = splitMoneyEvenly(100.01, 3);
  assert.equal(centsOf(shares), 10001);
});

test("splitMoneyEvenly: 100.02 / 4 PAMs totals exactly 100.02", () => {
  const shares = splitMoneyEvenly(100.02, 4);
  assert.equal(centsOf(shares), 10002);
});

test("splitMoneyEvenly: 0 splits into all-zero shares", () => {
  const shares = splitMoneyEvenly(0, 5);
  assert.deepEqual(shares, [0, 0, 0, 0, 0]);
});

test("splitMoneyEvenly: a single PAM receives the entire (unrounded-away) target", () => {
  assert.deepEqual(splitMoneyEvenly(1234.56, 1), [1234.56]);
});

test("splitMoneyEvenly: two-level split (PAM, then Q1-Q4) still reconciles exactly", () => {
  // Mirrors AllocateAnnualTargetDialog's handleSplitEvenly composition --
  // splitting an already-split PAM share across its own 4 quarters must
  // not compound any rounding error.
  const perPam = splitMoneyEvenly(100.01, 3);
  let grandTotalCents = 0;
  for (const share of perPam) {
    const perQuarter = splitMoneyEvenly(share, 4);
    grandTotalCents += centsOf(perQuarter);
  }
  assert.equal(grandTotalCents, 10001);
});

// ---- COUNT metrics -- must never produce a fractional partner ----

test("splitCountEvenly: 10 / 3 PAMs totals exactly 10, every share is a whole number", () => {
  const shares = splitCountEvenly(10, 3);
  assert.equal(shares.reduce((s, v) => s + v, 0), 10);
  for (const s of shares) assert.ok(Number.isInteger(s), "every count share must be a whole number");
});

test("splitCountEvenly: 3 / 5 PAMs totals exactly 3 (some PAMs legitimately get 0)", () => {
  const shares = splitCountEvenly(3, 5);
  assert.equal(shares.reduce((s, v) => s + v, 0), 3);
  assert.deepEqual(shares, [1, 1, 1, 0, 0]);
});

test("splitCountEvenly: 0 splits into all-zero shares", () => {
  assert.deepEqual(splitCountEvenly(0, 4), [0, 0, 0, 0]);
});

test("splitCountEvenly: a single PAM receives the entire target", () => {
  assert.deepEqual(splitCountEvenly(12, 1), [12]);
});
