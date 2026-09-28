// Phase 8: the management-reporting composition layer. Deliberately NOT a
// second KPI engine -- every figure here is produced by calling an existing
// canonical service (kpiService, targetService, weeklyReportingService,
// campaignService, partnerRecruitmentService); this module only assembles,
// diffs, and annotates their outputs. See managementReportContract.ts for
// the full payload shape and the reasoning behind keeping
// report_context/weekly/quarter_to_date/comparisons/management_insights/
// data_quality as separate sections.
import { db } from "@workspace/db";
import { campaignsTable, territoriesTable, weeklyPamReportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  computeClosedRevenueForRange,
  computeOpenPipelineForScope,
  computeOpportunitiesCreatedForRange,
  computeMetric,
  buildHeadOfChannelsData,
  buildKpiDetailWithFx,
  resolvePeriodKey,
  mondayOf,
  dayAfter,
  type OpportunityScope,
  type ResolvedTerritory,
} from "./kpiService";
import { resolvePeriodRange } from "./kpiRegistry";
import { resolveFx, parseCurrencyParam, type SupportedCurrency } from "./fx";
import { getTeamTargets } from "./targetService";
import { computeCommercialImpact } from "./campaignService";
import { computeRecruitmentCurrentState, computeRecruitmentPeriodTransitions } from "./partnerRecruitmentService";
import {
  getTeamWeeklyReport,
  isCanonicalMonday,
  weekEndExclusive,
  weekStartBefore,
  unionLinkedOpportunityIds,
  fetchMarketingContributingOpportunities,
  summarizeMarketingImpact,
  WeeklyReportValidationError,
} from "./weeklyReportingService";
import type { ActingUser } from "./authz";
import { fxDescriptionLine } from "../lib/pptxLayout";
import type {
  ManagementReportSummary,
  ManagementReportContext,
  ManagementPeriodMoneySnapshot,
  ManagementInsight,
  ManagementDataQuality,
  ManagementWeekComparisonStatus,
} from "./managementReportContract";

function assertCanonicalMonday(weekStartDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartDate) || !isCanonicalMonday(weekStartDate)) {
    throw new WeeklyReportValidationError(`week_start must be a canonical Monday (YYYY-MM-DD); "${weekStartDate}" is not.`);
  }
}

// Whether week_start's week-over-week comparison is a real one. Expects a
// canonical Monday (assertCanonicalMonday first). A week that has not
// started yet is invalid input -- rejected, never reported as a week of
// zeros. The current week is still in progress: its week-to-date figures
// are factual, but not comparable with a full previous week.
export function classifyManagementWeek(weekStart: string, now: Date = new Date()): ManagementWeekComparisonStatus {
  const currentWeekStart = mondayOf(now);
  if (weekStart > currentWeekStart) {
    throw new WeeklyReportValidationError(`week_start must not be in the future; "${weekStart}" has not started yet (current week starts ${currentWeekStart}).`);
  }
  return weekStart === currentWeekStart ? "week_in_progress" : "available";
}

async function computePeriodMoneySnapshot(start: string, endExclusive: string, scope: OpportunityScope): Promise<ManagementPeriodMoneySnapshot> {
  const [revenue, created] = await Promise.all([
    computeClosedRevenueForRange(start, endExclusive, scope),
    computeOpportunitiesCreatedForRange(start, endExclusive, scope),
  ]);
  return {
    won_revenue_usd: { sourced: revenue.sourced, influenced: revenue.influenced, total: revenue.total },
    opportunities_created_count: created.count,
  };
}

function deltaOf(current: ManagementPeriodMoneySnapshot, previous: ManagementPeriodMoneySnapshot): ManagementPeriodMoneySnapshot {
  return {
    won_revenue_usd: {
      sourced: current.won_revenue_usd.sourced - previous.won_revenue_usd.sourced,
      influenced: current.won_revenue_usd.influenced - previous.won_revenue_usd.influenced,
      total: current.won_revenue_usd.total - previous.won_revenue_usd.total,
    },
    opportunities_created_count: current.opportunities_created_count - previous.opportunities_created_count,
  };
}

// Team+quarter-to-date-scoped marketing contribution -- reuses the exact
// PAM-level attribution/dedup recipe weeklyReportingService.ts already
// established (unionLinkedOpportunityIds -> fetchMarketingContributingOpportunities
// -> summarizeMarketingImpact), never a second marketing calculation.
// Campaigns have no territoryId column (only a free-text `territory` label
// and ownerUserId); territory scoping therefore goes through the target
// territory's canonical owner, the same source of truth authz.ts uses
// everywhere else.
async function computeManagementMarketing(target: ResolvedTerritory, periodStart: string, periodEndExclusive: string, actingUser: ActingUser) {
  const allCampaigns = await db.select().from(campaignsTable);
  let inRange = allCampaigns.filter((c) => c.activityDate !== null && c.activityDate >= periodStart && c.activityDate < periodEndExclusive);

  if (target.territoryId !== null) {
    const [territoryRow] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, target.territoryId));
    inRange = territoryRow?.ownerUserId ? inRange.filter((c) => c.ownerUserId === territoryRow.ownerUserId) : [];
  }

  if (inRange.length === 0) {
    return { activity_count: 0, unique_linked_opportunity_count: 0, open_pipeline_usd: 0, won_revenue_usd: 0 };
  }

  const impactByCampaign = await computeCommercialImpact(inRange.map((c) => c.id), actingUser, "USD");
  const linkedIds = unionLinkedOpportunityIds(impactByCampaign);
  const entries = await fetchMarketingContributingOpportunities(linkedIds);
  const { openPipelineUsd, wonRevenueUsd } = summarizeMarketingImpact(entries);

  return {
    activity_count: inRange.length,
    unique_linked_opportunity_count: linkedIds.size,
    open_pipeline_usd: openPipelineUsd,
    won_revenue_usd: wonRevenueUsd,
  };
}

// Deterministic, rule-based -- no LLM. Every sentence is derived directly
// from an already-computed, already-canonical figure; wording states the
// fact only, never a subjective grade ("great job", "underperforming").
export function buildManagementInsights(
  ctx: Pick<ManagementReportContext, "week_start" | "quarter_to_date_period_label">,
  weeklyTeamReport: Awaited<ReturnType<typeof getTeamWeeklyReport>>,
  targets: Awaited<ReturnType<typeof getTeamTargets>>,
  recruitmentPeriodTransitions: { signed_count: number },
  marketing: { won_revenue_usd: number },
  // null when no legitimate comparison exists (week in progress) -- the
  // commercial WoW insight is then omitted, never phrased from a partial week.
  weekOverWeekDelta: ManagementPeriodMoneySnapshot | null,
  outstandingCount: number,
  pamComparisonReconciles: boolean,
  pamComparisonReconciliationNote: string | null,
): ManagementInsight[] {
  const insights: ManagementInsight[] = [];

  for (const row of targets) {
    if (row.metric_key !== "closed_revenue" || row.progress_percent === null) continue;
    insights.push({
      id: `target-${row.pam_user_id}-${row.metric_key}`,
      category: "target",
      severity: row.status === "behind" ? "attention" : "info",
      text: `${row.pam_name} is at ${row.progress_percent}% of quarterly target.`,
      pam_user_id: row.pam_user_id,
      related_metric_key: row.metric_key,
    });
  }

  for (const hr of weeklyTeamReport.help_requests) {
    insights.push({
      id: `help-${hr.pam_user_id}`,
      category: "help_request",
      severity: "attention",
      text: `${hr.pam_name} requested support: ${hr.help_needed}`,
      pam_user_id: hr.pam_user_id,
      related_metric_key: null,
    });
  }

  if (outstandingCount > 0) {
    insights.push({
      id: "submission-outstanding",
      category: "submission",
      severity: "attention",
      text: `${outstandingCount} PAM report${outstandingCount === 1 ? " remains" : "s remain"} outstanding for the week of ${ctx.week_start}.`,
      pam_user_id: null,
      related_metric_key: null,
    });
  }

  if (weeklyTeamReport.attention_summary.stalled_recruitment_count > 0) {
    const n = weeklyTeamReport.attention_summary.stalled_recruitment_count;
    insights.push({
      id: "recruitment-stalled",
      category: "recruitment",
      severity: "attention",
      text: `${n} recruitment${n === 1 ? " has" : "s have"} had no stage movement in over 14 days.`,
      pam_user_id: null,
      related_metric_key: null,
    });
  }

  if (recruitmentPeriodTransitions.signed_count > 0) {
    insights.push({
      id: "recruitment-signed",
      category: "recruitment",
      severity: "info",
      text: `${recruitmentPeriodTransitions.signed_count} partner${recruitmentPeriodTransitions.signed_count === 1 ? "" : "s"} signed during ${ctx.quarter_to_date_period_label}.`,
      pam_user_id: null,
      related_metric_key: "signed_partners",
    });
  }

  if (marketing.won_revenue_usd > 0) {
    insights.push({
      id: "marketing-contribution",
      category: "marketing",
      severity: "info",
      text: `Partner-linked marketing activity contributed $${Math.round(marketing.won_revenue_usd).toLocaleString("en-US")} in won revenue during ${ctx.quarter_to_date_period_label}.`,
      pam_user_id: null,
      related_metric_key: null,
    });
  }

  if (weekOverWeekDelta !== null && weekOverWeekDelta.won_revenue_usd.total !== 0) {
    const up = weekOverWeekDelta.won_revenue_usd.total > 0;
    insights.push({
      id: "commercial-wow",
      category: "commercial",
      severity: up ? "info" : "attention",
      text: `Won revenue this week is $${Math.round(Math.abs(weekOverWeekDelta.won_revenue_usd.total)).toLocaleString("en-US")} ${up ? "higher" : "lower"} than the previous week.`,
      pam_user_id: null,
      related_metric_key: "closed_revenue",
    });
  }

  if (!pamComparisonReconciles && pamComparisonReconciliationNote) {
    insights.push({
      id: "reconciliation-closed_revenue",
      category: "risk",
      severity: "risk",
      text: pamComparisonReconciliationNote,
      pam_user_id: null,
      related_metric_key: "closed_revenue",
    });
  }

  return insights;
}

export interface ManagementReportOptions {
  weekStart?: string | null;
  target: ResolvedTerritory;
  currency?: string | null;
}

export async function getManagementReportSummary(actingUser: ActingUser, options: ManagementReportOptions): Promise<ManagementReportSummary> {
  const weekStart = options.weekStart ?? mondayOf(new Date());
  assertCanonicalMonday(weekStart);
  const comparisonStatus = classifyManagementWeek(weekStart);
  const weekEndExcl = weekEndExclusive(weekStart);
  const previousWeekStart = weekStartBefore(weekStart);

  const target = options.target;
  const currency: SupportedCurrency = parseCurrencyParam(options.currency);
  const fx = await resolveFx(currency);

  // quarter_to_date is ALWAYS the current quarter as of generation --
  // deliberately never derived from week_start, so a historical week
  // selection can never be mistaken for a historical quarter reconstruction
  // (Phase 8 correction #2).
  const qtdPeriodKey = resolvePeriodKey(undefined);
  const qtdPeriodInfo = resolvePeriodRange(qtdPeriodKey);
  // Recruitment period_transitions and marketing contribution both cover
  // "quarter start through today" -- deliberately NOT clamped to the
  // selected week's end. quarter_to_date must never vary with week_start
  // (Phase 8 correction #2): clamping to the selected week would make a
  // historical week_start silently truncate quarter_to_date, exactly the
  // "historical QTD reconstruction" the correction forbids. qtdPeriodInfo.end
  // is INCLUSIVE (e.g. "2026-09-30") and always >= today (qtdPeriodKey is
  // always the CURRENT quarter), so "through today" is always the correct,
  // narrower bound -- dayAfter(todayDateStr) converts to the same exclusive
  // convention every other range helper here uses.
  const todayDateStr = new Date().toISOString().slice(0, 10);
  const qtdThroughToday = dayAfter(todayDateStr);

  const scope: OpportunityScope = target.territoryId ? { kind: "territory", territoryId: target.territoryId } : { kind: "global" };
  const recruitmentScope = { territoryIds: target.territoryId ? [target.territoryId] : null };

  const [
    teamWeeklyReport,
    commercial,
    targets,
    recruitmentCurrentState,
    currentWeekMoney,
    previousWeekMoney,
    currentOpenPipeline,
    signedMetric,
    recruitmentPeriodTransitionsRaw,
    marketing,
    pamComparison,
  ] = await Promise.all([
    getTeamWeeklyReport(weekStart),
    buildHeadOfChannelsData(qtdPeriodKey, target, currency),
    getTeamTargets(qtdPeriodKey, target.territoryId ? { territoryId: target.territoryId } : {}),
    computeRecruitmentCurrentState(recruitmentScope),
    computePeriodMoneySnapshot(weekStart, weekEndExcl, scope),
    computePeriodMoneySnapshot(previousWeekStart, weekStart, scope),
    computeOpenPipelineForScope(scope),
    computeMetric("signed_partners", qtdPeriodKey, target),
    computeRecruitmentPeriodTransitions(recruitmentScope, qtdPeriodInfo.start, qtdThroughToday),
    computeManagementMarketing(target, qtdPeriodInfo.start, qtdThroughToday, actingUser),
    buildKpiDetailWithFx("closed_revenue", qtdPeriodKey, target, fx),
  ]);

  const recruitmentPeriodTransitions = { ...recruitmentPeriodTransitionsRaw, signed_count: signedMetric.current ?? 0 };

  const report_context: ManagementReportContext = {
    generated_at: new Date().toISOString(),
    week_start: weekStart,
    week_end_exclusive: weekEndExcl,
    previous_week_start: previousWeekStart,
    quarter_to_date_period_key: qtdPeriodKey,
    quarter_to_date_period_label: qtdPeriodInfo.label,
    quarter_to_date_note:
      "quarter_to_date always reflects the current quarter as of generated_at, regardless of the selected week -- it is never a historical reconstruction for week_start.",
    territory_id: target.territoryId,
    territory_name: target.territoryName,
    currency,
    fx,
  };

  const comparisonAvailable = comparisonStatus === "available";
  const delta = comparisonAvailable ? deltaOf(currentWeekMoney, previousWeekMoney) : null;

  // Existing PAMs with literally no persisted weekly_pam_reports row for
  // this week (neither draft nor submitted) -- distinct from Phase 7's
  // report_state_summary.draft_count, which counts every current PAM as
  // "draft" by default (a live-synthesized view), even one who never
  // opened the page.
  const rowsForWeek = await db
    .select({ pamUserId: weeklyPamReportsTable.pamUserId })
    .from(weeklyPamReportsTable)
    .where(eq(weeklyPamReportsTable.weekStartDate, weekStart));
  const hasRow = new Set(rowsForWeek.map((r) => r.pamUserId));
  const outstanding = teamWeeklyReport.pam_reports.filter((r) => !hasRow.has(r.pam_user_id));

  const management_insights = buildManagementInsights(
    report_context,
    teamWeeklyReport,
    targets,
    recruitmentPeriodTransitions,
    marketing,
    delta,
    outstanding.length,
    pamComparison.reconciles,
    pamComparison.reconciliation_note,
  );

  const hasDemoData = [...commercial.partnerDevelopment, ...commercial.weeklyCommercial, ...commercial.weeklyMarketing].some(
    (r) => r.data_status === "DEMO",
  );

  const data_quality: ManagementDataQuality = {
    has_demo_data: hasDemoData,
    fx_description_line: fxDescriptionLine(fx),
    weekly_report_completeness: {
      submitted_count: teamWeeklyReport.report_state_summary.submitted_count,
      draft_count: teamWeeklyReport.report_state_summary.draft_count,
      outstanding_count: outstanding.length,
      outstanding_pam_names: outstanding.map((r) => r.pam_name),
    },
    historical_data_caveats:
      teamWeeklyReport.report_state_summary.submitted_count === 0
        ? [`No PAM has submitted a weekly report for the week of ${weekStart} yet; weekly figures shown are live drafts and may still change.`]
        : [],
  };

  return {
    report_context,
    weekly: { team_weekly_report: teamWeeklyReport },
    quarter_to_date: {
      commercial,
      targets,
      recruitment: { current_state: recruitmentCurrentState, period_transitions: recruitmentPeriodTransitions },
      marketing,
      pam_comparison: pamComparison,
    },
    comparisons: {
      week_over_week: {
        current_week: currentWeekMoney,
        previous_week: previousWeekMoney,
        comparison_available: comparisonAvailable,
        comparison_status: comparisonStatus,
        delta,
        open_pipeline: {
          available: false,
          note:
            "Open pipeline has no reliable point-in-time reconstruction -- partner_opportunities stores only a live status column, no status-history table -- so it is reported as a current-state figure only, never a fabricated week-over-week delta.",
          current_open_pipeline_usd: {
            sourced: currentOpenPipeline.sourced,
            influenced: currentOpenPipeline.influenced,
            total: currentOpenPipeline.total,
          },
        },
      },
    },
    management_insights,
    data_quality,
  };
}
