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

export function formatCompletionSummary(run: Pick<ScanRunLike, "queries_run" | "unique_companies_seen" | "results_qualified">): string {
  return `Scan complete · ${run.queries_run} search${run.queries_run === 1 ? "" : "es"} · ${run.unique_companies_seen} compan${run.unique_companies_seen === 1 ? "y" : "ies"} reviewed · ${run.results_qualified} qualified prospect${run.results_qualified === 1 ? "" : "s"}`;
}

export function formatFailureProgressSummary(run: Pick<ScanRunLike, "queries_run" | "unique_companies_seen" | "candidates_sent_to_llm">): string {
  return `${run.queries_run} search${run.queries_run === 1 ? "" : "es"} completed · ${run.unique_companies_seen} compan${run.unique_companies_seen === 1 ? "y" : "ies"} found · ${run.candidates_sent_to_llm} sent for qualification`;
}

// "Scan stopped during {phase}" -- the phase the run was in when it failed,
// derived from its own last-known counters (safe: never reads stopped_reason
// as display text directly, see the module header).
export function formatFailureHeader(run: Pick<ScanRunLike, "queries_run" | "candidates_sent_to_llm" | "candidates_qualified">): string {
  return `Scan stopped during ${ACTIVE_PHASE_LABEL[inferActivePhase(run)]}`;
}
