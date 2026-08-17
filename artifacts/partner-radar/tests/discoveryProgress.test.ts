// Production hotfix: Discovery reliability, diagnostics, and progress UX.
// Pure unit tests for phase inference and summary formatting -- no React
// rendering, no network call. See src/lib/discovery-progress.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferDiscoveryPhase,
  inferActivePhase,
  isScanActive,
  shouldPollDiscoveryProgress,
  formatCompletionSummary,
  formatFailureProgressSummary,
  formatFailureHeader,
  formatRelativeScanTime,
  FUNNEL_GAP_EXPLANATION,
  SCAN_VS_TABLE_EXPLANATION,
  ACTIVE_PHASE_LABEL,
} from "../src/lib/discovery-progress";

function run(overrides: Partial<{ status: string; queries_run: number; candidates_sent_to_llm: number; candidates_qualified: number }>) {
  return { status: "running", queries_run: 0, candidates_sent_to_llm: 0, candidates_qualified: 0, ...overrides };
}

// ---- phase inference (check: correct inferred phase is displayed) --------

test("check: running + queries_run == 0 -> starting", () => {
  assert.equal(inferDiscoveryPhase(run({ status: "running", queries_run: 0 })), "starting");
});

test("check: queued scan (before the first checkpoint) is also 'starting'", () => {
  assert.equal(inferDiscoveryPhase(run({ status: "queued", queries_run: 0 })), "starting");
});

test("check: running + queries_run > 0 and candidates_sent_to_llm == 0 -> searching", () => {
  assert.equal(inferDiscoveryPhase(run({ status: "running", queries_run: 4, candidates_sent_to_llm: 0 })), "searching");
});

test("check: running + candidates_sent_to_llm > candidates_qualified -> qualifying", () => {
  assert.equal(inferDiscoveryPhase(run({ status: "running", queries_run: 4, candidates_sent_to_llm: 5, candidates_qualified: 2 })), "qualifying");
});

test("running, caught up between AI calls (sent === qualified, more than zero) falls back to searching", () => {
  assert.equal(inferDiscoveryPhase(run({ status: "running", queries_run: 4, candidates_sent_to_llm: 5, candidates_qualified: 5 })), "searching");
});

test("check: completed status always reports 'completed', regardless of counters", () => {
  assert.equal(inferDiscoveryPhase(run({ status: "completed", queries_run: 12, candidates_sent_to_llm: 20, candidates_qualified: 7 })), "completed");
});

test("check: failed status always reports 'stopped', regardless of counters", () => {
  assert.equal(inferDiscoveryPhase(run({ status: "failed", queries_run: 6, candidates_sent_to_llm: 12, candidates_qualified: 3 })), "stopped");
});

test("inferActivePhase ignores status entirely -- pure function of counters only", () => {
  assert.equal(inferActivePhase({ queries_run: 0, candidates_sent_to_llm: 0, candidates_qualified: 0 }), "starting");
  assert.equal(inferActivePhase({ queries_run: 4, candidates_sent_to_llm: 0, candidates_qualified: 0 }), "searching");
  assert.equal(inferActivePhase({ queries_run: 4, candidates_sent_to_llm: 5, candidates_qualified: 2 }), "qualifying");
});

// ---- polling gating --------------------------------------------------------

test("check: polling stays active only for queued/running", () => {
  assert.equal(isScanActive("queued"), true);
  assert.equal(isScanActive("running"), true);
});

test("check: polling stops after completed/failed", () => {
  assert.equal(isScanActive("completed"), false);
  assert.equal(isScanActive("failed"), false);
});

// ---- summaries (check: completed scan renders final summary) -------------
//
// Phase 11.6.1 P2 (forensic-audit correction): unique_companies_seen is
// NEVER labeled "companies reviewed" -- it counts distinct-URL results that
// survived dedupe/exclusion/freshness-cache checks, not companies and not
// anything DeepSeek necessarily evaluated. candidates_sent_to_llm (what was
// actually AI-evaluated), candidates_qualified (passed qualifyChecks), and
// results_qualified (= prospectsCreated, genuinely new *persisted* prospect
// rows) are three distinct, independently-persisted counters and must never
// collapse into one "qualified" label -- a candidate can pass qualifyChecks
// and still never become a new prospect (territory suppression, an
// existing active prospect, an ineligible recruitment archetype).

// Fixtures throughout this file respect the real funnel invariant
// (results_qualified <= candidates_qualified <= candidates_sent_to_llm <=
// unique_companies_seen -- see discoveryEngine.ts's attemptLiveDiscovery: a
// persisted prospect always first passed qualifyChecks in the same run,
// which always first was sent to the LLM, which always first was counted
// as a considered result) -- never an example state production cannot
// actually produce.
test("check: completion summary maps every number to its real counter, with honest labels", () => {
  const summary = formatCompletionSummary({
    queries_run: 8, unique_companies_seen: 42, candidates_sent_to_llm: 20, candidates_qualified: 5, results_qualified: 2,
  });
  assert.equal(summary, "Scan complete · 8 searches · 42 results considered · 20 AI-evaluated · 5 passed qualification · 2 new prospects");
});

test("completion summary singularizes counts of exactly 1", () => {
  const summary = formatCompletionSummary({
    queries_run: 1, unique_companies_seen: 1, candidates_sent_to_llm: 1, candidates_qualified: 1, results_qualified: 1,
  });
  assert.equal(summary, "Scan complete · 1 search · 1 result considered · 1 AI-evaluated · 1 passed qualification · 1 new prospect");
});

test("completion summary never labels unique_companies_seen as 'companies reviewed' -- the forensic-audit-confirmed bug", () => {
  const summary = formatCompletionSummary({
    queries_run: 4, unique_companies_seen: 66, candidates_sent_to_llm: 20, candidates_qualified: 0, results_qualified: 0,
  });
  assert.ok(!summary.includes("reviewed"), "unique_companies_seen must never be described as 'reviewed'");
  assert.ok(!/\bcompan(y|ies)\b/.test(summary), "unique_companies_seen must never be described as a count of companies");
  assert.ok(summary.includes("66 results considered"));
});

test("completion summary never uses the same word for candidates_qualified and results_qualified", () => {
  const summary = formatCompletionSummary({
    queries_run: 4, unique_companies_seen: 66, candidates_sent_to_llm: 20, candidates_qualified: 5, results_qualified: 2,
  });
  assert.ok(summary.includes("5 passed qualification"), "candidates_qualified must be labeled distinctly from prospect creation");
  assert.ok(summary.includes("2 new prospects"), "results_qualified (prospectsCreated) must be labeled as new prospects, not as 'qualified'");
  // The two counters must render as two distinct numbers, never merged/deduped.
  assert.notEqual(summary.indexOf("5 passed qualification"), summary.indexOf("2 new prospects"));
});

// ---- zero-result / mixed funnel scenarios (Phase 11.6.1 P2 spec) ---------

test("B: zero-result scan (20 AI-evaluated, 0 passed qualification, 0 new prospects) renders every stage truthfully", () => {
  const summary = formatCompletionSummary({
    queries_run: 4, unique_companies_seen: 66, candidates_sent_to_llm: 20, candidates_qualified: 0, results_qualified: 0,
  });
  assert.equal(summary, "Scan complete · 4 searches · 66 results considered · 20 AI-evaluated · 0 passed qualification · 0 new prospects");
});

test("C: mixed funnel (66 considered, 20 AI-evaluated, 5 passed qualification, 2 new prospects) preserves every distinction", () => {
  const summary = formatCompletionSummary({
    queries_run: 4, unique_companies_seen: 66, candidates_sent_to_llm: 20, candidates_qualified: 5, results_qualified: 2,
  });
  assert.equal(summary, "Scan complete · 4 searches · 66 results considered · 20 AI-evaluated · 5 passed qualification · 2 new prospects");
});

// ---- failure rendering (check: failed scan renders safe failure reason and partial counters) ----

test("check: failure progress summary matches the required compact format, with the same honest results-considered/AI-evaluated/passed-qualification wording", () => {
  const summary = formatFailureProgressSummary({ queries_run: 6, unique_companies_seen: 31, candidates_sent_to_llm: 12, candidates_qualified: 3 });
  assert.equal(summary, "6 searches completed · 31 results considered · 12 AI-evaluated · 3 passed qualification");
});

test("failure progress summary never labels unique_companies_seen as companies found/reviewed", () => {
  const summary = formatFailureProgressSummary({ queries_run: 6, unique_companies_seen: 31, candidates_sent_to_llm: 12, candidates_qualified: 3 });
  assert.ok(!/\bcompan(y|ies)\b/.test(summary));
});

test("check: failure header names the phase the run was in when it stopped, from its own counters", () => {
  const header = formatFailureHeader({ queries_run: 6, candidates_sent_to_llm: 12, candidates_qualified: 3 });
  assert.equal(header, `Scan stopped during ${ACTIVE_PHASE_LABEL.qualifying}`);
  assert.equal(header, "Scan stopped during AI qualification");
});

test("failure header reports 'Starting search' when it failed before any query completed", () => {
  const header = formatFailureHeader({ queries_run: 0, candidates_sent_to_llm: 0, candidates_qualified: 0 });
  assert.equal(header, "Scan stopped during Starting search");
});

// ---- no fake percentage ----------------------------------------------------

test("check: no percentage value appears anywhere in phase labels or summary strings", () => {
  const haystacks = [
    ...Object.values(ACTIVE_PHASE_LABEL),
    formatCompletionSummary({ queries_run: 8, unique_companies_seen: 42, candidates_sent_to_llm: 20, candidates_qualified: 5, results_qualified: 2 }),
    formatFailureProgressSummary({ queries_run: 6, unique_companies_seen: 31, candidates_sent_to_llm: 12, candidates_qualified: 3 }),
    formatFailureHeader({ queries_run: 6, candidates_sent_to_llm: 12, candidates_qualified: 3 }),
  ];
  for (const text of haystacks) {
    assert.ok(!text.includes("%"), `unexpected percentage in: ${text}`);
  }
});

// ---- shouldPollDiscoveryProgress (polling startup race fix) --------------

test("check: mutation pending + no active cached run => polling enabled", () => {
  const configs = [{ last_run: { status: "completed" } }, { last_run: null }];
  assert.equal(shouldPollDiscoveryProgress(true, configs), true);
});

test("check: mutation not pending + active persisted run => polling enabled", () => {
  const configs = [{ last_run: { status: "completed" } }, { last_run: { status: "running" } }];
  assert.equal(shouldPollDiscoveryProgress(false, configs), true);
});

test("check: mutation not pending + completed/failed run => polling disabled", () => {
  const configs = [{ last_run: { status: "completed" } }, { last_run: { status: "failed" } }];
  assert.equal(shouldPollDiscoveryProgress(false, configs), false);
});

test("mutation not pending + no configs/last_run at all => polling disabled", () => {
  assert.equal(shouldPollDiscoveryProgress(false, undefined), false);
  assert.equal(shouldPollDiscoveryProgress(false, [{ last_run: null }]), false);
});

test("mutation pending takes priority even while cached data still shows a stale completed run (the actual race)", () => {
  // The exact production race: user clicks Run, POST is in flight, but the
  // cached scan-config list still reflects the *previous* completed run --
  // polling must still turn on immediately.
  const staleConfigs = [{ last_run: { status: "completed" } }];
  assert.equal(shouldPollDiscoveryProgress(true, staleConfigs), true);
});

test("queued (not yet running) persisted run also counts as active for polling", () => {
  assert.equal(shouldPollDiscoveryProgress(false, [{ last_run: { status: "queued" } }]), true);
});

// ---- E. "Last scan" is a scan-run-level timestamp, separate from evidence age ----
//
// Phase 11.6.1 P2: formatRelativeScanTime answers "when did the latest scan
// run" only -- it is never used to describe an individual prospect (that's
// the separate, prospect-level "Evidence age" column, sourced from
// last_researched_at / latest signal discovered_at, not from any scan_runs
// row). A prospect skipped by the freshness cache during a scan receives no
// write at all, so this function/label must never be attributed to it.

test("formatRelativeScanTime: a timestamp from right now reads 'just now'", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  assert.equal(formatRelativeScanTime("2026-03-01T12:00:00Z", now), "just now");
});

test("formatRelativeScanTime: minutes-old timestamps render as 'N mins ago'", () => {
  const now = new Date("2026-03-01T12:12:00Z");
  assert.equal(formatRelativeScanTime("2026-03-01T12:00:00Z", now), "12 mins ago");
});

test("formatRelativeScanTime: singularizes exactly 1 minute", () => {
  const now = new Date("2026-03-01T12:01:00Z");
  assert.equal(formatRelativeScanTime("2026-03-01T12:00:00Z", now), "1 min ago");
});

test("formatRelativeScanTime: hours-old timestamps render as 'N hrs ago'", () => {
  const now = new Date("2026-03-01T15:00:00Z");
  assert.equal(formatRelativeScanTime("2026-03-01T12:00:00Z", now), "3 hrs ago");
});

test("formatRelativeScanTime: day-old-or-more timestamps render as 'N days ago'", () => {
  const now = new Date("2026-03-03T12:00:00Z");
  assert.equal(formatRelativeScanTime("2026-03-01T12:00:00Z", now), "2 days ago");
});

test("formatRelativeScanTime never claims a per-company/per-prospect check -- it only ever describes 'a scan', not a company", () => {
  const rendered = formatRelativeScanTime("2026-03-01T12:00:00Z", new Date("2026-03-01T12:05:00Z"));
  for (const forbidden of ["compan", "prospect", "checked"]) {
    assert.ok(!rendered.toLowerCase().includes(forbidden), `formatRelativeScanTime's output must never reference "${forbidden}"`);
  }
});

// ---- D/J. explanatory copy stays honest -- no fabricated per-stage numbers ----

test("FUNNEL_GAP_EXPLANATION never invents a specific rejection-stage number the backend doesn't track", () => {
  // The forensic audit confirmed no counter exists for excluded-domain
  // skips, freshness-cache skips, the post-cap skip, candidate-level AI
  // failures, ineligible-archetype rejections, or territory suppression --
  // this copy must stay qualitative, never attribute an exact count to any
  // one of them.
  assert.ok(!/\d/.test(FUNNEL_GAP_EXPLANATION), "no digit may appear in the generic funnel-gap explanation");
});

test("FUNNEL_GAP_EXPLANATION says 'Results', never 'candidates' or 'companies' -- duplication/recency happen to raw results, before anything is evaluated as a candidate", () => {
  assert.ok(FUNNEL_GAP_EXPLANATION.startsWith("Results "));
  assert.ok(!/\bcandidates?\b/i.test(FUNNEL_GAP_EXPLANATION));
  assert.ok(!/\bcompan(y|ies)\b/i.test(FUNNEL_GAP_EXPLANATION));
});

test("SCAN_VS_TABLE_EXPLANATION never says 'company'/'companies' either -- stays consistent with 'results considered' / 'new prospects'", () => {
  assert.ok(!/\bcompan(y|ies)\b/i.test(SCAN_VS_TABLE_EXPLANATION));
});

test("SCAN_VS_TABLE_EXPLANATION makes the scan-summary vs. persisted-table distinction explicit", () => {
  assert.ok(SCAN_VS_TABLE_EXPLANATION.toLowerCase().includes("saved"));
  assert.ok(!/\d/.test(SCAN_VS_TABLE_EXPLANATION), "no digit may appear in this static explanatory copy either");
});
