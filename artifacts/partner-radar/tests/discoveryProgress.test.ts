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

test("check: completion summary matches the required compact format", () => {
  const summary = formatCompletionSummary({ queries_run: 8, unique_companies_seen: 42, results_qualified: 7 });
  assert.equal(summary, "Scan complete · 8 searches · 42 companies reviewed · 7 qualified prospects");
});

test("completion summary singularizes counts of exactly 1", () => {
  const summary = formatCompletionSummary({ queries_run: 1, unique_companies_seen: 1, results_qualified: 1 });
  assert.equal(summary, "Scan complete · 1 search · 1 company reviewed · 1 qualified prospect");
});

// ---- failure rendering (check: failed scan renders safe failure reason and partial counters) ----

test("check: failure progress summary matches the required compact format", () => {
  const summary = formatFailureProgressSummary({ queries_run: 6, unique_companies_seen: 31, candidates_sent_to_llm: 12 });
  assert.equal(summary, "6 searches completed · 31 companies found · 12 sent for qualification");
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
    formatCompletionSummary({ queries_run: 8, unique_companies_seen: 42, results_qualified: 7 }),
    formatFailureProgressSummary({ queries_run: 6, unique_companies_seen: 31, candidates_sent_to_llm: 12 }),
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
