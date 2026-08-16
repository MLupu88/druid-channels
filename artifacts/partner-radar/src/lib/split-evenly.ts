// Phase 11.6C: pure, DB-free deterministic "Split evenly" arithmetic for
// Team Targets' AllocateAnnualTargetDialog (components/channel-plan-section
// .tsx). Never calls a mutation and never rounds away real precision --
// see splitMoneyEvenly's cent-level split below for the exact fix to the
// "money target silently loses cents" defect this file corrects.

// Deterministic integer split: `count` non-negative integers summing
// exactly to `total` (total must already be a whole number -- callers
// convert to whole units first, see splitMoneyEvenly/splitCountEvenly).
// The remainder (total - count*floor(total/count)) is assigned one unit
// each to the FIRST `remainder` entries of whatever order the caller
// iterates -- callers pass an already, independently, deterministically
// sorted list (see channel-plan-section.tsx's sortedAllocations), so
// "which entries get the +1" is a stable, explainable rule, never
// incidental to array/object iteration order.
export function splitEvenly(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

// Money metrics (Closed Revenue, Partner-Sourced Pipeline, Partner-
// Influenced Pipeline): the annual target storage/input model permits
// decimal (cent-level) values -- this must never silently round an annual
// money target to the nearest whole dollar just because Split Evenly was
// clicked. Converts to integer CENTS first, splits cents (never dollars)
// with splitEvenly above, then converts each share back to a decimal
// dollar value. Every returned value is guaranteed to have at most 2
// decimal places, and the returned array always sums to exactly
// round(total * 100) / 100 -- currency precision is preserved, never
// silently dropped.
export function splitMoneyEvenly(total: number, count: number): number[] {
  const totalCents = Math.round(total * 100);
  const cents = splitEvenly(totalCents, count);
  // Re-round each share's own cents value (not just divide) so a share is
  // never left as e.g. 33.339999999999996 due to float division -- Math
  // .round(c) is a no-op for the integers splitEvenly already returns, but
  // makes the "cents are always whole" invariant explicit at the boundary
  // where this function hands decimal dollars back to its caller.
  return cents.map((c) => Math.round(c) / 100);
}

// Count metrics (Signed Partners, New Partner Prospects): a partner can
// never be split into a fraction of one -- splits whole units directly,
// never cents. `total` is rounded to the nearest whole unit first (a
// count target should already be a whole number by construction -- see
// EditAnnualTargetDialog's Number.isInteger validation for count metrics
// -- this rounding is a defensive floor, not an expected code path).
export function splitCountEvenly(total: number, count: number): number[] {
  return splitEvenly(Math.round(total), count);
}
