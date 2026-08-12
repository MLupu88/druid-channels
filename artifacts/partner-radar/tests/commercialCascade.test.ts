// Phase 5B-1: pure unit tests for deriveAllocationStatus -- no React, no
// DOM, no network. This never recomputes annual_target/allocated_to_pams/
// unallocated_amount/overallocated_amount itself (those come straight from
// GET /metric-targets/annual-cascade, already tested server-side in
// annualCascade.test.ts); it only classifies an already-computed cascade
// result into the display state commercial-performance.tsx renders a
// banner for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAllocationStatus } from "../src/lib/commercial-cascade";

test("no annual target set -> 'no_target', regardless of allocation amounts", () => {
  assert.equal(deriveAllocationStatus({ annual_target: null, unallocated_amount: null, overallocated_amount: 0 }), "no_target");
});

test("underallocated: unallocated_amount > 0, overallocated_amount 0 -> 'underallocated'", () => {
  const status = deriveAllocationStatus({ annual_target: 1_000_000, unallocated_amount: 200_000, overallocated_amount: 0 });
  assert.equal(status, "underallocated");
});

test("exactly allocated: both unallocated_amount and overallocated_amount are 0 -> 'exact'", () => {
  const status = deriveAllocationStatus({ annual_target: 1_000_000, unallocated_amount: 0, overallocated_amount: 0 });
  assert.equal(status, "exact");
});

test("overallocated: overallocated_amount > 0 -> 'overallocated', even if unallocated_amount is (incorrectly) also positive", () => {
  const status = deriveAllocationStatus({ annual_target: 1_000_000, unallocated_amount: 0, overallocated_amount: 150_000 });
  assert.equal(status, "overallocated");

  // Defensive: computeAnnualCascade never actually produces both positive
  // at once, but this function doesn't assume that invariant -- it must
  // still resolve deterministically (overallocation always takes priority,
  // since it's the more urgent state to surface) rather than throwing or
  // returning an ambiguous result.
  const defensive = deriveAllocationStatus({ annual_target: 1_000_000, unallocated_amount: 50_000, overallocated_amount: 150_000 });
  assert.equal(defensive, "overallocated");
});

test("a real annual target of 0 is still a set target -- 'no_target' is reserved for null, never for 0", () => {
  const status = deriveAllocationStatus({ annual_target: 0, unallocated_amount: 0, overallocated_amount: 0 });
  assert.equal(status, "exact");
});
