// Phase 7: the structured weekly-reporting contract -- deliberately NOT a
// database concern. This module is owned by the reporting/API contract (see
// lib/api-spec/openapi.yaml's WeeklyPamReport schema, which mirrors this
// shape for the HTTP layer), not by schema design. It lives inside the
// @workspace/db package purely so weekly_pam_reports.ts's jsonb column can
// reference WeeklyMetricsSnapshot for compile-time typing -- lib/db must
// never import from artifacts/api-server (wrong direction in the workspace
// dependency graph), so this is the one place both the schema file and
// services/weeklyReportingService.ts can share a single declaration instead
// of maintaining two independently-drifting copies.
//
// Frozen at submit time only (services/weeklyReportingService.ts) -- a
// draft/not-yet-submitted report is always computed live from canonical
// services and never read from here. Deliberately plain numbers/counts/
// lists, no chart/PPT-specific shaping, so Phase 8 can consume it directly.
import { OPPORTUNITY_STATUSES, OPPORTUNITY_ATTRIBUTION_TYPES } from "../schema/partner_opportunities";

// Bump this whenever a future, incompatible change to the snapshot shape
// ships, and branch readers on it -- so an already-frozen historical
// snapshot (written under an older shape) is never misread as the current
// one. v1 is the only version that exists today.
export const WEEKLY_METRICS_SNAPSHOT_VERSION = 1 as const;

// Reused directly from the canonical opportunity schema (both live in
// @workspace/db, so this import direction is fine -- unlike the lib/db ->
// artifacts/api-server direction, which stays forbidden) rather than a
// separately hand-rolled vocabulary.
export type WeeklyOpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]; // "open" | "won" | "lost"
export type WeeklyOpportunityAttribution = (typeof OPPORTUNITY_ATTRIBUTION_TYPES)[number]; // "partner_sourced" | "partner_influenced"

export interface WeeklySourcedInfluencedAmount {
  sourced: number;
  influenced: number;
  total: number;
}

// status/progress_percent here must structurally match
// targetService.computeTargetProgress's TargetProgress return shape exactly
// -- lib/db cannot import that type directly (same wrong-direction
// constraint as above), so this is kept as a plain literal union rather than
// an import. services/weeklyReportingService.ts is responsible for only ever
// assigning a value produced by computeTargetProgress() itself (by spreading
// its return), never a hand-rolled string -- if the two ever diverge
// structurally, that assignment fails to typecheck.
//
// period_actual_usd is deliberately generic (not "quarter_to_date") --
// period_key already carries whatever period this target is measured
// against (a quarter today, but Phase 8 or a future annual-target view may
// reuse this same shape against a different period identity).
//
// Targets are genuinely per-territory in the existing target model
// (metric_targets is keyed by metric/period/pam/TERRITORY) -- a PAM who
// canonically owns more than one territory (territories.owner_user_id has
// no DB uniqueness constraint) gets one entry per owned territory here,
// never a fabricated summed target. A single-territory PAM's array has
// exactly one entry.
export interface WeeklyTargetProgress {
  territory_id: string;
  territory_name: string;
  metric_key: string;
  period_key: string;
  target_value: number | null;
  period_actual_usd: number | null;
  progress_percent: number | null;
  // "unavailable": a valid target exists but the actual value is
  // unavailable -- never interpreted as zero. Additive: snapshots frozen
  // before this value existed remain valid as-is.
  status: "ahead" | "behind" | "no_target" | "unavailable";
}

// Per-opportunity backing data behind the aggregate totals in
// WeeklyCommercialSnapshot below -- lets team-level aggregation
// (weeklyReportingService.getTeamWeeklyReport) dedupe by opportunity_id
// across PAM reports (e.g. after a Head/Admin reassignment moves an
// opportunity from one PAM to another mid-week) using only already-computed
// per-PAM data, never a live re-query for an already-frozen/submitted PAM.
// Not shown directly to a PAM -- a Phase 7/8 aggregation input.
export interface WeeklyPipelineContributingOpportunity {
  opportunity_id: string;
  attribution_type: WeeklyOpportunityAttribution;
  usd_value: number;
}

export interface WeeklyWonRevenueContributingOpportunity {
  opportunity_id: string;
  attribution_type: WeeklyOpportunityAttribution;
  usd_value: number;
  // Always non-null: only an opportunity with a real closed_at is eligible
  // to be a won-revenue entry in the first place.
  closed_at: string;
}

// opportunity_date is an immutable business fact (Phase 5A: "never
// falsified"), so unlike pipeline/won-revenue entries, two sightings of the
// same opportunity_id can never legitimately disagree here -- no conflict
// handling is needed for this list at team-aggregation time.
export interface WeeklyCreatedContributingOpportunity {
  opportunity_id: string;
  opportunity_date: string;
}

export interface WeeklyCommercialSnapshot {
  open_pipeline_usd: WeeklySourcedInfluencedAmount;
  won_revenue_usd: WeeklySourcedInfluencedAmount;
  opportunity_count_open: number;
  opportunities_created_count: number;
  deals_won_count: number;
  targets: WeeklyTargetProgress[];
  contributing_open_pipeline: WeeklyPipelineContributingOpportunity[];
  contributing_won_revenue: WeeklyWonRevenueContributingOpportunity[];
  contributing_opportunities_created: WeeklyCreatedContributingOpportunity[];
}

export interface WeeklyStalledRecruitmentItem {
  recruitment_id: string;
  company_name: string;
  stage: string;
  days_in_stage: number;
}

export interface WeeklyAttentionRelationshipItem {
  relationship_id: string;
  company_name: string;
  last_interaction_at: string | null;
}

// signed_this_week_count: "signed" is the real canonical terminal recruitment
// stage (partner_recruitments.stage = "signed", set via signed_at -- the
// same field/semantics kpiService.computeSignedPartners already uses for the
// Signed Partners KPI). Not a reporting-only milestone invented here.
export interface WeeklyRecruitmentSnapshot {
  new_candidates_count: number;
  stage_transitions_count: number;
  signed_this_week_count: number;
  stalled_items: WeeklyStalledRecruitmentItem[];
  needing_attention_relationships: WeeklyAttentionRelationshipItem[];
}

export interface WeeklyMarketingActivityItem {
  campaign_id: string;
  name: string;
  type: string;
  partner_company_name: string | null;
  status: string;
  linked_opportunity_count: number;
}

// Per-opportunity backing data behind the marketing commercial-impact
// totals below -- same rationale as the commercial-section entries above:
// lets team-level aggregation dedupe across PAMs without a live re-query for
// a frozen/submitted PAM. status carries the full canonical vocabulary
// (open/won/lost) -- unique_linked_opportunity_count counts every entry
// regardless of status, but only "open" contributes to open_pipeline_usd and
// only "won" contributes to won_revenue_usd; "lost" (or any other status)
// counts toward uniqueness only, contributing no monetary value.
export interface WeeklyMarketingContributingOpportunity {
  opportunity_id: string;
  status: WeeklyOpportunityStatus;
  usd_value: number;
}

export interface WeeklyMarketingSnapshot {
  activities: WeeklyMarketingActivityItem[];
  activity_count: number;
  // Deduplicated across every activity linked in the week -- an opportunity
  // linked from more than one activity is counted/summed exactly once.
  commercial_impact: {
    unique_linked_opportunity_count: number;
    open_pipeline_usd: number;
    won_revenue_usd: number;
    contributing_opportunities: WeeklyMarketingContributingOpportunity[];
  };
}

export interface WeeklyAttentionItem {
  kind: "stalled_recruitment" | "relationship_needs_attention" | "target_gap";
  label: string;
  detail: string;
  ref_id: string | null;
}

// A PAM who canonically owns more than one territory (see
// authz.getOwnTerritories) gets arrays of length > 1 here; a single-territory
// PAM's arrays have exactly one entry -- never a single territory_id/
// territory_name pair that would silently pick one and drop the rest.
export interface WeeklyMetricsSnapshot {
  snapshot_version: typeof WEEKLY_METRICS_SNAPSHOT_VERSION;
  week_start: string;
  week_end: string;
  territory_ids: string[];
  territory_names: string[];
  pam_user_id: string;
  generated_at: string;
  commercial: WeeklyCommercialSnapshot;
  recruitment: WeeklyRecruitmentSnapshot;
  marketing: WeeklyMarketingSnapshot;
  attention: WeeklyAttentionItem[];
}
