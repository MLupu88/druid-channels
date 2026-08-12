// Pure unit tests for Phase 5A's annual target cascade math -- no live
// network, DB, or server. computeAnnualCascade is deliberately DB-free (see
// services/targetService.ts) so this exercises exactly the same function
// getAnnualCascade hands its DB-fetched inputs to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAnnualCascade, type PamAllocation } from "../src/services/targetService";

function allocation(overrides: Partial<PamAllocation>): PamAllocation {
  return {
    pamUserId: "pam-1",
    pamName: "Test PAM",
    territoryId: "territory-1",
    territoryName: "Test Territory",
    q1: null,
    q2: null,
    q3: null,
    q4: null,
    ...overrides,
  };
}

test("no annual target configured -> unallocated_amount and attainment_percent stay null, never a fabricated 0", () => {
  const result = computeAnnualCascade("closed_revenue", 2026, null, [], 500);
  assert.equal(result.annual_target, null);
  assert.equal(result.unallocated_amount, null);
  assert.equal(result.attainment_percent, null);
  assert.equal(result.overallocated_amount, 0);
  assert.equal(result.allocated_to_pams, 0);
});

test("allocated_to_pams is the real sum of PAM allocations, never annual_target / 4", () => {
  const allocations = [
    allocation({ pamUserId: "pam-1", q1: 100, q2: 100, q3: 100, q4: 100 }),
    allocation({ pamUserId: "pam-2", territoryId: "territory-2", q1: 50, q2: 50, q3: 50, q4: 50 }),
  ];
  // annual_target / 4 would be 300000 -- deliberately far from the real
  // allocation sum (600) to prove no automatic division ever happens.
  const result = computeAnnualCascade("closed_revenue", 2026, 1_200_000, allocations, null);
  assert.equal(result.allocated_to_pams, 600);
  assert.notEqual(result.allocated_to_pams, 1_200_000 / 4);
  assert.deepEqual(result.quarterly_totals, { q1: 150, q2: 150, q3: 150, q4: 150 });
});

test("partial allocation under target -> unallocated_amount is the honest gap, overallocated_amount is 0", () => {
  const allocations = [allocation({ q1: 200, q2: 200, q3: 200, q4: 200 })]; // 800 total
  const result = computeAnnualCascade("closed_revenue", 2026, 1000, allocations, null);
  assert.equal(result.allocated_to_pams, 800);
  assert.equal(result.unallocated_amount, 200);
  assert.equal(result.overallocated_amount, 0);
});

test("allocation exceeding target -> overallocated_amount is the honest excess, unallocated_amount is 0 (never negative)", () => {
  const allocations = [allocation({ q1: 400, q2: 400, q3: 400, q4: 400 })]; // 1600 total
  const result = computeAnnualCascade("closed_revenue", 2026, 1000, allocations, null);
  assert.equal(result.allocated_to_pams, 1600);
  assert.equal(result.unallocated_amount, 0);
  assert.equal(result.overallocated_amount, 600);
});

test("a PAM's unset quarter is treated as 0 for summation, not skipped/undefined", () => {
  const allocations = [allocation({ q1: 100, q2: null, q3: null, q4: 100 })];
  const result = computeAnnualCascade("closed_revenue", 2026, 1000, allocations, null);
  assert.equal(result.allocated_to_pams, 200);
  assert.deepEqual(result.quarterly_totals, { q1: 100, q2: 0, q3: 0, q4: 100 });
});

test("attainment_percent is round(actual / annual_target * 100), null when actual is null", () => {
  const withActual = computeAnnualCascade("closed_revenue", 2026, 1000, [], 730);
  assert.equal(withActual.attainment_percent, 73);

  const withoutActual = computeAnnualCascade("closed_revenue", 2026, 1000, [], null);
  assert.equal(withoutActual.attainment_percent, null);
});

test("attainment_percent stays null when annual_target is 0 (never divides by zero)", () => {
  const result = computeAnnualCascade("closed_revenue", 2026, 0, [], 500);
  assert.equal(result.attainment_percent, null);
});

test("allocations array is echoed back unmodified, for the caller to render per-PAM detail", () => {
  const allocations = [allocation({ pamUserId: "pam-1" }), allocation({ pamUserId: "pam-2", territoryId: "territory-2" })];
  const result = computeAnnualCascade("closed_revenue", 2026, 1000, allocations, null);
  assert.equal(result.allocations.length, 2);
  assert.deepEqual(
    result.allocations.map((a) => a.pamUserId),
    ["pam-1", "pam-2"],
  );
});
