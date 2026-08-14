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
