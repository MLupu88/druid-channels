import type { WeeklyTargetProgress } from '@workspace/api-client-react';

export type WeeklyTeamTargetLabel = 'behind' | 'unavailable' | 'ahead' | 'no_target';

// Four states, not a boolean, with a truthful precedence: any genuinely
// behind territory -> "behind"; otherwise any territory whose actual is
// unavailable -> "unavailable" (a set containing an unknown actual is never
// summarized as fully "ahead"); otherwise any ahead -> "ahead"; otherwise
// (only no_target territories, or none) -> "no_target" -- a fabricated
// status for a territory nobody set a target for would be dishonest.
export function aggregateTargetLabel(targets: ReadonlyArray<Pick<WeeklyTargetProgress, 'status'>>): WeeklyTeamTargetLabel {
  if (targets.some((t) => t.status === 'behind')) return 'behind';
  if (targets.some((t) => t.status === 'unavailable')) return 'unavailable';
  if (targets.some((t) => t.status === 'ahead')) return 'ahead';
  return 'no_target';
}
