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
  { key: "signed_partners", label: "Signed Partners", views: ["partner_development"], defaultSourceType: "DEMO" },
  { key: "active_onboarding", label: "Active Onboarding", views: ["partner_development"], defaultSourceType: "DEMO" },
  { key: "certified_partners", label: "Certified Partners", views: ["partner_development"], defaultSourceType: "DEMO" },
  { key: "partner_sourced_pipeline", label: "Partner-Sourced Pipeline", views: ["partner_development", "weekly_commercial"], defaultSourceType: "DEMO" },
  { key: "partner_influenced_pipeline", label: "Partner-Influenced Pipeline", views: ["partner_development"], defaultSourceType: "DEMO" },
  { key: "closed_revenue", label: "Closed Revenue", views: ["partner_development", "weekly_commercial"], defaultSourceType: "DEMO" },
  { key: "renewals", label: "Renewals", views: ["partner_development"], defaultSourceType: "DEMO" },
  { key: "opportunities_created", label: "Opportunities Created", views: ["weekly_commercial"], defaultSourceType: "DEMO" },
  { key: "renewals_due", label: "Renewals Due", views: ["weekly_commercial"], defaultSourceType: "DEMO" },
  { key: "renewals_closed", label: "Renewals Closed", views: ["weekly_commercial"], defaultSourceType: "DEMO" },
  { key: "joint_campaigns", label: "Joint Campaigns", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "events", label: "Events", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "webinars", label: "Webinars", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "marketing_qualified_leads", label: "Marketing Qualified Leads", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
  { key: "partner_referrals", label: "Partner Referrals", views: ["weekly_marketing"], defaultSourceType: "ACTIVITIES" },
];

export const METRIC_BY_KEY = new Map(METRIC_REGISTRY.map((m) => [m.key, m]));

export const PERIODS: Record<string, { start: string; end: string; label: string }> = {
  q1: { start: "2026-01-01", end: "2026-03-31", label: "Q1 2026" },
  q2: { start: "2026-04-01", end: "2026-06-30", label: "Q2 2026" },
  q3: { start: "2026-07-01", end: "2026-09-30", label: "Q3 2026" },
  q4: { start: "2026-10-01", end: "2026-12-31", label: "Q4 2026" },
  ytd: { start: "2026-01-01", end: "2026-12-31", label: "Year to date" },
};

export function resolvePeriodKey(period: string | undefined | null): string {
  return period && PERIODS[period] ? period : "q3";
}
