// Phase 10: pure client-side grouping for Channel Radar's "Group by entity"
// toggle -- a plain transform over the current page's already-fetched
// signals, never a new endpoint or subsystem. Sorted alphabetically by
// entity name so the grouping is stable across re-renders regardless of the
// underlying list's own (discovered_at) order.
export interface GroupableSignal {
  entity_name: string;
}

export function groupSignalsByEntity<T extends GroupableSignal>(rows: T[]): Array<[string, T[]]> {
  const byEntity = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.entity_name;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key)!.push(row);
  }
  return Array.from(byEntity.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

// Pure pagination-window math for the list footer ("Showing X-Y of Z" +
// Prev/Next enablement).
//
// Phase 10 fix: hasNextPage previously used a length-based heuristic
// (`rowCount === pageSize`) -- that heuristic cannot distinguish "exactly
// one full page's worth of matches" from "more than a page's worth," so a
// filtered set of EXACTLY pageSize rows produced an enabled Next button
// leading to a genuinely empty page 2. hasNextPage now requires the real
// server-side filtered total (GET /channel-radar/summary's `total`, under
// the SAME active filters as the list request -- see channel-radar.tsx).
//
// `total` is `undefined` only while that request's first response hasn't
// arrived yet -- treated conservatively as "not yet proven," never as
// "assume more pages exist" (hasNextPage: false), so a slow/loading summary
// can never wrongly enable Next.
export interface ListPageRange {
  start: number;
  end: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

// Phase 11.6.1 Radar recency fix: the list table's single date cell (and
// the drawer's headline date) must never present Radar's own observation
// time as if it were the article's real date -- a signal discovered today
// about a year-old article must never visually imply "this happened
// today." Prefers the verified article date (source_published_at) when one
// actually exists; otherwise falls back to when this system last saw
// corroborating evidence (last_evidence_at), or -- for legacy rows that
// never had one -- when it was first discovered. The label always names
// what the date actually is; the cell content is never bare/unlabeled.
export interface RadarSignalDateFields {
  source_published_at?: string | null;
  last_evidence_at: string;
  discovered_at: string;
}

export function formatRadarSignalDate(signal: RadarSignalDateFields): { label: string; date: string } {
  if (signal.source_published_at) return { label: "Published", date: signal.source_published_at };
  if (signal.last_evidence_at) return { label: "Last seen", date: signal.last_evidence_at };
  return { label: "First discovered", date: signal.discovered_at };
}

export function computeListPageRange(page: number, pageSize: number, rowCount: number, total: number | undefined): ListPageRange {
  const offset = page * pageSize;
  const start = rowCount > 0 ? offset + 1 : 0;
  const end = total === undefined ? offset + rowCount : Math.min(offset + rowCount, total);
  return {
    start,
    end,
    hasPreviousPage: page > 0,
    hasNextPage: total !== undefined && offset + rowCount < total,
  };
}
