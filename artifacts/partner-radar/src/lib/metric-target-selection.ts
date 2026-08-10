// Stage 6.1 fix: resolving which metric_targets row an edit dialog should
// preload MUST be unique per (metric_key, period, territory_id). The
// server's GET /metric-targets only filters by metric_key, so the response
// spans every period for that KPI/territory -- matching territory_id alone
// (the previous bug) could silently preload a different period's target
// (e.g. a Q1 target while Q3 was selected). No framework dependency, so
// this is unit-testable in isolation from the rest of the Overview page.
export interface MetricTargetLike {
  period: string;
  territory_id: string | null;
}

export function findExistingTarget<T extends MetricTargetLike>(
  targets: T[] | undefined,
  territoryId: string | null,
  period: string,
): T | undefined {
  return targets?.find((t) => t.territory_id === territoryId && t.period === period);
}
