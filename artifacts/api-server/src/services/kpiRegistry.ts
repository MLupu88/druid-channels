// The canonical list of KPIs shown across the three Overview tables. Every
// metric_key here must have exactly one row in metric_mappings (seeded by
// ensureMetricMappingsSeeded). This registry is the single place that
// declares a metric's label and which table(s) it appears in, so kpis.ts
// and kpiService.ts can never drift into computing the same metric two
// different ways.
export type MetricView = "partner_development" | "weekly_commercial" | "weekly_marketing";
export type SourceType = "PARTNER_RADAR" | "HUBSPOT" | "ACTIVITIES" | "MANUAL" | "DEMO" | "NOT_CONNECTED";

export interface MetricDefinition {
  key: string;
  label: string;
  views: MetricView[];
  defaultSourceType: SourceType;
}

export const METRIC_REGISTRY: MetricDefinition[] = [
  { key: "new_partner_prospects", label: "New Partner Prospects", views: ["partner_development"], defaultSourceType: "PARTNER_RADAR" },
  { key: "signed_partners", label: "Signed Partners", views: ["partner_development"], defaultSourceType: "PARTNER_RADAR" },
  { key: "active_onboarding", label: "Active Onboarding", views: ["partner_development"], defaultSourceType: "DEMO" },
  { key: "certified_partners", label: "Certified Partners", views: ["partner_development"], defaultSourceType: "DEMO" },
  { key: "partner_sourced_pipeline", label: "Partner-Sourced Pipeline", views: ["partner_development", "weekly_commercial"], defaultSourceType: "PARTNER_RADAR" },
  { key: "partner_influenced_pipeline", label: "Partner-Influenced Pipeline", views: ["partner_development"], defaultSourceType: "PARTNER_RADAR" },
  { key: "closed_revenue", label: "Closed Revenue", views: ["partner_development", "weekly_commercial"], defaultSourceType: "PARTNER_RADAR" },
  { key: "renewals", label: "Renewals", views: ["partner_development"], defaultSourceType: "PARTNER_RADAR" },
  // Phase 5A: now backed by partner_opportunities.opportunity_date -- was a
  // DEMO stub before this table existed.
  { key: "opportunities_created", label: "Opportunities Created", views: ["weekly_commercial"], defaultSourceType: "PARTNER_RADAR" },
  { key: "renewals_due", label: "Renewals Due", views: ["weekly_commercial"], defaultSourceType: "DEMO" },
  { key: "renewals_closed", label: "Renewals Closed", views: ["weekly_commercial"], defaultSourceType: "DEMO" },
  { key: "joint_campaigns", label: "Joint Campaigns", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "events", label: "Events", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "webinars", label: "Webinars", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "marketing_qualified_leads", label: "Marketing Qualified Leads", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "partner_referrals", label: "Partner Referrals", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
];

export const METRIC_BY_KEY = new Map(METRIC_REGISTRY.map((m) => [m.key, m]));

// Stage 6.2: the curated set of metrics a PAM can be given a Team Targets
// target against. Deliberately small -- not every Overview KPI is a
// sensible PAM performance objective (e.g. active_onboarding/
// certified_partners are still DEMO-sourced, not production-ready; Channel
// Radar signal counts are intelligence, not a PAM's own output). This is
// the single source of truth: the API is the only place this list is
// declared, and the frontend (Team Targets, My Targets) only ever renders
// whatever rows the API returns -- it carries no metric list of its own,
// so the two can never drift.
//
// Phase 5A: the 3 commercial metrics join this list now that they're
// backed by a real ledger (partner_opportunities) instead of unpopulated
// prospect fields -- the same generic targeting framework (metric_targets,
// this list, getTeamTargets/upsertTarget) applies to them with no new
// framework. Adding a future commercial KPI here is the only step required
// to make it targetable too.
export const TARGETABLE_METRIC_KEYS = [
  "new_partner_prospects",
  "signed_partners",
  "partner_sourced_pipeline",
  "partner_influenced_pipeline",
  "closed_revenue",
] as const;
export type TargetableMetricKey = (typeof TARGETABLE_METRIC_KEYS)[number];

export function isTargetableMetric(metricKey: string): metricKey is TargetableMetricKey {
  return (TARGETABLE_METRIC_KEYS as readonly string[]).includes(metricKey);
}

// Metrics whose current/target/last_week values are USD-denominated money,
// as opposed to a plain count (signed_partners, renewals, everything else).
// Only these get currency-converted for display; a count must never be
// multiplied by an FX rate.
const MONEY_METRIC_KEYS = new Set(["partner_sourced_pipeline", "partner_influenced_pipeline", "closed_revenue"]);

export function isMoneyMetric(metricKey: string): boolean {
  return MONEY_METRIC_KEYS.has(metricKey);
}

// Stage 6.3: periods are no longer hardcoded to one year. A periodKey
// everywhere in this codebase (function params, API query/body params,
// cache/target lookups) is the composite string "<year>-<quarterKey>",
// e.g. "2026-q3" or "2027-ytd" -- never a bare "q3" -- so Q1 2026 and
// Q1 2027 are always distinct identities, never silently collapsed.
//
// Persisted tables that need to look a row up or enforce uniqueness by
// period (metric_targets, manual_metric_values, ai_channel_briefs) store
// year and quarterKey as two separate columns (the "year + period_key"
// model) -- splitPeriodKey/joinPeriodKey are the only bridge between that
// storage shape and the composite string used everywhere else, so callers
// never have to think about the split except at the DB boundary.
export const QUARTER_KEYS = ["q1", "q2", "q3", "q4", "ytd"] as const;
export type QuarterKey = (typeof QUARTER_KEYS)[number];

const PERIOD_KEY_PATTERN = /^(\d{4})-(q1|q2|q3|q4|ytd)$/;

export function getCurrentYear(): number {
  return new Date().getFullYear();
}

// The quarter containing today's date -- replaces the old hardcoded "q3"
// default, so the app's default view is never stale once the calendar
// moves on.
export function getCurrentQuarterKey(): QuarterKey {
  const month = new Date().getMonth(); // 0-11
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

// Pure parser -- returns null on anything malformed rather than throwing,
// so callers (mainly resolvePeriodKey below) can fall back to a sane
// default instead of erroring on a bad/missing query param.
export function splitPeriodKey(periodKey: string): SplitPeriodKey | null {
  const match = PERIOD_KEY_PATTERN.exec(periodKey);
  if (!match) return null;
  return { year: Number(match[1]), quarterKey: match[2] as QuarterKey };
}

// Validates/defaults a caller-supplied period param to a well-formed
// composite key. Never trusts an arbitrary string past the regex. Falls
// back to the current year + current quarter (both computed from today,
// never a hardcoded literal).
export function resolvePeriodKey(period: string | undefined | null): string {
  if (period && splitPeriodKey(period)) return period;
  return joinPeriodKey(getCurrentYear(), getCurrentQuarterKey());
}

export interface PeriodRange {
  start: string;
  end: string;
  label: string;
}

// Replaces the old static PERIODS[periodKey] lookup -- date ranges are
// always computed arithmetically from year + quarterKey, never read from a
// fixed table of literal dates for one specific year.
export function resolvePeriodRange(periodKey: string): PeriodRange {
  const split = splitPeriodKey(periodKey) ?? { year: getCurrentYear(), quarterKey: getCurrentQuarterKey() };
  const { year, quarterKey } = split;

  switch (quarterKey) {
    case "q1":
      return { start: `${year}-01-01`, end: `${year}-03-31`, label: `Q1 ${year}` };
    case "q2":
      return { start: `${year}-04-01`, end: `${year}-06-30`, label: `Q2 ${year}` };
    case "q3":
      return { start: `${year}-07-01`, end: `${year}-09-30`, label: `Q3 ${year}` };
    case "q4":
      return { start: `${year}-10-01`, end: `${year}-12-31`, label: `Q4 ${year}` };
    case "ytd": {
      // Current year: genuinely "to date" (through today). A prior year's
      // "YTD" would be a confusing claim (there is no partial year left to
      // total), so it's honestly reinterpreted as the full calendar year
      // instead, with a label that says so rather than implying "to date".
      if (year === getCurrentYear()) {
        return { start: `${year}-01-01`, end: new Date().toISOString().slice(0, 10), label: "Year to date" };
      }
      return { start: `${year}-01-01`, end: `${year}-12-31`, label: `${year} (full year)` };
    }
  }
}
