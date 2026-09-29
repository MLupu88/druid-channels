// Phase 12 Aniri PAM-level intelligence: the controlled, read-only factual
// boundary for GET /channel-chief/pam-overview (routes/channel_chief.ts).
// Same philosophy as channelChiefContextService.ts and
// copilotContextService.ts -- every non-trivial computation (target
// attainment, recruitment staleness, portfolio attention) calls the exact
// same canonical service functions the rest of the app already uses, never
// a second, potentially-drifting copy of a business rule. Unlike
// channelChiefContextService (Global/company-wide scope), this is scoped to
// ONE PAM -- the "Chief of Staff asked about one specific person" case
// get_channel_snapshot cannot answer.
//
// Scoping rules (Canonical Portfolio Truth):
// - Portfolio: partner_relationships.assigned_user_id = the PAM. Territory
//   ownership is context only, never a substitute for relationship
//   assignment (unassigned / reassigned relationships in the PAM's territory
//   are not theirs).
// - Partner counts: only confirmed relationships. needs_review is evidence
//   awaiting human confirmation and is surfaced separately; closed is
//   historical.
// - Opportunities: DRUID-recorded partner_opportunities assigned to the PAM.
//   This is NOT the complete HubSpot pipeline (HubSpot is never read here).
// - Recruitment: partner_recruitments.assigned_user_id = the PAM. A
//   recruitment in the PAM's territory assigned to someone else (or to no
//   one) is not theirs.
// - Territories: every territory the PAM owns (territories.owner_user_id),
//   never just the first. Context only; performance targets are the one
//   block that stays territory-scoped, per owned territory.
//
// DRUID owns facts; Aniri interprets them (see the Phase 12 brief) -- this
// module never computes a performance "score," never fabricates a metric
// the app doesn't actually store, and explicitly lists in `availability`
// whatever it could not compute from canonical data.
import { db } from "@workspace/db";
import {
  companiesTable,
  territoriesTable,
  partnerRelationshipsTable,
  partnerActivitiesTable,
  partnerRecruitmentsTable,
  partnerOpportunitiesTable,
  type User,
} from "@workspace/db";
import { eq, inArray, desc, asc } from "drizzle-orm";
import {
  getPamTargets,
  toPortfolioAttentionItems,
  toPriorityRecruitmentItems,
  type PerformanceRow,
  type RecruitmentAttentionItem,
  type PortfolioAttentionItem,
} from "./copilotContextService";
import { resolvePeriodRange } from "./kpiRegistry";
import { computeDaysInStage, isStalled, isActiveStage, type RecruitmentStage } from "./partnerRecruitmentService";
import { isNeedingAttention } from "./partnerRelationshipService";
import { buildUsdRateMap, usdValueOf } from "./kpiService";

const PORTFOLIO_TOP_N = 10;
const ATTENTION_TOP_N = 5;
const RECRUITMENT_TOP_N = 5;
const ACTIVITY_TOP_N = 5;
const OPPORTUNITY_TOP_N = 5;

// Relationship statuses that represent a confirmed, current partner.
// needs_review (unconfirmed evidence) and closed (historical) never count.
const CONFIRMED_PARTNER_STATUSES = new Set(["active", "dormant"]);

// Shared with pamDirectoryService so both Channel Chief contracts represent
// territory ownership identically.
export interface PamTerritory {
  territory_id: string;
  territory_name: string;
  countries: string[];
}

// Callers pass EVERY territory the user owns (territories.owner_user_id),
// ordered by name then id -- never just the first (same multi-territory
// semantics as authz.getOwnTerritories, queried directly because callers
// also need each territory's countries).
export function toPamTerritory(t: { id: string; name: string; countries: string[] }): PamTerritory {
  return { territory_id: t.id, territory_name: t.name, countries: t.countries };
}

export interface PamOverviewIdentity {
  pam_user_id: string;
  pam_name: string;
  pam_email: string;
  active: boolean;
  // Every territory this PAM owns (territories.owner_user_id), ordered by
  // name then id. Empty, never invented, when they own none.
  territories: PamTerritory[];
  period: string;
  period_key: string;
}

export interface PamPortfolioPartnerItem {
  relationship_id: string;
  company_name: string;
  status: string;
}

export interface PamPortfolioActivityItem {
  company_name: string;
  activity_type: string;
  note: string;
  occurred_at: string;
}

export interface PamOverviewPortfolio {
  // Confirmed partners assigned to this PAM: status active or dormant.
  assigned_partner_count: number;
  active_partner_count: number;
  // Confirmed-relationship lifecycle counts for relationships assigned to
  // this PAM. closed is historical and not part of assigned_partner_count.
  counts_by_status: { active: number; dormant: number; closed: number };
  // Assigned relationships awaiting human confirmation -- review context,
  // never a partner count.
  needs_review_count: number;
  needs_attention_count: number;
  needs_attention: PortfolioAttentionItem[];
  assigned_partners: PamPortfolioPartnerItem[];
  recent_activity: PamPortfolioActivityItem[];
}

export interface PamOverviewPerformanceRow extends PerformanceRow {
  territory_id: string;
  territory_name: string;
}

export interface PamOpportunityItem {
  opportunity_id: string;
  name: string;
  company_name: string;
  customer_name: string | null;
  deal_value_usd: number;
  currency: string;
  status: string;
  attribution_type: string;
  opportunity_date: string;
  expected_close_date: string | null;
}

export interface PamOverviewDruidRecordedOpportunities {
  // Explicit provenance: these figures come only from DRUID's own
  // partner_opportunities table and are known to be a possible subset of the
  // PAM's HubSpot deals. HubSpot is not read here, so the full CRM pipeline
  // is unknown in this contract -- not zero.
  source: "druid_partner_opportunities";
  hubspot_pipeline: "not_included";
  open_count: number;
  open_value_usd: number;
  sourced_open_value_usd: number;
  influenced_open_value_usd: number;
  won_count: number;
  won_value_usd: number;
  lost_count: number;
  lost_value_usd: number;
  largest_open: PamOpportunityItem[];
  upcoming_expected_closes: PamOpportunityItem[];
  // Deliberately factual, not a "stalled" verdict: open opportunities whose
  // expected_close_date has already passed, oldest-overdue first. No
  // canonical "stalled opportunity" business rule exists yet in DRUID
  // Channels (unlike Recruitment's isStalled or Portfolio's
  // isNeedingAttention) -- see availability notes. Aniri interprets
  // urgency from these dates; this never assigns one itself.
  past_due_open: PamOpportunityItem[];
}

export interface PamOverviewRecruitment {
  active_count: number;
  stalled_count: number;
  priority_recruitments: RecruitmentAttentionItem[];
}

export interface PamOverview {
  identity: PamOverviewIdentity;
  portfolio: PamOverviewPortfolio;
  performance: PamOverviewPerformanceRow[];
  druid_recorded_opportunities: PamOverviewDruidRecordedOpportunities;
  recruitment: PamOverviewRecruitment;
  activity: { recent: PamPortfolioActivityItem[] };
  availability: string[];
}

async function getPortfolioForPam(pamUserId: string, limit = PORTFOLIO_TOP_N): Promise<PamOverviewPortfolio> {
  const rows = await db
    .select({ relationship: partnerRelationshipsTable, company: companiesTable })
    .from(partnerRelationshipsTable)
    .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
    .where(eq(partnerRelationshipsTable.assignedUserId, pamUserId));

  const countsByStatus = { active: 0, dormant: 0, closed: 0 };
  let needsReviewCount = 0;
  for (const r of rows) {
    const status = r.relationship.status;
    if (status === "needs_review") needsReviewCount++;
    else if (status in countsByStatus) countsByStatus[status as keyof typeof countsByStatus]++;
  }

  const confirmed = rows.filter((r) => CONFIRMED_PARTNER_STATUSES.has(r.relationship.status));
  const assignedPartners: PamPortfolioPartnerItem[] = confirmed
    .map((r) => ({ relationship_id: r.relationship.id, company_name: r.company.name, status: r.relationship.status }))
    .sort((a, b) => a.company_name.localeCompare(b.company_name))
    .slice(0, limit);

  const relationshipIds = rows.map((r) => r.relationship.id);
  const recentActivityRows = relationshipIds.length
    ? await db
        .select({ activity: partnerActivitiesTable, company: companiesTable })
        .from(partnerActivitiesTable)
        .innerJoin(partnerRelationshipsTable, eq(partnerActivitiesTable.relationshipId, partnerRelationshipsTable.id))
        .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
        .where(inArray(partnerActivitiesTable.relationshipId, relationshipIds))
        .orderBy(desc(partnerActivitiesTable.occurredAt))
        .limit(ACTIVITY_TOP_N)
    : [];

  // Attention reuses the canonical isNeedingAttention predicate and ordering
  // (toPortfolioAttentionItems) over the same assigned rows -- never a
  // second copy of the rule, never a territory-wide re-query.
  return {
    assigned_partner_count: confirmed.length,
    active_partner_count: countsByStatus.active,
    counts_by_status: countsByStatus,
    needs_review_count: needsReviewCount,
    needs_attention_count: rows.filter((r) => isNeedingAttention(r.relationship)).length,
    needs_attention: toPortfolioAttentionItems(rows, ATTENTION_TOP_N),
    assigned_partners: assignedPartners,
    recent_activity: recentActivityRows.map((r) => ({
      company_name: r.company.name,
      activity_type: r.activity.activityType,
      note: r.activity.note,
      occurred_at: r.activity.occurredAt.toISOString(),
    })),
  };
}

async function getDruidRecordedOpportunitiesForPam(pamUserId: string, limit = OPPORTUNITY_TOP_N): Promise<PamOverviewDruidRecordedOpportunities> {
  const rows = await db
    .select({ opportunity: partnerOpportunitiesTable, company: companiesTable })
    .from(partnerOpportunitiesTable)
    .innerJoin(companiesTable, eq(partnerOpportunitiesTable.companyId, companiesTable.id))
    .where(eq(partnerOpportunitiesTable.assignedUserId, pamUserId));

  const rateByCurrency = await buildUsdRateMap(rows.map((r) => r.opportunity.currency));

  const toItem = (r: (typeof rows)[number]): PamOpportunityItem & { valueUsd: number } => {
    const valueUsd = usdValueOf({ dealValue: r.opportunity.dealValue, currency: r.opportunity.currency }, rateByCurrency);
    return {
      opportunity_id: r.opportunity.id,
      name: r.opportunity.name,
      company_name: r.company.name,
      customer_name: r.opportunity.customerName,
      deal_value_usd: valueUsd,
      currency: r.opportunity.currency,
      status: r.opportunity.status,
      attribution_type: r.opportunity.attributionType,
      opportunity_date: r.opportunity.opportunityDate,
      expected_close_date: r.opportunity.expectedCloseDate,
      valueUsd,
    };
  };

  const items = rows.map(toItem);
  const open = items.filter((i) => i.status === "open");
  const won = items.filter((i) => i.status === "won");
  const lost = items.filter((i) => i.status === "lost");

  const todayStr = new Date().toISOString().slice(0, 10);
  const pastDueOpen = open
    .filter((i) => i.expected_close_date && i.expected_close_date < todayStr)
    .sort((a, b) => (a.expected_close_date ?? "").localeCompare(b.expected_close_date ?? ""));

  const upcomingExpectedCloses = open
    .filter((i) => i.expected_close_date && i.expected_close_date >= todayStr)
    .sort((a, b) => (a.expected_close_date ?? "").localeCompare(b.expected_close_date ?? ""));

  const largestOpen = [...open].sort((a, b) => b.valueUsd - a.valueUsd);

  const stripInternal = (i: PamOpportunityItem & { valueUsd: number }): PamOpportunityItem => {
    const { valueUsd: _valueUsd, ...rest } = i;
    return rest;
  };

  return {
    source: "druid_partner_opportunities",
    hubspot_pipeline: "not_included",
    open_count: open.length,
    open_value_usd: open.reduce((sum, i) => sum + i.valueUsd, 0),
    sourced_open_value_usd: open.filter((i) => i.attribution_type === "partner_sourced").reduce((sum, i) => sum + i.valueUsd, 0),
    influenced_open_value_usd: open.filter((i) => i.attribution_type === "partner_influenced").reduce((sum, i) => sum + i.valueUsd, 0),
    won_count: won.length,
    won_value_usd: won.reduce((sum, i) => sum + i.valueUsd, 0),
    lost_count: lost.length,
    lost_value_usd: lost.reduce((sum, i) => sum + i.valueUsd, 0),
    largest_open: largestOpen.slice(0, limit).map(stripInternal),
    upcoming_expected_closes: upcomingExpectedCloses.slice(0, limit).map(stripInternal),
    past_due_open: pastDueOpen.slice(0, limit).map(stripInternal),
  };
}

async function getRecruitmentForPam(pamUserId: string): Promise<PamOverviewRecruitment> {
  const rows = await db
    .select({ recruitment: partnerRecruitmentsTable, company: companiesTable })
    .from(partnerRecruitmentsTable)
    .innerJoin(companiesTable, eq(partnerRecruitmentsTable.companyId, companiesTable.id))
    .where(eq(partnerRecruitmentsTable.assignedUserId, pamUserId));

  return {
    active_count: rows.filter((r) => isActiveStage(r.recruitment.stage as RecruitmentStage)).length,
    stalled_count: rows.filter((r) => isStalled(r.recruitment.stage, computeDaysInStage(r.recruitment.stageEnteredAt))).length,
    priority_recruitments: toPriorityRecruitmentItems(rows, RECRUITMENT_TOP_N),
  };
}

// Performance targets are canonically per (PAM, territory) -- one set of
// rows per owned territory, each labelled with its territory so two
// territories' rows for the same metric are never conflated.
async function getPerformanceForPam(pamUserId: string, territories: PamTerritory[], periodKey: string): Promise<PamOverviewPerformanceRow[]> {
  const perTerritory = await Promise.all(
    territories.map(async (t) =>
      (await getPamTargets(pamUserId, t.territory_id, periodKey)).map((row) => ({
        ...row,
        territory_id: t.territory_id,
        territory_name: t.territory_name,
      })),
    ),
  );
  return perTerritory.flat();
}

export function buildAvailabilityNotes(overview: Omit<PamOverview, "availability">): string[] {
  const notes: string[] = [];
  const hasTerritory = overview.identity.territories.length > 0;
  if (!hasTerritory) {
    notes.push(
      "This PAM owns no territory yet (territories.owner_user_id) -- performance targets are territory-scoped and are therefore empty. Portfolio, recruitment, and DRUID-recorded opportunities are selected by assignment to this PAM and are unaffected.",
    );
  }
  for (const p of overview.performance) {
    if (p.status === "no_target") notes.push(`No ${p.metric_label} target has been configured for ${p.territory_name} for this period.`);
    if (p.status === "unavailable") {
      const note = `Actual ${p.metric_label} for ${p.territory_name} is unavailable for this period, so target status cannot be determined.`;
      if (!notes.includes(note)) notes.push(note);
    }
  }
  if (overview.portfolio.assigned_partner_count === 0) {
    notes.push("No confirmed (active or dormant) Portfolio relationships are assigned to this PAM (partner_relationships.assigned_user_id).");
  }
  if (overview.portfolio.needs_review_count > 0) {
    notes.push(
      `${overview.portfolio.needs_review_count} relationship(s) assigned to this PAM are needs_review: opportunity/CRM evidence awaiting human confirmation, not confirmed partnerships. They are excluded from assigned_partner_count and appear only as review/attention context.`,
    );
  }
  if (overview.recruitment.active_count === 0) notes.push("No active recruitments are assigned to this PAM (partner_recruitments.assigned_user_id).");
  if (overview.portfolio.recent_activity.length === 0) notes.push("No partner activity has been logged yet against relationships assigned to this PAM.");
  notes.push(
    "druid_recorded_opportunities covers only opportunities recorded in DRUID (partner_opportunities assigned to this PAM). It is not the complete HubSpot pipeline: HubSpot deals are not read by this overview, so the PAM's full CRM pipeline is unknown here -- not zero.",
  );
  notes.push(
    "No canonical \"stalled opportunity\" business rule exists in DRUID Channels yet -- druid_recorded_opportunities.past_due_open lists open opportunities whose expected_close_date has passed as a plain fact, never a fabricated staleness score.",
  );
  return notes;
}

// The single bounded overview handed to the Channel Chief API route for one
// specific PAM. Every list is already top-N -- never a full-table dump.
export async function getPamOverview(pam: User, periodKey: string): Promise<PamOverview> {
  const periodInfo = resolvePeriodRange(periodKey);
  const territories: PamTerritory[] = (
    await db
      .select()
      .from(territoriesTable)
      .where(eq(territoriesTable.ownerUserId, pam.id))
      .orderBy(asc(territoriesTable.name), asc(territoriesTable.id))
  ).map(toPamTerritory);

  const identity: PamOverviewIdentity = {
    pam_user_id: pam.id,
    pam_name: pam.name,
    pam_email: pam.email,
    active: pam.active,
    territories,
    period: periodInfo.label,
    period_key: periodKey,
  };

  const [portfolio, performance, druidRecordedOpportunities, recruitment] = await Promise.all([
    getPortfolioForPam(pam.id),
    getPerformanceForPam(pam.id, territories, periodKey),
    getDruidRecordedOpportunitiesForPam(pam.id),
    getRecruitmentForPam(pam.id),
  ]);

  const base: Omit<PamOverview, "availability"> = {
    identity,
    portfolio,
    performance,
    druid_recorded_opportunities: druidRecordedOpportunities,
    recruitment,
    activity: { recent: portfolio.recent_activity },
  };

  return { ...base, availability: buildAvailabilityNotes(base) };
}
