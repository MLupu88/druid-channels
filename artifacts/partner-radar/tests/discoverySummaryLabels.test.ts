// Phase 11.6.1 P2: structural/pure tests proving the Discovery
// truthfulness/observability fixes are actually wired up in prospects.tsx
// (and the "Evidence age" rename in my-prospects.tsx) -- same source-text-
// boundary convention as tests/evidenceInterpretationHierarchy.test.ts /
// tests/connectionProviderMeta.test.ts. Pure-function behavior (the actual
// wording/mapping) is covered by tests/discoveryProgress.test.ts; this file
// only proves the page renders through those functions/constants rather
// than a hand-copied or reverted string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf-8");

const prospectsSource = read("../src/pages/prospects.tsx");
const myProspectsSource = read("../src/pages/my-prospects.tsx");

// ---- D. "Freshness" column no longer implies scan recency -----------------

test("prospects.tsx: the prospect table's column header is 'Evidence age', not the ambiguous 'Freshness'", () => {
  assert.ok(prospectsSource.includes("<TableHead>Evidence age</TableHead>"));
  assert.ok(!prospectsSource.includes("<TableHead>Freshness</TableHead>"), "the ambiguous column header must be gone");
});

test("my-prospects.tsx: the same column rename applies -- both prospect tables use the same honest label", () => {
  assert.ok(myProspectsSource.includes("<TableHead>Evidence age</TableHead>"));
  assert.ok(!myProspectsSource.includes("<TableHead>Freshness</TableHead>"));
});

test("prospects.tsx: the existing freshness_days/is_stale rendered values (Today / Nd ago) are unchanged -- only the column label moved, not computeFreshness's output", () => {
  assert.ok(prospectsSource.includes("freshnessDays === 0 ? 'Today' : `${freshnessDays}d ago`"));
  assert.ok(prospectsSource.includes("freshnessDays={prospect.freshness_days}"));
});

// ---- E. "Last scan" is shown separately from evidence age, scan-level only ----

test("prospects.tsx: a 'Last scan' line is rendered from the scan run's own timestamp via formatRelativeScanTime", () => {
  assert.ok(prospectsSource.includes("import {") && prospectsSource.includes("formatRelativeScanTime"), "expected formatRelativeScanTime to be imported");
  assert.ok(prospectsSource.includes('data-testid="text-last-scan-time"'));
  assert.ok(prospectsSource.includes("Last scan: {formatRelativeScanTime(lastScanTime)}"));
});

test("prospects.tsx: 'Last scan' is sourced from scan_runs.completed_at (falling back to started_at), never from a per-prospect field", () => {
  const idx = prospectsSource.indexOf("const lastScanTime = lastRun.completed_at ?? lastRun.started_at;");
  assert.notEqual(idx, -1, "expected Last scan's timestamp to come from the scan run itself, not a prospect row");
});

test("prospects.tsx: 'Last scan' renders for both the completed and failed branches of renderScanStatus", () => {
  const fnStart = prospectsSource.indexOf("function renderScanStatus()");
  const fnEnd = prospectsSource.indexOf("\n  return (\n    <div className=\"flex flex-col h-full w-full overflow-hidden relative\">", fnStart);
  const fnSource = prospectsSource.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  const occurrences = fnSource.match(/Last scan: \{formatRelativeScanTime\(lastScanTime\)\}/g) ?? [];
  assert.equal(occurrences.length, 2, "expected Last scan to render in both the completed and failed status branches");
});

// ---- A/B/C. scan summary is wired through the real (relabeled) formatter --

test("prospects.tsx: the completion summary line renders through formatCompletionSummary, not a hand-copied string", () => {
  assert.ok(prospectsSource.includes("<span>{formatCompletionSummary(lastRun)}</span>"));
});

test("prospects.tsx: the running-progress panel no longer labels unique_companies_seen as 'Companies found', or candidates_qualified as 'Qualified prospects'", () => {
  assert.ok(prospectsSource.includes("Results considered: <span"), "expected the honest 'Results considered' label in the running panel");
  assert.ok(!prospectsSource.includes("Companies found: <span"), "the old 'Companies found' label must be gone");
  assert.ok(prospectsSource.includes("Passed qualification: <span"), "expected 'Passed qualification', distinct from 'new prospects'");
  assert.ok(!prospectsSource.includes("Qualified prospects: <span"), "the old ambiguous 'Qualified prospects' label (for candidates_qualified) must be gone");
});

test("prospects.tsx: new_companies_count is never labeled 'New candidates' -- it counts evidence-domain novelty, not canonical candidate companies", () => {
  // Traced in discoveryEngine.ts: newCompaniesCount++ fires on the raw
  // evidence-URL hostname (before toRegistrableDomain/identity resolution)
  // not already present in companies.domain -- a third-party publisher
  // domain the app has never seen counts here even if the actual subject
  // company is already well-known, so "candidates" would overclaim.
  assert.ok(!prospectsSource.includes("New candidates: <span"), "the old 'New candidates' label must be gone");
  assert.ok(prospectsSource.includes("New domains seen: <span className=\"text-foreground font-medium\">{run.new_companies_count}</span>"));
});

test("prospects.tsx: the run-scan success toast never says a prospect is 'qualified for review' -- results_qualified is prospectsCreated, not a pending state", () => {
  assert.ok(!prospectsSource.includes("qualified for review"), "the misleading 'qualified for review' phrasing must be fully removed from the frontend");
  assert.ok(prospectsSource.includes("new prospect"), "expected the toast fallback to describe results_qualified as new prospects");
});

// ---- Section 5: no fabricated rejection-stage breakdown --------------------

test("prospects.tsx: the funnel-gap explanation renders via the shared FUNNEL_GAP_EXPLANATION constant, not an ad hoc numeric breakdown", () => {
  assert.ok(prospectsSource.includes('data-testid="text-funnel-gap-explanation"'));
  assert.ok(prospectsSource.includes("{FUNNEL_GAP_EXPLANATION}"));
  for (const forbidden of ["cached\"", "excluded\"", "identity failures\""]) {
    assert.ok(!prospectsSource.includes(forbidden), `must not fabricate a specific rejection-stage count like "${forbidden}"`);
  }
});

// ---- Section 7: scan summary vs. persisted table distinction --------------

test("prospects.tsx: a plain-language note distinguishes the scan summary from the persisted prospect table", () => {
  assert.ok(prospectsSource.includes('data-testid="text-scan-vs-table-explanation"'));
  assert.ok(prospectsSource.includes("{SCAN_VS_TABLE_EXPLANATION}"));
});

// ---- F. Live/Demo badge semantics are unchanged ----------------------------

test("prospects.tsx: DataStatusBadge still renders 'Live sources' for data_status='connected' and is unchanged by this fix", () => {
  const badgeStart = prospectsSource.indexOf("function DataStatusBadge(");
  const badgeEnd = prospectsSource.indexOf("\n}", badgeStart);
  const badgeSource = prospectsSource.slice(badgeStart, badgeEnd);
  assert.ok(badgeSource.includes("dataStatus === 'connected'"));
  assert.ok(badgeSource.includes(">Live sources<"));
  assert.ok(badgeSource.includes(">Demo data<"));
});

test("prospects.tsx: DataStatusBadge is still rendered alongside the completion summary, unchanged placement", () => {
  assert.ok(prospectsSource.includes("<DataStatusBadge dataStatus={lastRun.data_status} />"));
});

// ---- backend message wording (routes/scans.ts) -----------------------------

test("routes/scans.ts: the scan-completion message never says 'qualified for review' -- it distinguishes candidates identified from new prospects created", () => {
  const scansRouteSource = read("../../api-server/src/routes/scans.ts");
  // Sliced to the actual `message:` value expressions only -- this file's
  // own explanatory comment legitimately quotes the old "qualified for
  // review" phrasing when describing what changed.
  const messageStart = scansRouteSource.indexOf("message:\n");
  const messageEnd = scansRouteSource.indexOf("}));", messageStart);
  const messageSource = scansRouteSource.slice(messageStart, messageEnd);
  assert.ok(messageSource.includes("Scan completed"), "expected to find the actual message template literals");
  assert.ok(!messageSource.includes("qualified for review"), "the rendered message value must never say 'qualified for review'");
  assert.ok(messageSource.includes("candidate") && messageSource.includes("identified"));
  assert.ok(messageSource.includes("new prospect"));
});
