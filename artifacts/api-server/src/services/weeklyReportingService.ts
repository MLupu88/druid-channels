// Phase 7: the weekly PAM reporting read model. Deliberately a thin
// orchestration layer -- every commercial/recruitment/marketing figure is
// computed by calling the exact same canonical services Overview/Team
// Targets/Recruitment/Portfolio/Marketing Activities already use
// (kpiService, targetService, partnerRecruitmentService,
// partnerRelationshipService, campaignService); nothing here re-derives a
// business rule those services already own. See lib/db/src/reporting/
// weeklyPamReportContract.ts for the frozen-snapshot contract this module
// produces at submit time.
import { db } from "@workspace/db";
import {
  weeklyPamReportsTable,
  usersTable,
  territoriesTable,
  campaignsTable,
  partnerOpportunitiesTable,
  partnerRecruitmentsTable,
  partnerRecruitmentHistoryTable,
  partnerRelationshipsTable,
  prospectsTable,
  companiesTable,
  WEEKLY_METRICS_SNAPSHOT_VERSION,
  type WeeklyMetricsSnapshot,
  type WeeklyTargetProgress,
  type WeeklyRecruitmentSnapshot,
  type WeeklyMarketingSnapshot,
  type WeeklyMarketingActivityItem,
  type WeeklyMarketingContributingOpportunity,
  type WeeklyAttentionItem,
  type WeeklyStalledRecruitmentItem,
  type WeeklyAttentionRelationshipItem,
  type WeeklyPipelineContributingOpportunity,
  type WeeklyWonRevenueContributingOpportunity,
  type WeeklyCreatedContributingOpportunity,
  type WeeklyOpportunityAttribution,
  type WeeklyOpportunityStatus,
} from "@workspace/db";
import { eq, and, inArray, desc, gte, lt } from "drizzle-orm";
import {
  mondayOf,
  dayAfter,
  resolvePeriodRange,
  getTargetOverride,
  buildUsdRateMap,
  usdValueOf,
  computeClosedRevenueForRange,
  computeOpportunitiesCreatedForRange,
  computeOpenPipelineForScope,
  type OpportunityScope,
} from "./kpiService";
import { joinPeriodKey, type QuarterKey } from "./kpiRegistry";
import { computeTargetProgress } from "./targetService";
import { computeDaysInStage, isStalled } from "./partnerRecruitmentService";
import { isNeedingAttention } from "./partnerRelationshipService";
import { computeCommercialImpact, type CampaignCommercialImpact } from "./campaignService";
import { getOwnTerritories, type ActingUser } from "./authz";

export class WeeklyReportValidationError extends Error {}
export class WeeklyReportNoTerritoryError extends Error {}
export class WeeklyReportAlreadySubmittedError extends Error {}
// Thrown when the Head/Admin drill-down (GET /reporting/weekly/pam/:userId)
// is asked for a user who is not currently a PAM and has no persisted
// weekly_pam_reports row for the requested week -- see getPamWeeklyReport's
// own comment for why this must never fall through to synthesizing a live
// report from that user's current territory ownership.
export class WeeklyReportNotEligibleError extends Error {}

// The one metric today's target model can meaningfully report weekly
// progress against -- "closed_revenue" is a real entry in
// kpiRegistry.TARGETABLE_METRIC_KEYS, not invented here. Deliberately does
// NOT introduce a second target-tracking concept: the actual-value path
// below (computeClosedRevenueForRange at {kind:"territory"} scope) shares
// the exact same eligibility computeMetric("closed_revenue") itself
// dispatches to -- the same REPORTING actual Team Targets/My Targets
// already compare a quarterly target against (getTeamTargets() calls
// computeMetric, never the credit_value/credit_date-aware annual-cascade
// path, which is specific to the separate company-wide ANNUAL target type,
// not this per-territory quarterly one).
const WEEKLY_TARGET_METRIC_KEY = "closed_revenue" as const;

// ---- Week identity --------------------------------------------------------

export function isCanonicalMonday(weekStartDate: string): boolean {
  return mondayOf(new Date(weekStartDate + "T00:00:00.000Z")) === weekStartDate;
}

function assertCanonicalMonday(weekStartDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartDate) || !isCanonicalMonday(weekStartDate)) {
    throw new WeeklyReportValidationError(`week_start must be a canonical Monday (YYYY-MM-DD); "${weekStartDate}" is not.`);
  }
}

// Exclusive upper bound for [weekStart, weekEndExclusive) filtering -- the
// following Monday.
export function weekEndExclusive(weekStartDate: string): string {
  const d = new Date(weekStartDate + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

// The immediately preceding canonical Monday -- Phase 8's week-over-week
// comparison partner for a given week_start. Exported alongside
// weekEndExclusive so managementReportingService.ts shares the same week
// date-math rather than re-deriving it.
export function weekStartBefore(weekStartDate: string): string {
  const d = new Date(weekStartDate + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

// Inclusive Sunday end date, for display only -- internal filtering always
// uses weekEndExclusive above, never this.
function weekEndInclusive(weekStartDate: string): string {
  const d = new Date(weekStartDate + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

// Additive local helper -- maps a reporting week to the calendar quarter
// containing it. Pure calendar math (safe to compute locally, same
// precedent as the frontend's period.ts header comment), not a business
// rule -- kpiRegistry.ts's getCurrentQuarterKey only ever answers "today,"
// which is wrong for a historical week. Exported purely so
// tests/weeklyReportingServicePure.test.ts can exercise quarter-boundary
// weeks directly without a database.
export function periodKeyForWeek(weekStartDate: string): string {
  const d = new Date(weekStartDate + "T00:00:00.000Z");
  const month = d.getUTCMonth();
  const quarterKey: QuarterKey = month <= 2 ? "q1" : month <= 5 ? "q2" : month <= 8 ? "q3" : "q4";
  return joinPeriodKey(d.getUTCFullYear(), quarterKey);
}

// ---- Marketing commercial-impact dedup (PAM level) -------------------------

// Exported purely so tests/weeklyReportingMarketingDedup.test.ts can prove,
// without a database, that an opportunity linked from more than one activity
// contributes exactly once -- pure Map -> Set, no DB.
export function unionLinkedOpportunityIds(impactByCampaign: Map<string, CampaignCommercialImpact>): Set<string> {
  const ids = new Set<string>();
  for (const impact of impactByCampaign.values()) {
    for (const id of impact.linkedOpportunityIds) ids.add(id);
  }
  return ids;
}

// Fetches each unique linked opportunity exactly once and tags it with its
// real canonical status (open/won/lost) and USD value -- the per-opportunity
// backing data behind a PAM's marketing commercial_impact totals, and the
// only place team-level aggregation needs to dedupe from (never a live
// re-query for an already-frozen/submitted PAM's opportunities). Exported
// (alongside unionLinkedOpportunityIds and summarizeMarketingImpact below)
// so Phase 8's managementReportingService.ts can reuse this exact
// attribution/dedup recipe for a team+quarter-to-date scope instead of
// re-deriving a second marketing calculation.
export async function fetchMarketingContributingOpportunities(opportunityIds: Set<string>): Promise<WeeklyMarketingContributingOpportunity[]> {
  if (opportunityIds.size === 0) return [];
  const oppRows = await db.select().from(partnerOpportunitiesTable).where(inArray(partnerOpportunitiesTable.id, [...opportunityIds]));
  const rateByCurrency = await buildUsdRateMap(oppRows.map((o) => o.currency));
  return oppRows.map((o) => ({ opportunity_id: o.id, status: o.status, usd_value: usdValueOf(o, rateByCurrency) }));
}

export function summarizeMarketingImpact(entries: WeeklyMarketingContributingOpportunity[]): { openPipelineUsd: number; wonRevenueUsd: number } {
  let openPipelineUsd = 0;
  let wonRevenueUsd = 0;
  for (const e of entries) {
    if (e.status === "open") openPipelineUsd += e.usd_value;
    else if (e.status === "won") wonRevenueUsd += e.usd_value;
    // "lost" (or any other status) contributes to uniqueness only, per the
    // Phase 6 semantics this reuses -- no monetary contribution.
  }
  return { openPipelineUsd, wonRevenueUsd };
}

// ---- Section builders -------------------------------------------------

// Targets are genuinely per-territory in the existing model -- one entry per
// territory the PAM owns, never a fabricated summed target. The actual is
// quarter-to-date AS OF this reporting week's own end (clamped to the
// quarter's own end, in case a week straddles a quarter boundary) -- never
// "as of today," so a draft report about a past week shows what was true
// then, not a live-right-now figure.
async function buildTargetSections(
  territoryIds: string[],
  territoryNames: string[],
  weekStartDate: string,
  weekEndExcl: string,
): Promise<WeeklyTargetProgress[]> {
  const periodKey = periodKeyForWeek(weekStartDate);
  const periodInfo = resolvePeriodRange(periodKey);
  const asOfExclusive = weekEndExcl < dayAfter(periodInfo.end) ? weekEndExcl : dayAfter(periodInfo.end);

  return Promise.all(
    territoryIds.map(async (territoryId, i) => {
      const territoryName = territoryNames[i];
      const targetValue = await getTargetOverride(WEEKLY_TARGET_METRIC_KEY, periodKey, territoryId);
      const actual = await computeClosedRevenueForRange(periodInfo.start, asOfExclusive, { kind: "territory", territoryId });
      const progress = computeTargetProgress(actual.total, targetValue);
      return {
        territory_id: territoryId,
        territory_name: territoryName,
        metric_key: WEEKLY_TARGET_METRIC_KEY,
        period_key: periodKey,
        target_value: targetValue,
        period_actual_usd: actual.total,
        progress_percent: progress.progress_percent,
        status: progress.status,
      };
    }),
  );
}

// Recruitment/relationships are territory-scoped for a PAM (routes/
// recruitment.ts, routes/portfolio.ts) -- matches the existing canonical
// Recruitment/Portfolio workspaces exactly, extended to the PAM's FULL
// owned-territory set rather than a single territory. New-candidate
// prospects are the one exception: "My Prospects" is territory AND
// assigned_user_id scoped (routes/prospects.ts), so this mirrors that
// stricter rule for that one figure only.
async function buildRecruitmentSection(
  pamUserId: string,
  territoryIds: string[],
  weekStart: string,
  weekEndExcl: string,
): Promise<WeeklyRecruitmentSnapshot> {
  const rangeStart = new Date(weekStart + "T00:00:00.000Z");
  const rangeEndExcl = new Date(weekEndExcl + "T00:00:00.000Z");

  const [recruitments, pamProspects, relationships] = await Promise.all([
    db.select().from(partnerRecruitmentsTable).where(inArray(partnerRecruitmentsTable.territoryId, territoryIds)),
    db.select().from(prospectsTable).where(and(inArray(prospectsTable.territoryId, territoryIds), eq(prospectsTable.assignedUserId, pamUserId))),
    db.select().from(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.territoryId, territoryIds)),
  ]);

  const newCandidatesCount = pamProspects.filter((p) => p.createdAt >= rangeStart && p.createdAt < rangeEndExcl).length;

  const signedThisWeek = recruitments.filter((r) => r.signedAt !== null && r.signedAt >= rangeStart && r.signedAt < rangeEndExcl);

  // Every actual transition EVENT in the week, from the canonical history
  // table -- not inferred from the current row's stage_entered_at, which
  // only reflects the LATEST transition and would undercount a recruitment
  // that moved stage more than once in the same week. Genuine stage
  // MOVEMENT only: excludes the initial null -> "accepted" recruitment-
  // creation event, which is a distinct signal (new_candidates_count /
  // acceptForRecruitment), not a "transition" between two stages.
  const recruitmentIds = recruitments.map((r) => r.id);
  const historyRowsInWeek = recruitmentIds.length
    ? await db
        .select({ fromStage: partnerRecruitmentHistoryTable.fromStage, toStage: partnerRecruitmentHistoryTable.toStage })
        .from(partnerRecruitmentHistoryTable)
        .where(
          and(
            inArray(partnerRecruitmentHistoryTable.recruitmentId, recruitmentIds),
            gte(partnerRecruitmentHistoryTable.createdAt, rangeStart),
            lt(partnerRecruitmentHistoryTable.createdAt, rangeEndExcl),
          ),
        )
    : [];
  const stageTransitionsCount = historyRowsInWeek.filter((h) => h.fromStage !== null && h.fromStage !== h.toStage).length;

  const stalledRecruitments = recruitments.filter((r) => isStalled(r.stage, computeDaysInStage(r.stageEnteredAt)));
  const needingAttentionRelationships = relationships.filter((r) => isNeedingAttention(r));

  const companyIds = [...new Set([...stalledRecruitments.map((r) => r.companyId), ...needingAttentionRelationships.map((r) => r.companyId)])];
  const companies = companyIds.length ? await db.select().from(companiesTable).where(inArray(companiesTable.id, companyIds)) : [];
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? "Unknown";

  const stalled_items: WeeklyStalledRecruitmentItem[] = stalledRecruitments.map((r) => ({
    recruitment_id: r.id,
    company_name: companyName(r.companyId),
    stage: r.stage,
    days_in_stage: computeDaysInStage(r.stageEnteredAt),
  }));

  const needing_attention_relationships: WeeklyAttentionRelationshipItem[] = needingAttentionRelationships.map((r) => ({
    relationship_id: r.id,
    company_name: companyName(r.companyId),
    last_interaction_at: r.lastInteractionAt ? r.lastInteractionAt.toISOString() : null,
  }));

  return {
    new_candidates_count: newCandidatesCount,
    stage_transitions_count: stageTransitionsCount,
    signed_this_week_count: signedThisWeek.length,
    stalled_items,
    needing_attention_relationships,
  };
}

// Marketing activities are owner_user_id scoped for a PAM (routes/
// campaigns.ts) -- matches the existing canonical Marketing Activities
// workspace exactly. Commercial impact dedupes linked opportunities across
// every activity in the week before summing -- see this module's header and
// Phase 7's "do not double-count an opportunity" requirement.
async function buildMarketingSection(pamUser: ActingUser, weekStart: string, weekEndExcl: string): Promise<WeeklyMarketingSnapshot> {
  const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.ownerUserId, pamUser.id));
  const inWeek = campaigns.filter((c) => c.activityDate !== null && c.activityDate >= weekStart && c.activityDate < weekEndExcl);

  if (inWeek.length === 0) {
    return {
      activities: [],
      activity_count: 0,
      commercial_impact: { unique_linked_opportunity_count: 0, open_pipeline_usd: 0, won_revenue_usd: 0, contributing_opportunities: [] },
    };
  }

  const impactByCampaign = await computeCommercialImpact(
    inWeek.map((c) => c.id),
    pamUser,
    "USD",
  );
  const uniqueOpportunityIds = unionLinkedOpportunityIds(impactByCampaign);
  const contributing_opportunities = await fetchMarketingContributingOpportunities(uniqueOpportunityIds);
  const { openPipelineUsd, wonRevenueUsd } = summarizeMarketingImpact(contributing_opportunities);

  const companyIds = [...new Set(inWeek.map((c) => c.partnerCompanyId).filter((id): id is string => id !== null))];
  const companies = companyIds.length ? await db.select().from(companiesTable).where(inArray(companiesTable.id, companyIds)) : [];
  const companyName = (id: string | null) => (id ? companies.find((c) => c.id === id)?.name ?? null : null);

  const activities: WeeklyMarketingActivityItem[] = inWeek.map((c) => ({
    campaign_id: c.id,
    name: c.name,
    type: c.type,
    partner_company_name: companyName(c.partnerCompanyId),
    status: c.status,
    linked_opportunity_count: impactByCampaign.get(c.id)?.linkedOpportunityCount ?? 0,
  }));

  return {
    activities,
    activity_count: inWeek.length,
    commercial_impact: {
      unique_linked_opportunity_count: uniqueOpportunityIds.size,
      open_pipeline_usd: openPipelineUsd,
      won_revenue_usd: wonRevenueUsd,
      contributing_opportunities,
    },
  };
}

// Exported for DB-free unit tests only. A target_gap item is only ever
// raised for a genuinely "behind" target -- never for "unavailable" (an
// actual that isn't known cannot be claimed as behind), "no_target" or
// "ahead" -- and its detail states only values that are actually known.
export function buildAttentionItems(recruitment: WeeklyRecruitmentSnapshot, targets: WeeklyTargetProgress[]): WeeklyAttentionItem[] {
  const items: WeeklyAttentionItem[] = [];
  for (const s of recruitment.stalled_items) {
    items.push({
      kind: "stalled_recruitment",
      label: s.company_name,
      detail: `${s.stage.replace(/_/g, " ")} for ${s.days_in_stage} days`,
      ref_id: s.recruitment_id,
    });
  }
  for (const r of recruitment.needing_attention_relationships) {
    items.push({
      kind: "relationship_needs_attention",
      label: r.company_name,
      detail: r.last_interaction_at ? `No interaction since ${r.last_interaction_at.slice(0, 10)}` : "No interaction recorded yet",
      ref_id: r.relationship_id,
    });
  }
  for (const t of targets) {
    if (t.status === "behind") {
      const amounts = t.period_actual_usd !== null ? `${Math.round(t.period_actual_usd)} of ${t.target_value}` : `Target ${t.target_value}`;
      const progress = t.progress_percent !== null ? ` (${t.progress_percent}%)` : "";
      items.push({
        kind: "target_gap",
        label: `${t.territory_name}: closed revenue behind target`,
        detail: `${amounts}${progress}`,
        ref_id: t.territory_id,
      });
    }
  }
  return items;
}

async function computeLiveWeeklyMetrics(
  pamUser: ActingUser,
  territoryIds: string[],
  territoryNames: string[],
  weekStartDate: string,
): Promise<WeeklyMetricsSnapshot> {
  const weekEndExcl = weekEndExclusive(weekStartDate);
  const scope: OpportunityScope = { kind: "pam", territoryIds, assignedUserId: pamUser.id };

  const [pipeline, closedRevenue, created, targets, recruitment, marketing] = await Promise.all([
    computeOpenPipelineForScope(scope),
    computeClosedRevenueForRange(weekStartDate, weekEndExcl, scope),
    computeOpportunitiesCreatedForRange(weekStartDate, weekEndExcl, scope),
    buildTargetSections(territoryIds, territoryNames, weekStartDate, weekEndExcl),
    buildRecruitmentSection(pamUser.id, territoryIds, weekStartDate, weekEndExcl),
    buildMarketingSection(pamUser, weekStartDate, weekEndExcl),
  ]);

  const contributing_open_pipeline: WeeklyPipelineContributingOpportunity[] = pipeline.entries.map((e) => ({
    opportunity_id: e.opportunityId,
    attribution_type: e.attributionType as WeeklyOpportunityAttribution,
    usd_value: e.usdValue,
  }));
  const contributing_won_revenue: WeeklyWonRevenueContributingOpportunity[] = closedRevenue.entries.map((e) => ({
    opportunity_id: e.opportunityId,
    attribution_type: e.attributionType as WeeklyOpportunityAttribution,
    usd_value: e.usdValue,
    closed_at: e.closedAt,
  }));
  const contributing_opportunities_created: WeeklyCreatedContributingOpportunity[] = created.entries.map((e) => ({
    opportunity_id: e.opportunityId,
    opportunity_date: e.opportunityDate,
  }));

  return {
    snapshot_version: WEEKLY_METRICS_SNAPSHOT_VERSION,
    week_start: weekStartDate,
    week_end: weekEndInclusive(weekStartDate),
    territory_ids: territoryIds,
    territory_names: territoryNames,
    pam_user_id: pamUser.id,
    generated_at: new Date().toISOString(),
    commercial: {
      open_pipeline_usd: { sourced: pipeline.sourced, influenced: pipeline.influenced, total: pipeline.total },
      won_revenue_usd: { sourced: closedRevenue.sourced, influenced: closedRevenue.influenced, total: closedRevenue.total },
      opportunity_count_open: pipeline.openCount,
      opportunities_created_count: created.count,
      deals_won_count: closedRevenue.count,
      targets,
      contributing_open_pipeline,
      contributing_won_revenue,
      contributing_opportunities_created,
    },
    recruitment,
    marketing,
    attention: buildAttentionItems(recruitment, targets),
  };
}

// ---- Public envelope + entry points ---------------------------------------

export interface WeeklyReportCommentary {
  wins_progress: string | null;
  risks_blockers: string | null;
  priorities_next_week: string | null;
  help_needed: string | null;
  commentary_updated_at: string | null;
}

export interface WeeklyReportEnvelope {
  pam_user_id: string;
  territory_ids: string[];
  territory_names: string[];
  week_start: string;
  week_end: string;
  status: "draft" | "submitted";
  submitted_at: string | null;
  snapshot_generated_at: string | null;
  metrics: WeeklyMetricsSnapshot;
  commentary: WeeklyReportCommentary;
}

function commentaryOf(row: typeof weeklyPamReportsTable.$inferSelect | undefined): WeeklyReportCommentary {
  return {
    wins_progress: row?.winsProgress ?? null,
    risks_blockers: row?.risksBlockers ?? null,
    priorities_next_week: row?.prioritiesNextWeek ?? null,
    help_needed: row?.helpNeeded ?? null,
    commentary_updated_at: row?.commentaryUpdatedAt ? row.commentaryUpdatedAt.toISOString() : null,
  };
}

async function loadPamUser(pamUserId: string): Promise<ActingUser> {
  const [pamUser] = await db.select().from(usersTable).where(eq(usersTable.id, pamUserId));
  if (!pamUser) throw new WeeklyReportValidationError("PAM not found.");
  return pamUser;
}

async function loadTerritoryNames(territoryIds: string[]): Promise<string[]> {
  if (territoryIds.length === 0) return [];
  const rows = await db.select().from(territoriesTable).where(inArray(territoriesTable.id, territoryIds));
  return territoryIds.map((id) => rows.find((r) => r.id === id)?.name ?? "Unknown");
}

// draft/current: always computed live. submitted: always read back from the
// frozen metrics_snapshot, never recomputed -- see weekly_pam_reports.ts's
// header for why. Territory set is either the row's own pinned territory_ids
// (an existing row -- draft or submitted) or the PAM's current canonical
// owned-territory set (no row yet, nothing pinned to drift from).
export async function getPamWeeklyReport(pamUserId: string, weekStartDate: string): Promise<WeeklyReportEnvelope> {
  assertCanonicalMonday(weekStartDate);
  const pamUser = await loadPamUser(pamUserId);

  const [existing] = await db
    .select()
    .from(weeklyPamReportsTable)
    .where(and(eq(weeklyPamReportsTable.pamUserId, pamUserId), eq(weeklyPamReportsTable.weekStartDate, weekStartDate)));

  if (existing && existing.status === "submitted") {
    const snapshot = existing.metricsSnapshot!;
    return {
      pam_user_id: pamUserId,
      territory_ids: existing.territoryIds,
      territory_names: snapshot.territory_names,
      week_start: weekStartDate,
      week_end: snapshot.week_end,
      status: "submitted",
      submitted_at: existing.submittedAt!.toISOString(),
      snapshot_generated_at: existing.snapshotGeneratedAt!.toISOString(),
      metrics: snapshot,
      commentary: commentaryOf(existing),
    };
  }

  let territoryIds: string[];
  let territoryNames: string[];
  if (existing) {
    // A persisted (draft) row already exists -- read it against its own
    // pinned territories regardless of the user's CURRENT role, the same
    // frozen-historical-report principle applied to submitted rows above: a
    // report that was legitimately started must not disappear or change
    // shape just because the owner's role has since changed.
    territoryIds = existing.territoryIds;
    territoryNames = await loadTerritoryNames(territoryIds);
  } else {
    // No row at all yet -- only a CURRENT PAM may have one synthesized
    // live. Never derive a brand-new report from territory ownership for a
    // non-PAM user (e.g. a Head/Admin who happens to canonically own a
    // territory) -- that would let the Head/Admin drill-down
    // (GET /reporting/weekly/pam/:userId, which can be given an arbitrary
    // userId) fabricate a "PAM report" for someone who was never eligible
    // to have one. getTeamWeeklyReport never hits this branch for a
    // persisted-former-PAM: its population already includes them via
    // reportedPamIds, so `existing` above is always truthy for that case.
    if (pamUser.role !== "pam") {
      throw new WeeklyReportNotEligibleError("This user is not currently a PAM and has no existing weekly report for this week.");
    }
    const own = await getOwnTerritories(pamUserId);
    if (!own) throw new WeeklyReportNoTerritoryError("This PAM has no canonical territory assigned.");
    territoryIds = own.territoryIds;
    territoryNames = own.territoryNames;
  }

  const metrics = await computeLiveWeeklyMetrics(pamUser, territoryIds, territoryNames, weekStartDate);

  return {
    pam_user_id: pamUserId,
    territory_ids: territoryIds,
    territory_names: territoryNames,
    week_start: weekStartDate,
    week_end: metrics.week_end,
    status: "draft",
    submitted_at: null,
    snapshot_generated_at: null,
    metrics,
    commentary: commentaryOf(existing),
  };
}

export interface CommentaryInput {
  winsProgress?: string | null;
  risksBlockers?: string | null;
  prioritiesNextWeek?: string | null;
  helpNeeded?: string | null;
}

const WEEKLY_REPORT_UNIQUE_CONSTRAINT = "weekly_pam_reports_pam_week_unique";
// Same structural-check pattern as routes/opportunities.ts's
// isSourceExternalUniqueViolation -- checked via the underlying pg
// DatabaseError's `.constraint` field, never message-text matching.
function isWeeklyReportUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === "23505" && cause?.constraint === WEEKLY_REPORT_UNIQUE_CONSTRAINT;
}

// A submitted report is read-only in Phase 7 v1 -- commentary can never be
// edited again after submit, same as the frozen metrics snapshot. No
// reopen/version workflow exists. Writes are concurrency-safe: the UPDATE
// is conditioned on status='draft' (never blindly on id alone), and a
// first-writer race on (pam_user_id, week_start_date) is handled
// deterministically rather than allowing a silent overwrite.
export async function upsertPamCommentary(
  pamUserId: string,
  weekStartDate: string,
  input: CommentaryInput,
  attempt = 0,
): Promise<WeeklyReportEnvelope> {
  assertCanonicalMonday(weekStartDate);
  await loadPamUser(pamUserId);

  const [existing] = await db
    .select()
    .from(weeklyPamReportsTable)
    .where(and(eq(weeklyPamReportsTable.pamUserId, pamUserId), eq(weeklyPamReportsTable.weekStartDate, weekStartDate)));

  if (existing) {
    if (existing.status === "submitted") {
      throw new WeeklyReportAlreadySubmittedError("This weekly report has already been submitted and is read-only.");
    }
    const now = new Date();
    const [updated] = await db
      .update(weeklyPamReportsTable)
      .set({
        winsProgress: input.winsProgress !== undefined ? input.winsProgress : existing.winsProgress,
        risksBlockers: input.risksBlockers !== undefined ? input.risksBlockers : existing.risksBlockers,
        prioritiesNextWeek: input.prioritiesNextWeek !== undefined ? input.prioritiesNextWeek : existing.prioritiesNextWeek,
        helpNeeded: input.helpNeeded !== undefined ? input.helpNeeded : existing.helpNeeded,
        commentaryUpdatedAt: now,
        updatedAt: now,
      })
      .where(and(eq(weeklyPamReportsTable.id, existing.id), eq(weeklyPamReportsTable.status, "draft")))
      .returning();
    if (!updated) {
      throw new WeeklyReportAlreadySubmittedError("This weekly report was submitted by another request while your update was in progress.");
    }
    return getPamWeeklyReport(pamUserId, weekStartDate);
  }

  const own = await getOwnTerritories(pamUserId);
  if (!own) throw new WeeklyReportNoTerritoryError("This PAM has no canonical territory assigned.");
  const now = new Date();
  try {
    await db.insert(weeklyPamReportsTable).values({
      pamUserId,
      territoryIds: own.territoryIds,
      weekStartDate,
      status: "draft",
      winsProgress: input.winsProgress ?? null,
      risksBlockers: input.risksBlockers ?? null,
      prioritiesNextWeek: input.prioritiesNextWeek ?? null,
      helpNeeded: input.helpNeeded ?? null,
      commentaryUpdatedAt: now,
    });
  } catch (err) {
    if (isWeeklyReportUniqueViolation(err)) {
      // Another request created the row first (e.g. a double-click) --
      // deterministically re-enter through the normal read path (bounded to
      // 3 attempts) so the commentary is applied via the guarded UPDATE
      // above instead of being silently lost.
      if (attempt >= 2) throw err;
      return upsertPamCommentary(pamUserId, weekStartDate, input, attempt + 1);
    }
    throw err;
  }
  return getPamWeeklyReport(pamUserId, weekStartDate);
}

// Computes the live figures once (outside any lock) and then atomically
// freezes them via a single, conditionally-guarded write --
// metrics_snapshot/snapshot_generated_at/submitted_at/status all move
// together in one statement (the DB CHECK constraint on weekly_pam_reports
// also enforces this invariant). Never recomputed again after this point.
export async function submitPamWeeklyReport(pamUserId: string, weekStartDate: string, attempt = 0): Promise<WeeklyReportEnvelope> {
  assertCanonicalMonday(weekStartDate);
  const pamUser = await loadPamUser(pamUserId);

  const [existing] = await db
    .select()
    .from(weeklyPamReportsTable)
    .where(and(eq(weeklyPamReportsTable.pamUserId, pamUserId), eq(weeklyPamReportsTable.weekStartDate, weekStartDate)));

  if (existing && existing.status === "submitted") {
    throw new WeeklyReportAlreadySubmittedError("This weekly report has already been submitted and is read-only.");
  }

  let territoryIds: string[];
  let territoryNames: string[];
  if (existing) {
    territoryIds = existing.territoryIds;
    territoryNames = await loadTerritoryNames(territoryIds);
  } else {
    const own = await getOwnTerritories(pamUserId);
    if (!own) throw new WeeklyReportNoTerritoryError("This PAM has no canonical territory assigned.");
    territoryIds = own.territoryIds;
    territoryNames = own.territoryNames;
  }

  const metrics = await computeLiveWeeklyMetrics(pamUser, territoryIds, territoryNames, weekStartDate);
  const now = new Date();

  if (existing) {
    // Conditional UPDATE: transitions draft -> submitted ONLY while still
    // draft. Zero rows matched means someone else already submitted it
    // between our read above and this write -- never overwrite their
    // snapshot.
    const [updated] = await db
      .update(weeklyPamReportsTable)
      .set({ status: "submitted", metricsSnapshot: metrics, snapshotGeneratedAt: now, submittedAt: now, updatedAt: now })
      .where(and(eq(weeklyPamReportsTable.id, existing.id), eq(weeklyPamReportsTable.status, "draft")))
      .returning();
    if (!updated) throw new WeeklyReportAlreadySubmittedError("This weekly report was just submitted by another request.");
  } else {
    try {
      await db.insert(weeklyPamReportsTable).values({
        pamUserId,
        territoryIds,
        weekStartDate,
        status: "submitted",
        metricsSnapshot: metrics,
        snapshotGeneratedAt: now,
        submittedAt: now,
      });
    } catch (err) {
      if (isWeeklyReportUniqueViolation(err)) {
        // Another request created the row first -- it may have won as
        // "submitted" (real conflict) or as a draft commentary save (not a
        // conflict at all). Re-enter through the normal read path (bounded
        // to 3 attempts) to determine which, rather than guessing here.
        if (attempt >= 2) throw new WeeklyReportAlreadySubmittedError("This weekly report was just created by another request.");
        return submitPamWeeklyReport(pamUserId, weekStartDate, attempt + 1);
      }
      throw err;
    }
  }

  // Re-read via getPamWeeklyReport rather than constructing the envelope
  // locally: a commentary update may have won immediately before this
  // guarded write committed, so the DB may now hold newer commentary than
  // `existing` reflected. This ensures the response is exactly the
  // committed frozen snapshot plus the latest persisted commentary.
  return getPamWeeklyReport(pamUserId, weekStartDate);
}

export interface WeeklyReportHistoryItem {
  week_start: string;
  status: "draft" | "submitted";
  submitted_at: string | null;
  commentary_updated_at: string | null;
}

// Only surfaces weeks with an actual persisted row (a commentary save or a
// submission) -- a week nobody has touched yet simply isn't "history",
// though it's still viewable live via getPamWeeklyReport for any Monday.
export async function listPamWeeklyReportHistory(pamUserId: string, limit = 12): Promise<WeeklyReportHistoryItem[]> {
  const rows = await db
    .select()
    .from(weeklyPamReportsTable)
    .where(eq(weeklyPamReportsTable.pamUserId, pamUserId))
    .orderBy(desc(weeklyPamReportsTable.weekStartDate))
    .limit(limit);

  return rows.map((r) => ({
    week_start: r.weekStartDate,
    status: r.status,
    submitted_at: r.submittedAt ? r.submittedAt.toISOString() : null,
    commentary_updated_at: r.commentaryUpdatedAt ? r.commentaryUpdatedAt.toISOString() : null,
  }));
}

// ---- Team (Head/Admin) view -------------------------------------------

export interface WeeklyMarketingConflict {
  opportunity_id: string;
  entries: Array<{ pam_user_id: string; status: WeeklyOpportunityStatus; usd_value: number; as_of: string }>;
}

export interface WeeklyCommercialConflict {
  kind: "open_pipeline" | "won_revenue";
  opportunity_id: string;
  entries: Array<{ pam_user_id: string; attribution_type: WeeklyOpportunityAttribution; usd_value: number; as_of: string }>;
}

export interface TeamWeeklyReportEnvelope {
  week_start: string;
  week_end: string;
  generated_at: string;
  report_state_summary: { submitted_count: number; draft_count: number };
  pams_with_multiple_territories: string[];
  team_commercial: {
    open_pipeline_usd: { sourced: number; influenced: number; total: number };
    won_revenue_usd: { sourced: number; influenced: number; total: number };
    opportunity_count_open: number;
    opportunities_created_count: number;
    deals_won_count: number;
    conflicts: WeeklyCommercialConflict[];
  };
  team_marketing: {
    activity_count: number;
    commercial_impact: { unique_linked_opportunity_count: number; open_pipeline_usd: number; won_revenue_usd: number };
    conflicts: WeeklyMarketingConflict[];
  };
  pam_reports: Array<WeeklyReportEnvelope & { pam_name: string; current_role: string }>;
  help_requests: Array<{ pam_user_id: string; pam_name: string; help_needed: string }>;
  attention_summary: { stalled_recruitment_count: number; relationships_needing_attention_count: number; pams_behind_target: number };
}

export interface PamReportForAggregation {
  pam_user_id: string;
  status: "draft" | "submitted";
  snapshot_generated_at: string | null;
  metrics: WeeklyMetricsSnapshot;
}

// "as of" for a PAM's own report: the frozen snapshot's generation time for
// a submitted report, or the live metrics' own generated_at for a draft --
// never `now()` independently, so the recency tie-break below compares each
// sighting's OWN true computation time.
function asOfOf(r: PamReportForAggregation): string {
  return r.status === "submitted" ? r.snapshot_generated_at! : r.metrics.generated_at;
}

// Pure -- testable without a DB. Unions contributing_open_pipeline/
// contributing_won_revenue by opportunity_id across every PAM's own
// (already frozen-or-live) commercial section, so an opportunity can never
// be summed twice even after a Head/Admin reassignment moves it between
// PAMs mid-week -- never re-queries live data for a submitted PAM. A
// genuine conflict (the same opportunity sighted with different
// attribution/value) is surfaced via `conflicts`, never silently resolved
// by a first-wins Map insert; the money totals use a deterministic
// most-recent-sighting tie-break.
export function aggregateTeamCommercial(pamReports: PamReportForAggregation[]) {
  function dedupeMoneyEntries(
    pick: (m: WeeklyMetricsSnapshot) => Array<{ opportunity_id: string; attribution_type: WeeklyOpportunityAttribution; usd_value: number }>,
    kind: "open_pipeline" | "won_revenue",
  ) {
    const sightings = new Map<
      string,
      Array<{ pam_user_id: string; entry: { attribution_type: WeeklyOpportunityAttribution; usd_value: number }; as_of: string }>
    >();
    for (const r of pamReports) {
      const asOf = asOfOf(r);
      for (const e of pick(r.metrics)) {
        const list = sightings.get(e.opportunity_id) ?? [];
        list.push({ pam_user_id: r.pam_user_id, entry: { attribution_type: e.attribution_type, usd_value: e.usd_value }, as_of: asOf });
        sightings.set(e.opportunity_id, list);
      }
    }

    const conflicts: WeeklyCommercialConflict[] = [];
    let sourced = 0;
    let influenced = 0;
    for (const [opportunityId, list] of sightings) {
      const distinct = new Set(list.map((s) => `${s.entry.attribution_type}:${s.entry.usd_value}`));
      if (distinct.size > 1) {
        conflicts.push({
          kind,
          opportunity_id: opportunityId,
          entries: list.map((s) => ({ pam_user_id: s.pam_user_id, attribution_type: s.entry.attribution_type, usd_value: s.entry.usd_value, as_of: s.as_of })),
        });
      }
      const chosen = list.reduce((latest, s) => (s.as_of > latest.as_of ? s : latest));
      if (chosen.entry.attribution_type === "partner_sourced") sourced += chosen.entry.usd_value;
      else influenced += chosen.entry.usd_value;
    }
    return { sourced, influenced, total: sourced + influenced, count: sightings.size, conflicts };
  }

  const pipeline = dedupeMoneyEntries((m) => m.commercial.contributing_open_pipeline, "open_pipeline");
  const revenue = dedupeMoneyEntries((m) => m.commercial.contributing_won_revenue, "won_revenue");

  // opportunity_date is immutable, so a plain Set union is correct here --
  // no conflict handling needed (see the contract's own comment on this).
  const createdIds = new Set<string>();
  for (const r of pamReports) for (const e of r.metrics.commercial.contributing_opportunities_created) createdIds.add(e.opportunity_id);

  return {
    open_pipeline_usd: { sourced: pipeline.sourced, influenced: pipeline.influenced, total: pipeline.total },
    won_revenue_usd: { sourced: revenue.sourced, influenced: revenue.influenced, total: revenue.total },
    opportunity_count_open: pipeline.count,
    opportunities_created_count: createdIds.size,
    deals_won_count: revenue.count,
    conflicts: [...pipeline.conflicts, ...revenue.conflicts],
  };
}

// Pure -- testable without a DB. Same dedupe/conflict treatment as
// aggregateTeamCommercial above, applied to each PAM's own already-deduped
// marketing contributing_opportunities list.
export function aggregateTeamMarketing(pamReports: PamReportForAggregation[]) {
  const activity_count = pamReports.reduce((s, r) => s + r.metrics.marketing.activity_count, 0);

  const sightings = new Map<string, Array<{ pam_user_id: string; entry: WeeklyMarketingContributingOpportunity; as_of: string }>>();
  for (const r of pamReports) {
    const asOf = asOfOf(r);
    for (const e of r.metrics.marketing.commercial_impact.contributing_opportunities) {
      const list = sightings.get(e.opportunity_id) ?? [];
      list.push({ pam_user_id: r.pam_user_id, entry: e, as_of: asOf });
      sightings.set(e.opportunity_id, list);
    }
  }

  const conflicts: WeeklyMarketingConflict[] = [];
  let open_pipeline_usd = 0;
  let won_revenue_usd = 0;
  for (const [opportunityId, list] of sightings) {
    const distinct = new Set(list.map((s) => `${s.entry.status}:${s.entry.usd_value}`));
    if (distinct.size > 1) {
      conflicts.push({
        opportunity_id: opportunityId,
        entries: list.map((s) => ({ pam_user_id: s.pam_user_id, status: s.entry.status, usd_value: s.entry.usd_value, as_of: s.as_of })),
      });
    }
    const chosen = list.reduce((latest, s) => (s.as_of > latest.as_of ? s : latest));
    if (chosen.entry.status === "open") open_pipeline_usd += chosen.entry.usd_value;
    else if (chosen.entry.status === "won") won_revenue_usd += chosen.entry.usd_value;
  }

  return {
    activity_count,
    commercial_impact: { unique_linked_opportunity_count: sightings.size, open_pipeline_usd, won_revenue_usd },
    conflicts,
  };
}

// Every PAM row is produced by calling getPamWeeklyReport itself -- the team
// view can never drift from what a PAM sees on their own report, and each
// row correctly stays frozen (submitted) or live (draft) on its own terms.
// Team-wide commercial/marketing totals are derived ENTIRELY from
// aggregating pam_reports (never an independent live/global-scoped query),
// so the team total is provably exactly the sum of the PAM population shown
// -- see aggregateTeamCommercial/aggregateTeamMarketing above.
export async function getTeamWeeklyReport(weekStartDate: string): Promise<TeamWeeklyReportEnvelope> {
  assertCanonicalMonday(weekStartDate);

  const territories = await db.select().from(territoriesTable);
  const currentOwnerIds = new Set(territories.filter((t) => t.ownerUserId !== null).map((t) => t.ownerUserId!));

  // A persisted report must keep appearing under its own pinned
  // territory_ids/frozen snapshot even if current territory ownership (or
  // the owner's current role) has since changed -- so the population is the
  // UNION of current canonical owners and anyone who already has a row for
  // this exact week, not current ownership alone.
  const existingReportRows = await db
    .select({ pamUserId: weeklyPamReportsTable.pamUserId })
    .from(weeklyPamReportsTable)
    .where(eq(weeklyPamReportsTable.weekStartDate, weekStartDate));
  const reportedPamIds = new Set(existingReportRows.map((r) => r.pamUserId));

  const candidateIds = new Set<string>([...currentOwnerIds, ...reportedPamIds]);
  const candidateUsers = candidateIds.size ? await db.select().from(usersTable).where(inArray(usersTable.id, [...candidateIds])) : [];

  // Source-aware population: a CURRENT territory owner is only included if
  // their CURRENT role is "pam" (never let a Head/Admin who happens to own
  // a territory today become a phantom PAM row). A PERSISTED report row is
  // kept regardless of the owner's current role -- a historical submitted
  // report must never disappear just because the PAM was later
  // promoted/reassigned, per the frozen-historical-report principle.
  const pamUserIds = [...candidateIds].filter((id) => {
    const user = candidateUsers.find((u) => u.id === id);
    if (!user) return false;
    if (reportedPamIds.has(id)) return true;
    return user.role === "pam";
  });

  const pam_reports = await Promise.all(
    pamUserIds.map(async (pamUserId) => {
      const user = candidateUsers.find((u) => u.id === pamUserId)!;
      return { ...(await getPamWeeklyReport(pamUserId, weekStartDate)), pam_name: user.name, current_role: user.role };
    }),
  );

  // Derived from the actual territory_ids each returned report ended up
  // using (pinned-historical or current-live), not today's ownership map.
  const pams_with_multiple_territories = pam_reports.filter((r) => r.territory_ids.length > 1).map((r) => r.pam_user_id);

  const forAggregation: PamReportForAggregation[] = pam_reports.map((r) => ({
    pam_user_id: r.pam_user_id,
    status: r.status,
    snapshot_generated_at: r.snapshot_generated_at,
    metrics: r.metrics,
  }));

  const team_commercial = aggregateTeamCommercial(forAggregation);
  const team_marketing = aggregateTeamMarketing(forAggregation);

  const help_requests = pam_reports
    .filter((r) => r.commentary.help_needed && r.commentary.help_needed.trim() !== "")
    .map((r) => ({ pam_user_id: r.pam_user_id, pam_name: r.pam_name, help_needed: r.commentary.help_needed! }));

  const attention_summary = {
    stalled_recruitment_count: pam_reports.reduce((sum, r) => sum + r.metrics.recruitment.stalled_items.length, 0),
    relationships_needing_attention_count: pam_reports.reduce((sum, r) => sum + r.metrics.recruitment.needing_attention_relationships.length, 0),
    pams_behind_target: pam_reports.filter((r) => r.metrics.commercial.targets.some((t) => t.status === "behind")).length,
  };

  return {
    week_start: weekStartDate,
    week_end: weekEndInclusive(weekStartDate),
    generated_at: new Date().toISOString(),
    report_state_summary: {
      submitted_count: pam_reports.filter((r) => r.status === "submitted").length,
      draft_count: pam_reports.filter((r) => r.status === "draft").length,
    },
    pams_with_multiple_territories,
    team_commercial,
    team_marketing,
    pam_reports,
    help_requests,
    attention_summary,
  };
}
