// Production hotfix: Discovery reliability, diagnostics, and progress UX.
// Pure, deterministic phase inference and summary formatting from a
// scan_run's *real* persisted counters -- never a fabricated/interpolated
// percentage. See routes/scan_configs.ts's shapeLastRun /
// routes/scans.ts's list mapping for where these counters come from
// (written incrementally while the scan is running, see
// discoveryEngine.ts's writeScanRunProgress).

export interface ScanRunCounters {
  queries_run: number;
  unique_companies_seen: number;
  new_companies_count: number;
  duplicates_removed: number;
  candidates_sent_to_llm: number;
  candidates_qualified: number;
}

export interface ScanRunLike extends ScanRunCounters {
  status: string; // "queued" | "running" | "completed" | "failed"
  results_found: number;
  results_qualified: number;
  error_message: string | null;
}

// The three "in progress" phases -- derived purely from counters, never
// from elapsed time or a fabricated percentage.
export type ActivePhase = "starting" | "searching" | "qualifying";
export type DiscoveryPhase = ActivePhase | "completed" | "stopped";

export const ACTIVE_PHASE_LABEL: Record<ActivePhase, string> = {
  starting: "Starting search",
  searching: "Searching and reviewing companies",
  qualifying: "AI qualification",
};

export const PHASE_LABEL: Record<DiscoveryPhase, string> = {
  ...ACTIVE_PHASE_LABEL,
  completed: "Completed",
  stopped: "Stopped",
};

// Counter-only phase inference, independent of status -- reused both for a
// running scan's live phase and (given a failed run's last-known counters)
// for "which phase was in progress when it stopped".
export function inferActivePhase(counters: Pick<ScanRunCounters, "queries_run" | "candidates_sent_to_llm" | "candidates_qualified">): ActivePhase {
  if (counters.queries_run === 0) return "starting";
  if (counters.candidates_sent_to_llm === 0) return "searching";
  if (counters.candidates_sent_to_llm > counters.candidates_qualified) return "qualifying";
  return "searching"; // caught up between AI calls, e.g. between adaptive-expansion batches
}

export function inferDiscoveryPhase(run: Pick<ScanRunLike, "status" | "queries_run" | "candidates_sent_to_llm" | "candidates_qualified">): DiscoveryPhase {
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "stopped";
  return inferActivePhase(run);
}

// True only while there's an active run worth polling for -- queued/running.
// Used to decide when to start/stop the frontend's short polling interval.
export function isScanActive(status: string): boolean {
  return status === "queued" || status === "running";
}

// Correctness fix: POST /scans/run is a long synchronous call -- the
// frontend's cached scan-config list can still show the *previous*
// completed/failed run for the entire duration of that request, so gating
// polling on cached data alone means the newly-inserted "running" row is
// never observed until the POST itself resolves. Polling must also turn on
// the instant the mutation is fired (mutationPending), before any fresh
// data has come back at all -- not just when a persisted run already looks
// active.
export function shouldPollDiscoveryProgress(
  mutationPending: boolean,
  configs: ReadonlyArray<{ last_run?: Pick<ScanRunLike, "status"> | null }> | undefined,
): boolean {
  const hasActivePersistedRun = (configs ?? []).some((c) => c.last_run && isScanActive(c.last_run.status));
  return mutationPending || hasActivePersistedRun;
}

// Phase 11.6.1 P2 (forensic-audit correction): unique_companies_seen counts
// distinct-URL search results that survived URL dedupe, the excluded-domain
// check, and the freshness-cache check -- it is NOT a count of companies,
// and it is NOT a count of anything DeepSeek actually evaluated (that's
// candidates_sent_to_llm, capped separately at MAX_CANDIDATES_TO_LLM and
// counted after this stage). "results considered" is the honest label; the
// old "N companies reviewed" wording implied both AI evaluation and a
// company-level count that this counter was never able to guarantee.
//
// candidates_qualified (passed qualifyChecks) and results_qualified (=
// prospectsCreated, genuinely new *persisted* prospect rows -- see
// discoveryEngine.ts's persistCandidate/runDiscoveryForConfig) are two
// different, real, independently-persisted counters and must never share a
// label: a candidate can pass qualifyChecks and still never become a new
// prospect (territory suppression, an existing active prospect, an
// ineligible recruitment archetype) -- see the forensic audit's funnel
// trace. Every number below maps to exactly one real scan_runs column;
// nothing here is inferred, estimated, or attributed to a specific
// rejection stage the backend doesn't actually track (see
// FUNNEL_GAP_EXPLANATION below for what stays unknowable).
export function formatCompletionSummary(
  run: Pick<ScanRunLike, "queries_run" | "unique_companies_seen" | "candidates_sent_to_llm" | "candidates_qualified" | "results_qualified">,
): string {
  const parts = [
    `${run.queries_run} search${run.queries_run === 1 ? "" : "es"}`,
    `${run.unique_companies_seen} result${run.unique_companies_seen === 1 ? "" : "s"} considered`,
    `${run.candidates_sent_to_llm} AI-evaluated`,
    `${run.candidates_qualified} passed qualification`,
    `${run.results_qualified} new prospect${run.results_qualified === 1 ? "" : "s"}`,
  ];
  return `Scan complete · ${parts.join(" · ")}`;
}

export function formatFailureProgressSummary(
  run: Pick<ScanRunLike, "queries_run" | "unique_companies_seen" | "candidates_sent_to_llm" | "candidates_qualified">,
): string {
  const parts = [
    `${run.queries_run} search${run.queries_run === 1 ? "" : "es"} completed`,
    `${run.unique_companies_seen} result${run.unique_companies_seen === 1 ? "" : "s"} considered`,
    `${run.candidates_sent_to_llm} AI-evaluated`,
    `${run.candidates_qualified} passed qualification`,
  ];
  return parts.join(" · ");
}

// A static, deliberately non-numeric explanation for the gap between
// candidates_qualified and results_qualified (and between
// unique_companies_seen and candidates_sent_to_llm) -- several real
// rejection stages (excluded-domain skip, freshness-cache skip, the
// per-run AI-evaluation cap, a candidate-level AI failure, an ineligible
// recruitment archetype, territory suppression) currently have no
// individual counter at all (see the forensic audit). This note is
// deliberately generic rather than attributing an exact number to any one
// of those stages, which the backend cannot currently support. Worded as
// "results" (not "candidates" or "companies") so it stays accurate at
// every stage this spans: duplication and the freshness-cache/recency skip
// happen to raw search results, before anything has been evaluated as a
// "candidate" in the qualifyChecks sense at all -- "results" is the one
// noun that's honest across the whole span, and matches the "results
// considered" label already used above it.
export const FUNNEL_GAP_EXPLANATION =
  "Results can be excluded by recency, duplication, eligibility, or identity checks before becoming prospects.";

// The prospect table below always shows the persisted dataset (GET
// /prospects), never a live view of "everything the last scan touched" --
// a scan can legitimately consider far more results than it ever creates
// or updates a row for (see FUNNEL_GAP_EXPLANATION above).
export const SCAN_VS_TABLE_EXPLANATION =
  "This table shows prospects that passed Discovery and were saved, not every result considered during the scan.";

// Phase 11.6.1 P2: "Last scan" is a scan-run-level timestamp only
// (scan_runs.completed_at, falling back to started_at for the rare case a
// terminal row somehow lacks one) -- it answers "when did the latest scan
// run", never "when was this specific prospect checked" (see
// components/../pages/prospects.tsx's FreshnessLabel/"Evidence age" column
// for that separate, prospect-level concept, itself sourced from
// last_researched_at / latest signal discovered_at, not from any scan_runs
// row). A prospect skipped by the freshness cache during a scan receives no
// write at all, so this timestamp must never be attributed to it.
export function formatRelativeScanTime(isoTimestamp: string, now: Date = new Date()): string {
  const thenMs = new Date(isoTimestamp).getTime();
  const diffMs = Math.max(0, now.getTime() - thenMs);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min${diffMinutes === 1 ? "" : "s"} ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

// "Scan stopped during {phase}" -- the phase the run was in when it failed,
// derived from its own last-known counters (safe: never reads stopped_reason
// as display text directly, see the module header).
export function formatFailureHeader(run: Pick<ScanRunLike, "queries_run" | "candidates_sent_to_llm" | "candidates_qualified">): string {
  return `Scan stopped during ${ACTIVE_PHASE_LABEL[inferActivePhase(run)]}`;
}
