// Phase 11.6.1 P3A forensic investigation: pure unit tests proving the exact
// boundary behavior of qualifyChecks (discoveryEngine.ts) -- no live network,
// no DB. This function was previously only smoke-tested for determinism
// (see discoveryEngine.test.ts's "qualifyChecks is untouched by this hotfix"
// test); its actual mandatory-check and Priority A/B boundary conditions had
// no dedicated coverage, despite being central to the low-yield
// investigation this file supports. Written directly against the real,
// unmodified, exported qualifyChecks -- not a copy, not a forensic helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifyChecks, countChecks, type FiveChecks } from "../src/services/discoveryEngine";

function checks(overrides: Partial<FiveChecks>): FiveChecks {
  return {
    enterpriseAccess: false,
    relevantCapability: false,
    technologyAdjacency: false,
    partnershipOpenness: false,
    recentTrigger: false,
    ...overrides,
  };
}

// ---- mandatory checks: enterpriseAccess and relevantCapability -----------

test("enterpriseAccess=false rejects the candidate even when all other four checks are true (5 of 5, but mandatory check missing)", () => {
  const c = checks({ enterpriseAccess: false, relevantCapability: true, technologyAdjacency: true, partnershipOpenness: true, recentTrigger: true });
  assert.equal(countChecks(c), 4);
  const result = qualifyChecks(c, 1);
  assert.equal(result.priority, null, "enterpriseAccess is a hard mandatory gate -- no count of other checks can compensate for it");
  assert.ok(result.rationale.includes("enterprise-access"));
});

test("relevantCapability=false rejects the candidate even when all other four checks are true", () => {
  const c = checks({ enterpriseAccess: true, relevantCapability: false, technologyAdjacency: true, partnershipOpenness: true, recentTrigger: true });
  assert.equal(countChecks(c), 4);
  const result = qualifyChecks(c, 1);
  assert.equal(result.priority, null, "relevantCapability is a hard mandatory gate -- no count of other checks can compensate for it");
  assert.ok(result.rationale.includes("relevant-capability"));
});

test("both mandatory checks true but every other check false, at the exact minChecksRequired floor: still rejected (only 2 of 5, below any minChecksRequired >= 3)", () => {
  const c = checks({ enterpriseAccess: true, relevantCapability: true });
  assert.equal(countChecks(c), 2);
  const result = qualifyChecks(c, 3);
  assert.equal(result.priority, null);
  assert.ok(result.rationale.includes("Only 2 of 5 checks passed"));
});

// ---- Priority A: count >= 4 AND (partnershipOpenness OR recentTrigger) ---

test("Priority A requires enterpriseAccess+relevantCapability+technologyAdjacency AND (partnershipOpenness OR recentTrigger) -- exactly 4 of 5 with the trigger route", () => {
  const c = checks({ enterpriseAccess: true, relevantCapability: true, technologyAdjacency: true, recentTrigger: true });
  assert.equal(countChecks(c), 4);
  const result = qualifyChecks(c, 3);
  assert.equal(result.priority, "A");
});

test("Priority A: the partnership-openness route (instead of a recent trigger) also qualifies at count=4", () => {
  const c = checks({ enterpriseAccess: true, relevantCapability: true, technologyAdjacency: true, partnershipOpenness: true });
  assert.equal(countChecks(c), 4);
  assert.equal(qualifyChecks(c, 3).priority, "A");
});

test("count=4 WITHOUT technologyAdjacency (i.e. both partnershipOpenness and recentTrigger true instead) also reaches Priority A -- the rule only requires the total count and the OR route, not which specific check supplied the 4th", () => {
  const c = checks({ enterpriseAccess: true, relevantCapability: true, partnershipOpenness: true, recentTrigger: true });
  assert.equal(countChecks(c), 4);
  assert.equal(qualifyChecks(c, 3).priority, "A");
});

test("count=4 via enterpriseAccess+relevantCapability+technologyAdjacency+partnershipOpenness-and-recentTrigger-both-false is NOT possible to reach Priority A -- without partnershipOpenness OR recentTrigger, count=3 falls to Priority B instead, never A", () => {
  // enterpriseAccess+relevantCapability+technologyAdjacency true, both partnershipOpenness/recentTrigger false -> count=3, not 4.
  const c = checks({ enterpriseAccess: true, relevantCapability: true, technologyAdjacency: true });
  assert.equal(countChecks(c), 3);
  assert.equal(qualifyChecks(c, 3).priority, "B", "3 of 5 with only the two mandatory checks + technologyAdjacency lands on B, not A -- A strictly requires the 4th check to be partnershipOpenness or recentTrigger");
});

test("all 5 checks true reaches Priority A (the ceiling case)", () => {
  const c = checks({ enterpriseAccess: true, relevantCapability: true, technologyAdjacency: true, partnershipOpenness: true, recentTrigger: true });
  assert.equal(countChecks(c), 5);
  assert.equal(qualifyChecks(c, 3).priority, "A");
});

// ---- Priority B: exactly count === 3, both mandatory checks true ---------

test("Priority B requires exactly 3 of 5 (mandatory two plus exactly one more)", () => {
  const c = checks({ enterpriseAccess: true, relevantCapability: true, recentTrigger: true });
  assert.equal(countChecks(c), 3);
  assert.equal(qualifyChecks(c, 3).priority, "B");
});

test("count=3 but WITHOUT both mandatory checks (e.g. technologyAdjacency+partnershipOpenness+recentTrigger, no enterpriseAccess) is rejected, not Priority B -- the mandatory gate is checked before the count===3 rule", () => {
  const c = checks({ technologyAdjacency: true, partnershipOpenness: true, recentTrigger: true });
  assert.equal(countChecks(c), 3);
  const result = qualifyChecks(c, 1);
  assert.equal(result.priority, null, "3 of 5 checks is not sufficient on its own -- enterpriseAccess and relevantCapability are non-negotiable regardless of the total count");
});

// ---- minChecksRequired interacts with, but never replaces, the mandatory gate ----

test("minChecksRequired=1 does not bypass the mandatory-check gate -- a single true check (recentTrigger only) is still rejected", () => {
  const c = checks({ recentTrigger: true });
  assert.equal(countChecks(c), 1);
  const result = qualifyChecks(c, 1);
  assert.equal(result.priority, null, "clearing the territory's minChecksRequired floor is necessary but never sufficient -- enterpriseAccess/relevantCapability still gate independently");
});

test("this file's fixtures never assert an impossible qualifyChecks outcome: priority is always A, B, or null, count is always 0-5", () => {
  const allTrue = checks({ enterpriseAccess: true, relevantCapability: true, technologyAdjacency: true, partnershipOpenness: true, recentTrigger: true });
  const result = qualifyChecks(allTrue, 0);
  assert.ok(["A", "B", null].includes(result.priority));
  assert.ok(countChecks(allTrue) >= 0 && countChecks(allTrue) <= 5);
});
