// Phase 11.3: the same 5 tone/color pairing (emerald/amber/rose/blue/slate)
// was hand-copied as literal Tailwind strings across Recruitment, Portfolio,
// Campaigns, Opportunities, and Channel Radar's badge components. This is
// presentation only -- which BUSINESS state maps to which tone stays a
// per-page decision (each page's own STAGE_LABELS/STATUS_LABELS etc. are
// untouched); this just gives the 5 shared color strings one source.
//
// Deliberately NOT used for every badge in the app: Recruitment's 7-stage
// StageBadge uses indigo/violet shades specifically to show forward
// progress through the funnel, and a few badges (opportunity attribution
// type, "pushed to HubSpot") use one-off categorical hues -- both are
// distinct visual meanings, not duplication, so they keep their own maps.
//
// Phase 11.6A: this remains the single canonical success/warning/danger/
// info/neutral mapping -- index.css now also carries a matching --attention/
// --destructive design-token pair for components that want a token instead
// of a literal (e.g. metric-tile.tsx's `attention` prop). The literal
// Tailwind strings below are deliberately left unchanged in this slice:
// migrating STATUS_TONE_CLASS onto the new tokens would shift the exact
// rendered color on every page that already consumes it (Recruitment,
// Portfolio, Campaigns, Opportunities, Channel Radar, Team Targets), which
// belongs to whichever later 11.6 slice actually touches each of those
// pages, not this foundation-only slice.
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger: 'bg-rose-50 text-rose-700 border-rose-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  neutral: 'bg-slate-50 text-slate-700 border-slate-200',
};

export function statusTone(tone: StatusTone): string {
  return STATUS_TONE_CLASS[tone];
}
