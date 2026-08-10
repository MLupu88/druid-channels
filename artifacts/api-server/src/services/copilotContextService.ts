// Stage 6.4 PAM Workspace Copilot: the controlled context boundary between
// the authenticated PAM's real workspace data and the DeepSeek prompt. This
// module is the ONLY place that reads the database for the Copilot -- the
// model itself never sees a table, a query, or SQL, only the bounded,
// already-shaped JSON these functions return. Every function here is a
// thin, deterministic read: no new business rules are invented, and every
// non-trivial computation (target progress, recruitment staleness,
// portfolio attention, period ranges) calls the exact same canonical
// service functions the rest of the app already uses (targetService,
// partnerRecruitmentService, partnerRelationshipService, kpiRegistry) --
// see the Stage 6.4 report for why this matters (never a second,
// potentially-drifting copy of a business rule).
import { db } from "@workspace/db";
import {
  companiesTable,
  partnerRelationshipsTable,
  partnerRecruitmentsTable,
  partnerActivitiesTable,
  prospectsTable,
  channelRadarSignalsTable,
  campaignsTable,
  type Company,
} from "@workspace/db";
import { eq, and, inArray, ne, desc } from "drizzle-orm";
import { getTeamTargets, type TeamTargetRow } from "./targetService";
import { resolvePeriodRange } from "./kpiRegistry";
import { computeDaysInStage, isStalled, isActiveStage, type RecruitmentStage } from "./partnerRecruitmentService";
import { isNeedingAttention } from "./partnerRelationshipService";
import { getTerritoryPotential, type TerritoryPotentialSummary } from "./territoryPotentialService";

const TOP_N = 8;
const RADAR_TOP_N = 8;
const ACTIVITY_TOP_N = 5;
const PARTNER_ACTIVITY_TOP_N = 5;
const PARTNER_RADAR_TOP_N = 5;

export interface PamIdentity {
  pam_user_id: string;
  pam_name: string;
  territory_id: string;
  territory_name: string;
  territory_countries: string[];
  period: string;
  period_key: string;
}

export interface PerformanceRow {
  metric_key: string;
  metric_label: string;
  target: number | null;
  actual: number | null;
  progress_percent: number | null;
  status: "ahead" | "behind" | "no_target";
}

export interface RecruitmentAttentionItem {
  recruitment_id: string;
  company_name: string;
  stage: string;
  days_in_stage: number;
  is_stalled: boolean;
  next_step: string | null;
  follow_up_date: string | null;
}

export interface PortfolioAttentionItem {
  relationship_id: string;
  company_name: string;
  status: string;
  last_interaction_at: string | null;
  next_action: string | null;
}

export interface RadarSignalItem {
  signal_id: string;
  entity_name: string;
  signal_type: string;
  implication: string;
  impact: string;
  headline: string;
  recommended_action: string;
  source_title: string;
  discovered_at: string;
}

export interface ActivityItem {
  name: string;
  type: string;
  status: string;
  activity_date: string | null;
  mqls: number;
  partner_referrals: number;
}

export interface DiscoveryProspectItem {
  company_name: string;
  priority: "A" | "B";
  status: string;
  why_it_fits: string | null;
}

export interface PamWorkspaceSummary {
  identity: PamIdentity;
  performance: PerformanceRow[];
  discovery: {
    prospect_count: number;
    top_prospects: DiscoveryProspectItem[];
  };
  recruitment: {
    active_count: number;
    stalled_count: number;
    priority_recruitments: RecruitmentAttentionItem[];
  };
  portfolio: {
    active_partner_count: number;
    needs_attention: PortfolioAttentionItem[];
  };
  radar: {
    recent_signals: RadarSignalItem[];
  };
  activity: {
    recent: ActivityItem[];
  };
  // Stage 6.5: deterministic Territory Potential facts (counts, saturation
  // state, potential band) -- the exact same read model Team Targets/PAM
  // workspace render, reused verbatim rather than recomputed. Never a
  // second, potentially-drifting source of these numbers.
  territory_potential: TerritoryPotentialSummary;
  // Deterministic, plain-language notes about what's missing/unknown --
  // never a substitute for the model's own "unknown means unknown"
  // instruction, just an explicit head start so it doesn't have to infer
  // absence from an empty array.
  data_quality_notes: string[];
}

function shapePerformance(rows: TeamTargetRow[]): PerformanceRow[] {
  return rows.map((r) => ({
    metric_key: r.metric_key,
    metric_label: r.metric_label,
    target: r.target_value,
    actual: r.actual_value,
    progress_percent: r.progress_percent,
    status: r.status,
  }));
}

export async function getPamTargets(pamUserId: string, territoryId: string, periodKey: string): Promise<PerformanceRow[]> {
  // Reuses targetService.getTeamTargets exactly -- the same function Team
  // Targets/My Targets read -- so the Copilot can never disagree with what
  // the PAM sees on-screen. No KPI math is duplicated here.
  const rows = await getTeamTargets(periodKey, { pamUserId, territoryId });
  return shapePerformance(rows);
}

export async function getPriorityRecruitments(territoryId: string, limit = TOP_N): Promise<RecruitmentAttentionItem[]> {
  const rows = await db
    .select({ recruitment: partnerRecruitmentsTable, company: companiesTable })
    .from(partnerRecruitmentsTable)
    .innerJoin(companiesTable, eq(partnerRecruitmentsTable.companyId, companiesTable.id))
    .where(eq(partnerRecruitmentsTable.territoryId, territoryId));

  const active = rows
    .filter((r) => isActiveStage(r.recruitment.stage as RecruitmentStage))
    .map((r) => {
      const daysInStage = computeDaysInStage(r.recruitment.stageEnteredAt);
      return {
        recruitment_id: r.recruitment.id,
        company_name: r.company.name,
        stage: r.recruitment.stage,
        days_in_stage: daysInStage,
        is_stalled: isStalled(r.recruitment.stage, daysInStage),
        next_step: r.recruitment.nextStep,
        follow_up_date: r.recruitment.followUpDate,
      };
    });

  // Stalled-first, then longest-in-stage first -- the same ordering
  // priority a PAM working the pipeline top-down would use.
  active.sort((a, b) => {
    if (a.is_stalled !== b.is_stalled) return a.is_stalled ? -1 : 1;
    return b.days_in_stage - a.days_in_stage;
  });

  return active.slice(0, limit);
}

export async function getPartnersNeedingAttention(territoryId: string, limit = TOP_N): Promise<PortfolioAttentionItem[]> {
  const rows = await db
    .select({ relationship: partnerRelationshipsTable, company: companiesTable })
    .from(partnerRelationshipsTable)
    .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
    .where(eq(partnerRelationshipsTable.territoryId, territoryId));

  const attention = rows
    .filter((r) => isNeedingAttention(r.relationship))
    .map((r) => ({
      relationship_id: r.relationship.id,
      company_name: r.company.name,
      status: r.relationship.status,
      last_interaction_at: r.relationship.lastInteractionAt ? r.relationship.lastInteractionAt.toISOString() : null,
      next_action: r.relationship.nextAction,
    }));

  // Oldest/never-contacted first -- the most overdue relationships surface
  // before ones that merely crossed the 30-day threshold recently.
  attention.sort((a, b) => {
    const aMs = a.last_interaction_at ? new Date(a.last_interaction_at).getTime() : -Infinity;
    const bMs = b.last_interaction_at ? new Date(b.last_interaction_at).getTime() : -Infinity;
    return aMs - bMs;
  });

  return attention.slice(0, limit);
}

export async function getRecentRadarSignals(territoryId: string, limit = RADAR_TOP_N): Promise<RadarSignalItem[]> {
  const rows = await db
    .select()
    .from(channelRadarSignalsTable)
    .where(and(eq(channelRadarSignalsTable.territoryId, territoryId), ne(channelRadarSignalsTable.status, "dismissed")))
    .orderBy(desc(channelRadarSignalsTable.discoveredAt))
    .limit(limit);

  return rows.map((s) => ({
    signal_id: s.id,
    entity_name: s.entityName,
    signal_type: s.signalType,
    implication: s.implication,
    impact: s.impact,
    headline: s.headline,
    recommended_action: s.recommendedAction,
    source_title: s.sourceTitle,
    discovered_at: s.discoveredAt.toISOString(),
  }));
}

export async function getRecentActivities(territoryName: string, limit = ACTIVITY_TOP_N): Promise<ActivityItem[]> {
  const rows = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.territory, territoryName))
    .orderBy(desc(campaignsTable.createdAt))
    .limit(limit);

  return rows.map((c) => ({
    name: c.name,
    type: c.type,
    status: c.status,
    activity_date: c.activityDate,
    mqls: c.mqls,
    partner_referrals: c.partnerReferrals,
  }));
}

async function getTopDiscoveryProspects(territoryId: string, limit = TOP_N): Promise<{ count: number; top: DiscoveryProspectItem[] }> {
  const rows = await db
    .select({ prospect: prospectsTable, company: companiesTable })
    .from(prospectsTable)
    .innerJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
    .where(eq(prospectsTable.territoryId, territoryId));

  const relevant = rows.filter((r) => r.prospect.status === "new" || r.prospect.status === "accepted");
  relevant.sort((a, b) => {
    if (a.prospect.priority !== b.prospect.priority) return a.prospect.priority === "A" ? -1 : 1;
    return b.prospect.createdAt.getTime() - a.prospect.createdAt.getTime();
  });

  return {
    count: relevant.length,
    top: relevant.slice(0, limit).map((r) => ({
      company_name: r.company.name,
      priority: r.prospect.priority as "A" | "B",
      status: r.prospect.status,
      why_it_fits: r.prospect.whyItFits,
    })),
  };
}

function buildDataQualityNotes(summary: Omit<PamWorkspaceSummary, "data_quality_notes">): string[] {
  const notes: string[] = [];
  for (const p of summary.performance) {
    if (p.status === "no_target") notes.push(`No ${p.metric_label} target has been configured for this period.`);
  }
  if (summary.portfolio.active_partner_count === 0) notes.push("No active Portfolio relationships in this territory.");
  if (summary.recruitment.active_count === 0) notes.push("No active recruitments in this territory.");
  if (summary.radar.recent_signals.length === 0) notes.push("No recent Channel Radar signals for this territory.");
  if (summary.activity.recent.length === 0) notes.push("No marketing activity logged yet for this territory.");
  if (summary.territory_potential.potential_band === "insufficient_data") {
    notes.push("Not enough Discovery/Portfolio history yet to assess Territory Potential for this territory.");
  }
  return notes;
}

// The single bounded snapshot handed to DeepSeek for an operational
// question. Every list here is already top-N/recent-N -- never a full
// table dump (see the 6.4 spec's "Keep context size bounded").
export async function getPamWorkspaceSummary(
  pamUserId: string,
  pamName: string,
  territoryId: string,
  territoryName: string,
  territoryCountries: string[],
  periodKey: string,
): Promise<PamWorkspaceSummary> {
  const periodInfo = resolvePeriodRange(periodKey);

  const [performance, priorityRecruitments, allRecruitmentsForCount, partnersNeedingAttention, allRelationshipsForCount, radarSignals, activities, discovery, territoryPotential] =
    await Promise.all([
      getPamTargets(pamUserId, territoryId, periodKey),
      getPriorityRecruitments(territoryId),
      db.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.territoryId, territoryId)),
      getPartnersNeedingAttention(territoryId),
      db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.territoryId, territoryId)),
      getRecentRadarSignals(territoryId),
      getRecentActivities(territoryName),
      getTopDiscoveryProspects(territoryId),
      getTerritoryPotential(territoryId, territoryName),
    ]);

  const activeRecruitmentCount = allRecruitmentsForCount.filter((r) => isActiveStage(r.stage as RecruitmentStage)).length;
  const stalledCount = allRecruitmentsForCount.filter((r) => isStalled(r.stage, computeDaysInStage(r.stageEnteredAt))).length;
  const activePartnerCount = allRelationshipsForCount.filter((r) => r.status === "active").length;

  const base: Omit<PamWorkspaceSummary, "data_quality_notes"> = {
    identity: {
      pam_user_id: pamUserId,
      pam_name: pamName,
      territory_id: territoryId,
      territory_name: territoryName,
      territory_countries: territoryCountries,
      period: periodInfo.label,
      period_key: periodKey,
    },
    performance,
    discovery: { prospect_count: discovery.count, top_prospects: discovery.top },
    recruitment: { active_count: activeRecruitmentCount, stalled_count: stalledCount, priority_recruitments: priorityRecruitments },
    portfolio: { active_partner_count: activePartnerCount, needs_attention: partnersNeedingAttention },
    radar: { recent_signals: radarSignals },
    activity: { recent: activities },
    territory_potential: territoryPotential,
  };

  return { ...base, data_quality_notes: buildDataQualityNotes(base) };
}

export interface PartnerContext {
  company: { id: string; name: string; domain: string | null; country: string };
  relationship: {
    status: string;
    relationship_started_at: string | null;
    last_interaction_at: string | null;
    next_action: string | null;
    next_action_due_at: string | null;
  } | null;
  recruitment: {
    stage: string;
    days_in_stage: number;
    is_stalled: boolean;
    next_step: string | null;
    follow_up_date: string | null;
  } | null;
  recent_activities: Array<{ activity_type: string; note: string; occurred_at: string }>;
  recent_radar_signals: Array<{ headline: string; signal_type: string; implication: string; discovered_at: string }>;
}

// Read-only, scoped to a single company already known to be within the
// caller's authorized territory (the route enforces that before calling
// this -- see resolveMentionedCompany below, and routes/pam_copilot.ts).
export async function getPartnerContext(companyId: string, territoryId: string): Promise<PartnerContext | null> {
  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company) return null;

  const [[relationship], [recruitment], radarSignalRows] = await Promise.all([
    db
      .select()
      .from(partnerRelationshipsTable)
      .where(and(eq(partnerRelationshipsTable.companyId, companyId), eq(partnerRelationshipsTable.territoryId, territoryId))),
    db
      .select()
      .from(partnerRecruitmentsTable)
      .where(and(eq(partnerRecruitmentsTable.companyId, companyId), eq(partnerRecruitmentsTable.territoryId, territoryId)))
      .orderBy(desc(partnerRecruitmentsTable.updatedAt))
      .limit(1),
    db
      .select()
      .from(channelRadarSignalsTable)
      .where(and(eq(channelRadarSignalsTable.companyId, companyId), eq(channelRadarSignalsTable.territoryId, territoryId)))
      .orderBy(desc(channelRadarSignalsTable.discoveredAt))
      .limit(PARTNER_RADAR_TOP_N),
  ]);

  const activities = relationship
    ? await db
        .select()
        .from(partnerActivitiesTable)
        .where(eq(partnerActivitiesTable.relationshipId, relationship.id))
        .orderBy(desc(partnerActivitiesTable.occurredAt))
        .limit(PARTNER_ACTIVITY_TOP_N)
    : [];

  return {
    company: { id: company.id, name: company.name, domain: company.domain, country: company.country },
    relationship: relationship
      ? {
          status: relationship.status,
          relationship_started_at: relationship.relationshipStartedAt,
          last_interaction_at: relationship.lastInteractionAt ? relationship.lastInteractionAt.toISOString() : null,
          next_action: relationship.nextAction,
          next_action_due_at: relationship.nextActionDueAt,
        }
      : null,
    recruitment: recruitment
      ? {
          stage: recruitment.stage,
          days_in_stage: computeDaysInStage(recruitment.stageEnteredAt),
          is_stalled: isStalled(recruitment.stage, computeDaysInStage(recruitment.stageEnteredAt)),
          next_step: recruitment.nextStep,
          follow_up_date: recruitment.followUpDate,
        }
      : null,
    recent_activities: activities.map((a) => ({ activity_type: a.activityType, note: a.note, occurred_at: a.occurredAt.toISOString() })),
    recent_radar_signals: radarSignalRows.map((s) => ({
      headline: s.headline,
      signal_type: s.signalType,
      implication: s.implication,
      discovered_at: s.discoveredAt.toISOString(),
    })),
  };
}

export type CompanyResolution =
  | { status: "found"; company: Company }
  | { status: "ambiguous"; matches: string[] }
  | { status: "none" }
  | { status: "not_found" };

// Deterministic, exact-substring-only company resolution scoped to
// companies that actually have SOME presence (Portfolio, Recruitment, or
// Discovery) in the caller's authorized territory -- never a
// cross-territory or model-guessed match (see the 6.4 spec's section 8:
// "Do not let the model infer a company from a similar name and cross
// authorization boundaries"). explicitCompanyId, when provided, is checked
// against this exact same authorized set -- it can never be used to pull in
// a company from outside the caller's territory.
export async function resolveMentionedCompany(message: string, explicitCompanyId: string | null, territoryId: string): Promise<CompanyResolution> {
  const [relationships, recruitments, prospects] = await Promise.all([
    db.select({ companyId: partnerRelationshipsTable.companyId }).from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.territoryId, territoryId)),
    db.select({ companyId: partnerRecruitmentsTable.companyId }).from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.territoryId, territoryId)),
    db.select({ companyId: prospectsTable.companyId }).from(prospectsTable).where(eq(prospectsTable.territoryId, territoryId)),
  ]);
  const authorizedCompanyIds = new Set([...relationships, ...recruitments, ...prospects].map((r) => r.companyId));
  if (authorizedCompanyIds.size === 0) return explicitCompanyId ? { status: "not_found" } : { status: "none" };

  const companies = await db.select().from(companiesTable).where(inArray(companiesTable.id, [...authorizedCompanyIds]));

  if (explicitCompanyId) {
    const company = companies.find((c) => c.id === explicitCompanyId);
    return company ? { status: "found", company } : { status: "not_found" };
  }

  const q = message.toLowerCase();
  const matches = companies.filter((c) => q.includes(c.name.toLowerCase()));
  if (matches.length === 0) return { status: "none" };
  if (matches.length === 1) return { status: "found", company: matches[0]! };
  return { status: "ambiguous", matches: matches.map((c) => c.name) };
}
