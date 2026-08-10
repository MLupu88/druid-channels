// Stage 6.5 Cost-Aware Adaptive Discovery: pure, deterministic budget/yield
// decision logic, kept entirely separate from discoveryEngine.ts's
// provider-calling orchestration so it can be unit-tested with zero
// network/DB/AI calls. Nothing here changes the qualification bar
// (qualifyChecks in discoveryEngine.ts is untouched) -- this module only
// decides HOW MUCH search/AI-evaluation effort a run is allowed to spend,
// never WHICH candidates pass.
//
// Architecture: Tavily -> deterministic normalize/dedupe -> deterministic
// cheap filtering -> DeepSeek only for survivors. This module owns the
// "deterministic cheap filtering" and "how much budget is left" pieces.

// Bounded, hard per-run caps -- never exceeded regardless of territory size
// or observed yield. A large territory earns more depth only by *staying
// productive across batches*, never by a static per-country classification
// (see decideNextBatch below).
export const MAX_QUERIES_PER_RUN = 12; // matches discoveryEngine's existing MAX_AUTOMATIC_QUERIES ceiling
export const QUERIES_PER_BATCH = 4;
export const MAX_BATCHES_PER_RUN = 3; // 3 * 4 = 12, i.e. never more than the existing query ceiling
export const MAX_CANDIDATES_TO_LLM = 20;

// A batch "expands" only while its new-company yield stays healthy;
// "slowing" sits between the two thresholds instead of a single cliff, so a
// gradually-declining territory is distinguishable from one still fully
// productive or one that has clearly stopped producing anything new.
export const YIELD_EXPAND_THRESHOLD = 0.2; // >= 20% of this batch's raw results were new companies
export const YIELD_STOP_THRESHOLD = 0.1; // < 10% -- contributes toward a saturation verdict

// Never call a single run's yield proof of saturation -- require this many
// consecutive poor-yield batches (within one run's adaptive loop) before
// stopping for that reason.
export const SATURATION_BATCH_WINDOW = 2;

export interface BatchYieldStats {
  rawResults: number;
  // Distinct evidence domains within this batch, after in-run URL dedupe --
  // an approximation of "distinct candidate companies" (see the
  // discoveryEngine.ts integration comment for why evidence domain, not the
  // eventually-resolved candidate company, is the honest unit here for
  // third-party evidence).
  uniqueCompanies: number;
  // Subset of uniqueCompanies not already known (existing companies table)
  // and not already seen earlier in this same run.
  newCompanies: number;
}

export function computeNewCandidateYield(stats: BatchYieldStats): number {
  if (stats.rawResults === 0) return 0;
  return stats.newCompanies / stats.rawResults;
}

export function computeDuplicateRate(stats: BatchYieldStats): number {
  if (stats.rawResults === 0) return 0;
  return (stats.rawResults - stats.uniqueCompanies) / stats.rawResults;
}

export type BudgetStopReason = "budget_exhausted" | "saturation" | "completed";

export interface BudgetState {
  queriesRun: number;
  candidatesSentToLlm: number;
  batchesRun: number;
  // Per-batch new-candidate yield (computeNewCandidateYield), oldest first,
  // for batches completed so far in this run.
  recentYields: number[];
}

// A stop decision always carries a real reason; an expand decision never
// has one to carry -- modeled as a discriminated union (rather than a
// nullable `reason` field) so "stopped without a reason" is not a state
// the type system allows in the first place, and every consumer narrows on
// `action` before it can ever read `reason`.
export type ExpansionDecision = { action: "expand" } | { action: "stop"; reason: BudgetStopReason };

// The adaptive core: bounded initial search -> evaluate yield -> optional
// bounded expansion -> stop on hard cap or poor sustained yield. Pure and
// side-effect-free so it's directly unit-testable (checks B/C/D).
export function decideNextBatch(state: BudgetState): ExpansionDecision {
  if (state.candidatesSentToLlm >= MAX_CANDIDATES_TO_LLM) return { action: "stop", reason: "budget_exhausted" };
  if (state.queriesRun >= MAX_QUERIES_PER_RUN) return { action: "stop", reason: "completed" };
  if (state.batchesRun >= MAX_BATCHES_PER_RUN) return { action: "stop", reason: "completed" };

  if (state.recentYields.length >= SATURATION_BATCH_WINDOW) {
    const lastN = state.recentYields.slice(-SATURATION_BATCH_WINDOW);
    if (lastN.every((y) => y < YIELD_STOP_THRESHOLD)) return { action: "stop", reason: "saturation" };
  }

  return { action: "expand" };
}

// ---- Qualification-evaluation cache (cost control B) ---------------------
//
// A company that already has a persisted prospect (any status, including
// rejected -- a rejection is itself a completed, spend-worthy evaluation)
// is not re-sent to DeepSeek unless its evidence is stale. Reuses the
// territory's own existing recencyWindowDays (scan_configs) as the
// freshness rule, rather than inventing a second, potentially-conflicting
// staleness concept.
export interface ExistingQualificationRecord {
  lastResearchedAt: Date | null;
  createdAt: Date;
}

export function shouldReuseExistingQualification(
  existing: ExistingQualificationRecord | null,
  recencyWindowDays: number,
  now: Date = new Date(),
): boolean {
  if (!existing) return false;
  const reference = existing.lastResearchedAt ?? existing.createdAt;
  const ageDays = (now.getTime() - reference.getTime()) / 86_400_000;
  return ageDays <= recencyWindowDays;
}
