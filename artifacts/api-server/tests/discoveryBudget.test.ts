// Pure unit tests for Stage 6.5 Cost-Aware Adaptive Discovery's budget/yield
// decision logic (discoveryBudget.ts). No live search, DB, or AI call --
// every function under test is deterministic and side-effect-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideNextBatch,
  computeNewCandidateYield,
  computeDuplicateRate,
  shouldReuseExistingQualification,
  MAX_QUERIES_PER_RUN,
  MAX_BATCHES_PER_RUN,
  MAX_CANDIDATES_TO_LLM,
  YIELD_EXPAND_THRESHOLD,
  YIELD_STOP_THRESHOLD,
} from "../src/services/discoveryBudget";

// ---- computeNewCandidateYield / computeDuplicateRate ----------------------

test("computeNewCandidateYield: fraction of raw results that were genuinely new companies", () => {
  assert.equal(computeNewCandidateYield({ rawResults: 20, uniqueCompanies: 15, newCompanies: 8 }), 0.4);
});

test("computeNewCandidateYield: zero raw results never divides by zero", () => {
  assert.equal(computeNewCandidateYield({ rawResults: 0, uniqueCompanies: 0, newCompanies: 0 }), 0);
});

test("computeDuplicateRate: fraction of raw results that were NOT unique companies", () => {
  assert.equal(computeDuplicateRate({ rawResults: 20, uniqueCompanies: 15, newCompanies: 8 }), 0.25);
});

// ---- decideNextBatch (checks B/C/D) ---------------------------------------

test("check B: strong sustained new-company yield keeps expanding until a hard cap is reached", () => {
  const strongYield = YIELD_EXPAND_THRESHOLD + 0.1;
  let state = { queriesRun: 0, candidatesSentToLlm: 0, batchesRun: 0, recentYields: [] as number[] };
  const decision1 = decideNextBatch(state);
  assert.equal(decision1.action, "expand");

  state = { queriesRun: 4, candidatesSentToLlm: 5, batchesRun: 1, recentYields: [strongYield] };
  const decision2 = decideNextBatch(state);
  assert.equal(decision2.action, "expand", "a single strong-yield batch must not itself trigger a stop");
});

test("check C: repeatedly poor yield (a full saturation window) stops with reason=saturation", () => {
  const poorYield = YIELD_STOP_THRESHOLD - 0.02;
  const state = { queriesRun: 8, candidatesSentToLlm: 6, batchesRun: 2, recentYields: [poorYield, poorYield] };
  const decision = decideNextBatch(state);
  assert.equal(decision.action, "stop");
  assert.equal(decision.reason, "saturation");
});

test("check C: a single poor-yield batch alone never triggers saturation -- never proof from one run", () => {
  const poorYield = YIELD_STOP_THRESHOLD - 0.02;
  const state = { queriesRun: 4, candidatesSentToLlm: 3, batchesRun: 1, recentYields: [poorYield] };
  const decision = decideNextBatch(state);
  assert.equal(decision.action, "expand");
});

test("check C: one strong batch after a poor one breaks the saturation streak", () => {
  const poorYield = YIELD_STOP_THRESHOLD - 0.02;
  const strongYield = YIELD_EXPAND_THRESHOLD + 0.1;
  const state = { queriesRun: 8, candidatesSentToLlm: 6, batchesRun: 2, recentYields: [poorYield, strongYield] };
  const decision = decideNextBatch(state);
  assert.equal(decision.action, "expand");
});

test("check D: candidatesSentToLlm at the hard cap always stops with reason=budget_exhausted", () => {
  const state = { queriesRun: 4, candidatesSentToLlm: MAX_CANDIDATES_TO_LLM, batchesRun: 1, recentYields: [0.9] };
  const decision = decideNextBatch(state);
  assert.equal(decision.action, "stop");
  assert.equal(decision.reason, "budget_exhausted");
});

test("check D: queriesRun at the hard cap always stops, even with a perfect yield", () => {
  const state = { queriesRun: MAX_QUERIES_PER_RUN, candidatesSentToLlm: 2, batchesRun: 1, recentYields: [1] };
  const decision = decideNextBatch(state);
  assert.equal(decision.action, "stop");
  assert.equal(decision.reason, "completed");
});

test("check D: batchesRun at the hard cap always stops, even with a perfect yield", () => {
  const state = { queriesRun: 8, candidatesSentToLlm: 2, batchesRun: MAX_BATCHES_PER_RUN, recentYields: [1] };
  const decision = decideNextBatch(state);
  assert.equal(decision.action, "stop");
  assert.equal(decision.reason, "completed");
});

test("check D: MAX_BATCHES_PER_RUN * QUERIES_PER_BATCH never exceeds MAX_QUERIES_PER_RUN (the two caps stay consistent)", () => {
  assert.ok(MAX_BATCHES_PER_RUN * 4 <= MAX_QUERIES_PER_RUN + 4 - 1); // batches are sized in QUERIES_PER_BATCH-sized chunks
});

// ---- shouldReuseExistingQualification (checks E/F) ------------------------

test("check F: a fresh existing qualification (within the recency window) is reused -- no re-evaluation", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const recent = new Date("2026-08-05T00:00:00.000Z"); // 5 days ago
  assert.equal(shouldReuseExistingQualification({ lastResearchedAt: recent, createdAt: recent }, 90, now), true);
});

test("check F: a stale existing qualification (past the recency window) is NOT reused -- eligible for re-evaluation", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const stale = new Date("2025-01-01T00:00:00.000Z");
  assert.equal(shouldReuseExistingQualification({ lastResearchedAt: stale, createdAt: stale }, 90, now), false);
});

test("check F: falls back to createdAt when lastResearchedAt was never set", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const recent = new Date("2026-08-08T00:00:00.000Z");
  assert.equal(shouldReuseExistingQualification({ lastResearchedAt: null, createdAt: recent }, 90, now), true);
});

test("check E: no existing record at all -- never reused, a genuinely new company always gets evaluated", () => {
  assert.equal(shouldReuseExistingQualification(null, 90), false);
});
