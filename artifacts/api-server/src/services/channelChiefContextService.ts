// Aniri / Channel Chief: the controlled, read-only factual boundary between
// the machine-to-machine Channel Chief API (routes/channel_chief.ts) and the
// database. Mirrors copilotContextService.ts's philosophy exactly -- every
// non-trivial computation (KPI/target math, recruitment staleness, portfolio
// attention) calls the same canonical service functions the rest of the app
// already uses, never a second, potentially-drifting copy of a business
// rule. Unlike copilotContextService, this is Global/company-wide leadership
// scope only, never a single PAM's workspace -- so, per its own instruction,
// this module does NOT filter Discovery prospects by assigned_user_id the
// way the PAM Copilot does (see getDiscoverySnapshot below).
//
// Bounded response vs. bounded/scoped DB read -- these are NOT the same
// thing, and each function below documents which it achieves:
//   - discovery and activity: the DB read itself is top-N/LIMIT-bounded
//     (a real, unambiguous SQL filter + ORDER BY + LIMIT).
//   - recruitment and portfolio: the DB read is *scoped* (an exact,
//     unambiguous precondition of the canonical business rule -- e.g.
//     stage membership, status="active" -- is pushed into SQL) but not
//     top-N-bounded, because an exact count and correct ranking both
//     require evaluating the canonical isStalled/isNeedingAttention
//     functions (which include a fuzzy time-threshold, not just a
//     column equality) against every row in that scope. Reimplementing
//     that threshold in SQL merely to get a LIMIT would create a second,
//     driftable copy of the business rule -- deliberately not done here.
// In every case the JSON *response* returned to the caller is bounded to a
// fixed top-N list, regardless of which kind of DB read produced it.
import { db } from "@workspace/db";
import { companiesTable, territoriesTable, partnerRecruitmentsTable, partnerRelationshipsTable, prospectsTable, campaignsTable, RECRUITMENT_STAGES } from "@workspace/db";
import { eq, and, inArray, isNull, desc, asc, count } from "drizzle-orm";
import { buildHeadOfChannelsData, type ResolvedTerritory } from "./kpiService";
import { resolvePeriodRange } from "./kpiRegistry";
import { computeDaysInStage, isStalled, isActiveStage } from "./partnerRecruitmentService";
import { isNeedingAttention } from "./partnerRelationshipService";

const RECRUITMENT_TOP_N = 5;
const PORTFOLIO_TOP_N = 5;
const DISCOVERY_TOP_N = 5;
const ACTIVITY_TOP_N = 5;

// metric_targets has no company-wide row (see targetService.getTargetOverride:
// a Global scope has no single accountable PAM, so target is always null
// here) -- this is the exact same Global scope the Head of Channels KPI view
// itself uses, never a duplicated PAM-sum.
const GLOBAL_SCOPE: ResolvedTerritory = { territoryId: null, territoryName: "Global" };

// Derived from (never a hand-copied duplicate of) the canonical isActiveStage
// predicate: every RECRUITMENT_STAGES value that predicate accepts. Stage
// membership is an exact, unambiguous precondition -- pushing it into a SQL
// WHERE clause is not a reimplementation of any business rule. The actual
// staleness rule (isStalled's >14-days-in-stage threshold) is never
// expressed in SQL; see getRecruitmentSnapshot below.
const ACTIVE_RECRUITMENT_STAGES = RECRUITMENT_STAGES.filter((stage) => isActiveStage(stage));

export interface ChannelChiefRecruitmentItem {
  recruitment_id: string;
  company_name: string;
  territory_name: string;
  stage: string;
  days_in_stage: number;
  is_stalled: boolean;
  next_step: string | null;
  follow_up_date: string | null;
}

export interface ChannelChiefPortfolioItem {
  relationship_id: string;
  company_name: string;
  territory_name: string;
  status: string;
  last_interaction_at: string | null;
  next_action: string | null;
}

export interface ChannelChiefDiscoveryItem {
  company_name: string;
  territory_name: string;
  priority: "A" | "B";
  status: string;
  why_it_fits: string | null;
}

export interface ChannelChiefActivityItem {
  name: string;
  type: string;
  status: string;
  territory: string;
  activity_date: string | null;
  mqls: number;
  partner_referrals: number;
}

type HeadOfChannelsData = Awaited<ReturnType<typeof buildHeadOfChannelsData>>;

export interface ChannelChiefSnapshot {
  period: string;
  period_key: string;
  generated_at: string;
  performance: {
    partner_development: HeadOfChannelsData["partnerDevelopment"];
    weekly_commercial: HeadOfChannelsData["weeklyCommercial"];
    weekly_marketing: HeadOfChannelsData["weeklyMarketing"];
  };
  recruitment: {
    active_count: number;
    stalled_count: number;
    top_stalled: ChannelChiefRecruitmentItem[];
  };
  portfolio: {
    active_partner_count: number;
    needs_attention_count: number;
    top_needs_attention: ChannelChiefPortfolioItem[];
  };
  discovery: {
    total_prospect_count: number;
    available_prospect_count: number;
    accepted_prospect_count: number;
    top_priority_prospects: ChannelChiefDiscoveryItem[];
  };
  activity: {
    recent: ChannelChiefActivityItem[];
  };
  data_quality_notes: string[];
}

// Exported for unit testing (tests/channelChiefSnapshot.test.ts) -- pure,
// deterministic. Stalled-first, then longest-in-stage first, then
// recruitment_id ascending as a final tie-breaker so two recruitments with
// identical is_stalled/days_in_stage always land in the same relative order
// regardless of the DB's own (unordered) row order.
export function compareRecruitmentRank(
  a: Pick<ChannelChiefRecruitmentItem, "is_stalled" | "days_in_stage" | "recruitment_id">,
  b: Pick<ChannelChiefRecruitmentItem, "is_stalled" | "days_in_stage" | "recruitment_id">,
): number {
  if (a.is_stalled !== b.is_stalled) return a.is_stalled ? -1 : 1;
  if (a.days_in_stage !== b.days_in_stage) return b.days_in_stage - a.days_in_stage;
  return a.recruitment_id.localeCompare(b.recruitment_id);
}

// Exported for unit testing. Oldest/never-contacted first, then
// relationship_id ascending as a final tie-breaker.
export function comparePortfolioAttentionRank(
  a: Pick<ChannelChiefPortfolioItem, "last_interaction_at" | "relationship_id">,
  b: Pick<ChannelChiefPortfolioItem, "last_interaction_at" | "relationship_id">,
): number {
  const aMs = a.last_interaction_at ? new Date(a.last_interaction_at).getTime() : -Infinity;
  const bMs = b.last_interaction_at ? new Date(b.last_interaction_at).getTime() : -Infinity;
  if (aMs !== bMs) return aMs - bMs;
  return a.relationship_id.localeCompare(b.relationship_id);
}

// Global/company-wide recruitment view. DB read is SCOPED (WHERE stage IN
// active-stages, an exact precondition of isStalled) but NOT top-N-bounded:
// an accurate stalled_count and correct ranking both require evaluating
// computeDaysInStage/isStalled -- the canonical staleness rule -- against
// every active recruitment company-wide, which cannot be pre-filtered to a
// LIMIT without reimplementing that rule in SQL. The JSON response stays
// bounded to top-5 regardless. Only the columns the snapshot actually needs
// are selected.
async function getRecruitmentSnapshot(limit = RECRUITMENT_TOP_N): Promise<ChannelChiefSnapshot["recruitment"]> {
  const rows = await db
    .select({
      id: partnerRecruitmentsTable.id,
      stage: partnerRecruitmentsTable.stage,
      stageEnteredAt: partnerRecruitmentsTable.stageEnteredAt,
      nextStep: partnerRecruitmentsTable.nextStep,
      followUpDate: partnerRecruitmentsTable.followUpDate,
      companyName: companiesTable.name,
      territoryName: territoriesTable.name,
    })
    .from(partnerRecruitmentsTable)
    .innerJoin(companiesTable, eq(partnerRecruitmentsTable.companyId, companiesTable.id))
    .innerJoin(territoriesTable, eq(partnerRecruitmentsTable.territoryId, territoriesTable.id))
    .where(inArray(partnerRecruitmentsTable.stage, ACTIVE_RECRUITMENT_STAGES));

  // computeDaysInStage/isStalled evaluated exactly once per row, then reused
  // for both stalled_count and the ranking sort -- never recomputed.
  const items: ChannelChiefRecruitmentItem[] = rows.map((r) => {
    const daysInStage = computeDaysInStage(r.stageEnteredAt);
    return {
      recruitment_id: r.id,
      company_name: r.companyName,
      territory_name: r.territoryName,
      stage: r.stage,
      days_in_stage: daysInStage,
      is_stalled: isStalled(r.stage, daysInStage),
      next_step: r.nextStep,
      follow_up_date: r.followUpDate,
    };
  });

  items.sort(compareRecruitmentRank);

  return {
    active_count: items.length,
    stalled_count: items.filter((i) => i.is_stalled).length,
    top_stalled: items.slice(0, limit),
  };
}

// Global/company-wide portfolio view. active_partner_count comes from a
// cheap DB-level aggregate count. The candidate read for needs-attention is
// SCOPED (WHERE status="active" AND next_action IS NULL -- both exact,
// unambiguous preconditions isNeedingAttention itself gates on first) but
// NOT top-N-bounded: the real business rule (30-day/never-contacted
// staleness) stays entirely inside isNeedingAttention, called below against
// every row this scoped query returns -- never reimplemented in SQL.
async function getPortfolioSnapshot(limit = PORTFOLIO_TOP_N): Promise<ChannelChiefSnapshot["portfolio"]> {
  const [activeCountRows, candidates] = await Promise.all([
    db.select({ value: count() }).from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.status, "active")),
    db
      .select({
        id: partnerRelationshipsTable.id,
        status: partnerRelationshipsTable.status,
        lastInteractionAt: partnerRelationshipsTable.lastInteractionAt,
        nextAction: partnerRelationshipsTable.nextAction,
        companyName: companiesTable.name,
        territoryName: territoriesTable.name,
      })
      .from(partnerRelationshipsTable)
      .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
      .innerJoin(territoriesTable, eq(partnerRelationshipsTable.territoryId, territoriesTable.id))
      .where(and(eq(partnerRelationshipsTable.status, "active"), isNull(partnerRelationshipsTable.nextAction))),
  ]);

  const attention: ChannelChiefPortfolioItem[] = candidates
    .filter((r) => isNeedingAttention(r))
    .map((r) => ({
      relationship_id: r.id,
      company_name: r.companyName,
      territory_name: r.territoryName,
      status: r.status,
      last_interaction_at: r.lastInteractionAt ? r.lastInteractionAt.toISOString() : null,
      next_action: r.nextAction,
    }));

  attention.sort(comparePortfolioAttentionRank);

  return {
    active_partner_count: Number(activeCountRows[0]?.value ?? 0),
    needs_attention_count: attention.length,
    top_needs_attention: attention.slice(0, limit),
  };
}

// Global/company-wide Discovery view -- fully DB-bounded. Counts come from
// cheap DB-level aggregates; the top-priority list is a single query with an
// exact status filter, a deterministic ORDER BY (priority, then newest,
// then id as a final tie-breaker), and a real SQL LIMIT -- the full
// prospects table is never loaded into Node. Deliberately NOT filtered by
// assigned_user_id -- that PAM-ownership restriction
// (copilotContextService.getTopDiscoveryProspects) exists because a PAM's
// workspace only shows prospects assigned to them, matching "My Prospects".
// A leadership snapshot has no such single-owner concept.
async function getDiscoverySnapshot(limit = DISCOVERY_TOP_N): Promise<ChannelChiefSnapshot["discovery"]> {
  const [totalRows, availableRows, acceptedRows, topRows] = await Promise.all([
    db.select({ value: count() }).from(prospectsTable),
    db.select({ value: count() }).from(prospectsTable).where(eq(prospectsTable.status, "new")),
    db
      .select({ value: count() })
      .from(prospectsTable)
      .where(inArray(prospectsTable.status, ["accepted", "pushed_to_hubspot"])),
    db
      .select({
        priority: prospectsTable.priority,
        status: prospectsTable.status,
        whyItFits: prospectsTable.whyItFits,
        companyName: companiesTable.name,
        territoryName: territoriesTable.name,
      })
      .from(prospectsTable)
      .innerJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
      .innerJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id))
      .where(inArray(prospectsTable.status, ["new", "accepted"]))
      // Priority "A" sorts before "B" ascending (a direct 2-value column
      // sort, not a reimplementation of any exported business-rule
      // function -- there is no canonical comparator for this ordering to
      // reuse), then newest first, then id ascending as a final
      // tie-breaker.
      .orderBy(asc(prospectsTable.priority), desc(prospectsTable.createdAt), asc(prospectsTable.id))
      .limit(limit),
  ]);

  return {
    total_prospect_count: Number(totalRows[0]?.value ?? 0),
    available_prospect_count: Number(availableRows[0]?.value ?? 0),
    accepted_prospect_count: Number(acceptedRows[0]?.value ?? 0),
    top_priority_prospects: topRows.map((r) => ({
      company_name: r.companyName,
      territory_name: r.territoryName,
      priority: r.priority as "A" | "B",
      status: r.status,
      why_it_fits: r.whyItFits,
    })),
  };
}

// Global/company-wide activity feed -- DB-bounded via ORDER BY + LIMIT, with
// id ascending as a final deterministic tie-breaker after createdAt (Postgres
// gives no ordering guarantee among createdAt ties, and rows inserted in the
// same seed transaction can share an identical defaultNow() value). No
// canonical global-scope activity function exists yet
// (copilotContextService.getRecentActivities is always territory-scoped),
// so this is a direct, bounded, read-only query -- same convention
// copilotContextService itself uses for DB reads with no canonical service
// to call through.
async function getActivitySnapshot(limit = ACTIVITY_TOP_N): Promise<ChannelChiefSnapshot["activity"]> {
  const rows = await db
    .select({
      name: campaignsTable.name,
      type: campaignsTable.type,
      status: campaignsTable.status,
      territory: campaignsTable.territory,
      activityDate: campaignsTable.activityDate,
      mqls: campaignsTable.mqls,
      partnerReferrals: campaignsTable.partnerReferrals,
    })
    .from(campaignsTable)
    .orderBy(desc(campaignsTable.createdAt), asc(campaignsTable.id))
    .limit(limit);

  return {
    recent: rows.map((c) => ({
      name: c.name,
      type: c.type,
      status: c.status,
      territory: c.territory,
      activity_date: c.activityDate,
      mqls: c.mqls,
      partner_referrals: c.partnerReferrals,
    })),
  };
}

function buildDataQualityNotes(snapshot: Omit<ChannelChiefSnapshot, "data_quality_notes">): string[] {
  const notes: string[] = [
    "Global/company-wide KPI target fields are always null: metric_targets has no company-wide row, so the canonical Head-of-Channels KPI computation never has a target to report at this scope -- the same behavior the Head of Channels view itself shows. A separate annual target cascade exists for a narrower set of targetable metrics, but is intentionally not substituted into these figures.",
  ];
  if (snapshot.recruitment.active_count === 0) notes.push("No active recruitments across any territory.");
  if (snapshot.portfolio.active_partner_count === 0) notes.push("No active Portfolio relationships across any territory.");
  if (snapshot.discovery.total_prospect_count === 0) notes.push("No Discovery prospects have been persisted yet in any territory.");
  if (snapshot.activity.recent.length === 0) notes.push("No marketing activity logged yet.");
  return notes;
}

// The single snapshot handed to the Channel Chief API route. Every field is
// either a cheap aggregate or a bounded/scoped read (see the module header
// for exactly which); the JSON response itself is always bounded to top-N
// lists -- never a full-table dump.
export async function getChannelChiefSnapshot(periodKey: string): Promise<ChannelChiefSnapshot> {
  const periodInfo = resolvePeriodRange(periodKey);

  const [kpis, recruitment, portfolio, discovery, activity] = await Promise.all([
    buildHeadOfChannelsData(periodKey, GLOBAL_SCOPE),
    getRecruitmentSnapshot(),
    getPortfolioSnapshot(),
    getDiscoverySnapshot(),
    getActivitySnapshot(),
  ]);

  const base: Omit<ChannelChiefSnapshot, "data_quality_notes"> = {
    period: periodInfo.label,
    period_key: periodKey,
    generated_at: new Date().toISOString(),
    performance: {
      partner_development: kpis.partnerDevelopment,
      weekly_commercial: kpis.weeklyCommercial,
      weekly_marketing: kpis.weeklyMarketing,
    },
    recruitment,
    portfolio,
    discovery,
    activity,
  };

  return { ...base, data_quality_notes: buildDataQualityNotes(base) };
}
