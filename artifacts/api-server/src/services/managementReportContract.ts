// Phase 8: the management-reporting contract. Lives in artifacts/api-server
// (unlike lib/db/src/reporting/weeklyPamReportContract.ts) because it embeds
// TeamWeeklyReportEnvelope, which is defined in weeklyReportingService.ts --
// lib/db must never import from artifacts/api-server (see
// weeklyPamReportContract.ts's own header comment), so a type referencing it
// cannot live in lib/db either.
//
// report_context/weekly/quarter_to_date/comparisons/management_insights/
// data_quality are deliberately kept as separate top-level sections, never
// flattened into one undifferentiated KPI list: `weekly` reflects the
// SELECTED week (week_start), `quarter_to_date` is ALWAYS the current
// quarter as of generation regardless of week_start -- see
// ManagementReportContext.quarter_to_date_note, which must always make this
// explicit.
import type { buildHeadOfChannelsData, buildKpiDetailWithFx } from "./kpiService";
import type { SupportedCurrency, FxInfo } from "./fx";
import type { TeamWeeklyReportEnvelope } from "./weeklyReportingService";
import type { RecruitmentStage } from "./partnerRecruitmentService";
import type { TeamTargetRow } from "./targetService";

export interface ManagementReportContext {
  generated_at: string;
  week_start: string;
  week_end_exclusive: string;
  // The immediately preceding canonical Monday -- the week
  // comparisons.week_over_week compares week_start against.
  previous_week_start: string;
  quarter_to_date_period_key: string;
  quarter_to_date_period_label: string;
  quarter_to_date_note: string;
  territory_id: string | null;
  territory_name: string;
  currency: SupportedCurrency;
  fx: FxInfo;
}

// Verbatim getTeamWeeklyReport(week_start) -- Phase 7 semantics untouched.
// Sole source for PAM submission state, frozen/live snapshot handling,
// wins/progress/risks/blockers/priorities/help commentary, and weekly
// attention indicators. Never recomputed or reshaped here.
export interface ManagementWeeklySection {
  team_weekly_report: TeamWeeklyReportEnvelope;
}

export interface ManagementPeriodMoneySnapshot {
  won_revenue_usd: { sourced: number; influenced: number; total: number };
  opportunities_created_count: number;
}

// Open pipeline has no reliable point-in-time reconstruction --
// partner_opportunities carries only a live `status` column, no
// status-history table (verified before implementation, per Phase 8
// correction #3). Never fabricated as a week-over-week delta; surfaced as a
// current-state-only figure instead, with `available: false` explaining why.
export interface ManagementOpenPipelineAvailability {
  available: false;
  note: string;
  current_open_pipeline_usd: { sourced: number; influenced: number; total: number };
}

// "available": week_start is a completed calendar week, so both it and the
// previous week are full weeks and delta is a real comparison (a genuine 0
// included). "week_in_progress": week_start is the current week --
// current_week is a factual week-to-date figure, but comparing it with a
// full previous week would be misleading, so delta is null. A future
// week_start is rejected as invalid input, never reported.
export type ManagementWeekComparisonStatus = "available" | "week_in_progress";

export interface ManagementComparisons {
  week_over_week: {
    current_week: ManagementPeriodMoneySnapshot;
    previous_week: ManagementPeriodMoneySnapshot;
    comparison_available: boolean;
    comparison_status: ManagementWeekComparisonStatus;
    delta: ManagementPeriodMoneySnapshot | null; // current_week - previous_week (may be negative); null unless comparison_available
    open_pipeline: ManagementOpenPipelineAvailability;
  };
}

// Live snapshot of partner_recruitments.stage distribution, timestamped "as
// of now" -- NOT period-bound. Never presented as something that happened
// during quarter_to_date.
export interface ManagementRecruitmentCurrentState {
  as_of: string;
  by_stage: Record<RecruitmentStage, number>;
}

// Genuine stage-movement EVENTS sourced from partner_recruitment_history
// within the quarter-to-date window -- never the current stage distribution
// re-labeled as period activity. signed_count reuses the canonical
// signed_partners metric (kpiService.computeMetric) rather than being
// recomputed independently from history; null means that metric's source
// is unavailable (never a fabricated 0).
export interface ManagementRecruitmentPeriodTransitions {
  period_start: string;
  period_end_exclusive: string;
  new_recruitments_count: number;
  stage_transitions_count: number;
  signed_count: number | null;
}

export interface ManagementRecruitmentSection {
  current_state: ManagementRecruitmentCurrentState;
  period_transitions: ManagementRecruitmentPeriodTransitions;
}

// Team+quarter-to-date-scoped extension of the existing
// campaignService.computeCommercialImpact +
// weeklyReportingService.unionLinkedOpportunityIds dedup -- no new
// attribution/dedup rule introduced.
export interface ManagementMarketingSection {
  activity_count: number;
  unique_linked_opportunity_count: number;
  open_pipeline_usd: number;
  won_revenue_usd: number;
}

// buildHeadOfChannelsData's own inferred return shape, reused directly --
// never a hand-rolled parallel type that could drift from what Overview
// itself renders.
export type ManagementCommercialQtd = Awaited<ReturnType<typeof buildHeadOfChannelsData>>;

// buildKpiDetailWithFx's own inferred return shape for "closed_revenue" --
// carries pam_contribution, reconciles, and reconciliation_note verbatim.
// The Global total (quarter_to_date.commercial) and the sum of displayed PAM
// rows here are NEVER forced to match: when they legitimately differ (e.g.
// an unowned territory holds revenue no PAM can be credited with),
// `reconciles` is false and `reconciliation_note` explains it -- never a
// fabricated equality, never a record silently reassigned or dropped to
// force one.
export type ManagementPamComparison = Awaited<ReturnType<typeof buildKpiDetailWithFx>>;

export interface ManagementQuarterToDateSection {
  commercial: ManagementCommercialQtd;
  targets: TeamTargetRow[];
  recruitment: ManagementRecruitmentSection;
  marketing: ManagementMarketingSection;
  pam_comparison: ManagementPamComparison;
}

export type ManagementInsightCategory = "target" | "recruitment" | "marketing" | "submission" | "help_request" | "commercial" | "risk";
export type ManagementInsightSeverity = "info" | "attention" | "risk";

// Deterministic, rule-based -- no LLM. Wording is factual and metric-backed
// only (e.g. "Anna is at 68% of quarterly target."); never a subjective
// grade or invented interpretation.
export interface ManagementInsight {
  id: string;
  category: ManagementInsightCategory;
  severity: ManagementInsightSeverity;
  text: string;
  pam_user_id: string | null;
  related_metric_key: string | null;
}

export interface ManagementWeeklyReportCompleteness {
  submitted_count: number;
  draft_count: number;
  // Current PAMs with no persisted weekly_pam_reports row at all for the
  // selected week (neither draft nor submitted) -- distinct from
  // report_state_summary.draft_count, which only counts PAMs who have
  // touched the week at all.
  outstanding_count: number;
  outstanding_pam_names: string[];
}

export interface ManagementDataQuality {
  has_demo_data: boolean;
  fx_description_line: string;
  weekly_report_completeness: ManagementWeeklyReportCompleteness;
  // Explicit notes for genuinely absent historical data (e.g. no submitted
  // weekly reports before a given date) -- never a silently fabricated zero.
  historical_data_caveats: string[];
}

export interface ManagementReportSummary {
  report_context: ManagementReportContext;
  weekly: ManagementWeeklySection;
  quarter_to_date: ManagementQuarterToDateSection;
  comparisons: ManagementComparisons;
  management_insights: ManagementInsight[];
  data_quality: ManagementDataQuality;
}
