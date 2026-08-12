// Phase 5B-1: pure presentation-only classification of an already-computed
// AnnualCascade response into one of 4 display states. This never
// recomputes unallocated_amount/overallocated_amount/allocated_to_pams
// itself -- those come straight from GET /metric-targets/annual-cascade
// (services/targetService.ts's computeAnnualCascade, already unit-tested
// server-side in annualCascade.test.ts). This module only decides which
// banner/warning commercial-performance.tsx should show for a given
// already-computed result, so that branching logic is unit-testable without
// a live API call or a React rendering harness.
export type AllocationStatus = 'no_target' | 'underallocated' | 'exact' | 'overallocated';

export interface AllocationStatusInput {
  annual_target: number | null;
  unallocated_amount: number | null;
  overallocated_amount: number;
}

// Ordering matters: overallocated_amount > 0 always wins over
// unallocated_amount (the two are mutually exclusive by construction in
// computeAnnualCascade -- at most one of them is ever positive -- but this
// function doesn't assume that invariant, it just checks overallocation
// first since it's the more urgent case to surface).
export function deriveAllocationStatus(cascade: AllocationStatusInput): AllocationStatus {
  if (cascade.annual_target === null) return 'no_target';
  if (cascade.overallocated_amount > 0) return 'overallocated';
  if (cascade.unallocated_amount !== null && cascade.unallocated_amount > 0) return 'underallocated';
  return 'exact';
}
