// Stage 6.3: mirrors the tiny pure calendar arithmetic in the backend's
// kpiRegistry.ts (getCurrentYear/getCurrentQuarterKey/joinPeriodKey/
// splitPeriodKey) so the UI can render year/quarter pickers and a sane
// default without a round-trip. This is safe to duplicate -- "which
// quarter does today fall in" has exactly one correct answer, unlike
// business-meaning lists (e.g. targetable metrics), which the frontend
// deliberately never hardcodes and always gets from the API instead.
export const QUARTER_KEYS = ["q1", "q2", "q3", "q4", "ytd"] as const;
export type QuarterKey = (typeof QUARTER_KEYS)[number];

const PERIOD_KEY_PATTERN = /^(\d{4})-(q1|q2|q3|q4|ytd)$/;

export function getCurrentYear(): number {
  return new Date().getFullYear();
}

export function getCurrentQuarterKey(): QuarterKey {
  const month = new Date().getMonth();
  if (month <= 2) return "q1";
  if (month <= 5) return "q2";
  if (month <= 8) return "q3";
  return "q4";
}

export function joinPeriodKey(year: number, quarterKey: QuarterKey): string {
  return `${year}-${quarterKey}`;
}

export interface SplitPeriodKey {
  year: number;
  quarterKey: QuarterKey;
}

export function splitPeriodKey(periodKey: string | undefined | null): SplitPeriodKey | null {
  if (!periodKey) return null;
  const match = PERIOD_KEY_PATTERN.exec(periodKey);
  if (!match) return null;
  return { year: Number(match[1]), quarterKey: match[2] as QuarterKey };
}

export function getDefaultPeriodKey(): string {
  return joinPeriodKey(getCurrentYear(), getCurrentQuarterKey());
}

const QUARTER_LABELS: Record<QuarterKey, string> = { q1: "Q1", q2: "Q2", q3: "Q3", q4: "Q4", ytd: "Year to date" };

export function quarterLabel(quarterKey: QuarterKey, year: number): string {
  if (quarterKey === "ytd") return year === getCurrentYear() ? "Year to date" : `${year} (full year)`;
  return QUARTER_LABELS[quarterKey];
}

// Current year + previous year -- "current date" half of the dynamic-year
// requirement (the "years represented in stored data" half is deliberately
// deferred, see the Stage 6.3 report). Always includes next year too once
// Q4 is selected, so choosing next year is only ever a click away without
// waiting for the calendar to actually roll over.
export function yearOptions(): number[] {
  const current = getCurrentYear();
  return [current - 1, current, current + 1];
}

// Phase 7: Monday-anchored week identity, mirroring the backend's
// kpiService.mondayOf/weeklyReportingService.weekEndExclusive exactly --
// pure calendar math, safe to duplicate client-side (see this file's own
// header comment on that distinction). week_start is always the canonical
// Monday (YYYY-MM-DD) the API expects.
export function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

export function getDefaultWeekStart(): string {
  return mondayOf(new Date());
}

export function addWeeks(weekStart: string, delta: number): string {
  const d = new Date(weekStart + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + delta * 7);
  return d.toISOString().slice(0, 10);
}

export function weekEndInclusive(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function weekLabel(weekStart: string): string {
  const start = new Date(weekStart + "T00:00:00.000Z");
  const end = new Date(weekEndInclusive(weekStart) + "T00:00:00.000Z");
  const isCurrent = weekStart === getDefaultWeekStart();
  const range = `${SHORT_DATE.format(start)} – ${SHORT_DATE.format(end)}`;
  return isCurrent ? `${range} (this week)` : range;
}
