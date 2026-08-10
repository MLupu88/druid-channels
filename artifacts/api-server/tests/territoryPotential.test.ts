// Pure unit tests for Stage 6.5 Territory Potential's deterministic
// calculations (territoryPotentialService.ts). No live DB call -- every
// function under test takes already-fetched rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSaturationState,
  computePotentialBand,
  computeRunYield,
  computeRunDuplicateRate,
  isUsableProductivityRun,
  interpretSaturation,
  type RunProductivity,
} from "../src/services/territoryPotentialService";
import { qualifyChecks } from "../src/services/discoveryEngine";

function connectedRun(overrides: Partial<RunProductivity> = {}): RunProductivity {
  return { dataStatus: "connected", queriesRun: 8, uniqueCompaniesSeen: 20, newCompaniesCount: 6, duplicatesRemoved: 5, ...overrides };
}

// ---- check A: same qualification threshold regardless of territory -------

test("check A: qualifyChecks gives the identical verdict for the same evidence regardless of territory context", () => {
  const checks = { enterpriseAccess: true, relevantCapability: true, technologyAdjacency: false, partnershipOpenness: true, recentTrigger: false };
  // "territory" never enters qualifyChecks' signature at all -- calling it
  // twice, as if for a small vs. a large territory, must be byte-identical.
  const usResult = qualifyChecks(checks, 3);
  const portugalResult = qualifyChecks(checks, 3);
  assert.deepEqual(usResult, portugalResult);
});

test("check A: a lower minChecksRequired is a per-territory Settings choice, not a hidden discount from Territory Potential logic", () => {
  const checks = { enterpriseAccess: true, relevantCapability: true, technologyAdjacency: false, partnershipOpenness: false, recentTrigger: false };
  // 2 of 5 passed -- fails regardless of the configured minChecksRequired
  // being low, because enterpriseAccess/relevantCapability alone (without a
  // 3rd) never reaches the qualifyChecks priority gate.
  const result = qualifyChecks(checks, 1);
  assert.equal(result.priority, null);
});

// ---- computeRunYield / computeRunDuplicateRate ----------------------------

test("computeRunYield and computeRunDuplicateRate partition raw results cleanly (no double-count)", () => {
  const run = connectedRun({ uniqueCompaniesSeen: 20, newCompaniesCount: 6, duplicatesRemoved: 5 });
  // rawResultsTotal = uniqueCompaniesSeen + duplicatesRemoved = 25
  assert.equal(computeRunYield(run), 6 / 25);
  assert.equal(computeRunDuplicateRate(run), 5 / 25);
});

test("isUsableProductivityRun: demo runs and never-searched runs are excluded from productivity evidence", () => {
  assert.equal(isUsableProductivityRun(connectedRun()), true);
  assert.equal(isUsableProductivityRun({ ...connectedRun(), dataStatus: "demo" }), false);
  assert.equal(isUsableProductivityRun({ ...connectedRun(), queriesRun: 0 }), false);
});

// ---- computeSaturationState (checks C/G) ----------------------------------

test("check G: zero discovery runs ever -> unexplored, never fabricated", () => {
  assert.equal(computeSaturationState(0, []), "unexplored");
});

test("check G: runs exist but none are usable (connected+real) -> insufficient_data, never fabricated", () => {
  assert.equal(computeSaturationState(3, []), "insufficient_data");
});

test("check G: exactly one usable run -> exploring, never treated as saturation/productive proof from one run", () => {
  assert.equal(computeSaturationState(1, [connectedRun({ newCompaniesCount: 0, uniqueCompaniesSeen: 20, duplicatesRemoved: 5 })]), "exploring");
});

test("check C: two consecutive poor-yield runs -> saturated", () => {
  const poor = connectedRun({ newCompaniesCount: 1, uniqueCompaniesSeen: 20, duplicatesRemoved: 5 }); // 1/25 = 4%
  assert.equal(computeSaturationState(2, [poor, poor]), "saturated");
});

test("recent strong yield -> productive", () => {
  const strong = connectedRun({ newCompaniesCount: 10, uniqueCompaniesSeen: 20, duplicatesRemoved: 5 }); // 10/25 = 40%
  const older = connectedRun({ newCompaniesCount: 1, uniqueCompaniesSeen: 20, duplicatesRemoved: 5 });
  assert.equal(computeSaturationState(2, [strong, older]), "productive");
});

test("declining but not fully saturated -> slowing", () => {
  const mid = connectedRun({ newCompaniesCount: 3, uniqueCompaniesSeen: 20, duplicatesRemoved: 5 }); // 3/25 = 12% (between thresholds)
  assert.equal(computeSaturationState(2, [mid, mid]), "slowing");
});

// ---- computePotentialBand (checks G, "no fake market sizing") ------------

test("check G: no discovery runs and no existing partners -> insufficient_data", () => {
  assert.equal(computePotentialBand(0, 0, 0), "insufficient_data");
});

test("potential band is purely count-based -- a small territory with few real candidates stays low, honestly", () => {
  assert.equal(computePotentialBand(3, 2, 1), "low");
});

test("potential band scales with observed counts, not a country-size multiplier", () => {
  assert.equal(computePotentialBand(8, 4, 5), "medium");
  assert.equal(computePotentialBand(25, 10, 5), "high");
});

// ---- interpretSaturation is template-based, not model-generated ----------

test("interpretSaturation returns a fixed string per state -- deterministic, not DeepSeek-generated", () => {
  const a = interpretSaturation("saturated");
  const b = interpretSaturation("saturated");
  assert.equal(a, b);
  assert.match(a, /saturation/i);
});
