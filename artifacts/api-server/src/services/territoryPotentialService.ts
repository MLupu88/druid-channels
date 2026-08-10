// Stage 6.5 Territory Potential: a deterministic, explainable-from-metrics
// read model over data Discovery/Recruitment/Portfolio already persist,
// plus the run-level search-productivity stats added to scan_runs this
// stage. No GDP/population/AI-invented scoring anywhere in this file --
// see the 6.5 product spec section 2.
import { db } from "@workspace/db";
import {
  prospectsTable,
  partnerRelationshipsTable,
  partnerRecruitmentsTable,
  scanRunsTable,
  scanConfigsTable,
  territoriesTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { isActiveStage, type RecruitmentStage } from "./partnerRecruitmentService";

export const SATURATION_STATES = ["unexplored", "exploring", "productive", "slowing", "saturated", "insufficient_data"] as const;
export type SaturationState = (typeof SATURATION_STATES)[number];

export const POTENTIAL_BANDS = ["low", "medium", "high", "insufficient_data"] as const;
export type PotentialBand = (typeof POTENTIAL_BANDS)[number];

// Never treat a single run's yield as saturation proof -- require this many
// of the most recent *connected* runs' yields to agree. Matches
// discoveryBudget.ts's SATURATION_BATCH_WINDOW in spirit (same "don't judge
// from one data point" principle), but at run granularity rather than
// within-run batch granularity.
const SATURATION_RUN_WINDOW = 2;
const RECENT_RUNS_CONSIDERED = 3;
const YIELD_PRODUCTIVE_THRESHOLD = 0.2;
const YIELD_STOP_THRESHOLD = 0.1;

// v1 potential-band thresholds: purely a count of this territory's OWN
// observed qualified prospects + existing partners -- never normalized
// against country size/GDP/population. A territory is allowed to have only
// a handful of strong partners and stay "low"; that's the product
// principle (equal qualification bar, unequal market opportunity), not a
// bug. Documented here, not opaque -- these are the only two numbers this
// decision uses.
//
// Stage 6.6 audit: these are v1 product heuristics, not a calibrated model
// -- recorded here explicitly as a starting point to revisit once enough
// real territory data exists to validate/tune them against. The frontend
// labels this "Observed Partner Potential" (not "Potential") specifically
// so these thresholds are never mistaken for an external market-size
// estimate (see components/territory-potential-card.tsx).
const POTENTIAL_HIGH_THRESHOLD = 30;
const POTENTIAL_MEDIUM_THRESHOLD = 10;

export interface RunProductivity {
  dataStatus: "demo" | "connected";
  queriesRun: number;
  uniqueCompaniesSeen: number;
  newCompaniesCount: number;
  duplicatesRemoved: number;
}

// Pure -- a run only counts as usable productivity evidence when it's both
// live-sourced (never demo, which is synthetic) and actually ran the
// adaptive loop (queriesRun > 0 -- a run from before this migration, or one
// that errored before any query, honestly has no productivity data).
export function isUsableProductivityRun(run: RunProductivity): boolean {
  return run.dataStatus === "connected" && run.queriesRun > 0;
}

export function computeRunYield(run: RunProductivity): number {
  const rawResultsTotal = run.uniqueCompaniesSeen + run.duplicatesRemoved;
  if (rawResultsTotal === 0) return 0;
  return run.newCompaniesCount / rawResultsTotal;
}

export function computeRunDuplicateRate(run: RunProductivity): number {
  const rawResultsTotal = run.uniqueCompaniesSeen + run.duplicatesRemoved;
  if (rawResultsTotal === 0) return 0;
  return run.duplicatesRemoved / rawResultsTotal;
}

// Pure, explainable state machine over recent-run yields. runsNewestFirst
// should already be filtered to isUsableProductivityRun rows.
export function computeSaturationState(discoveryRunsCount: number, runsNewestFirst: RunProductivity[]): SaturationState {
  if (discoveryRunsCount === 0) return "unexplored";
  if (runsNewestFirst.length === 0) return "insufficient_data";
  if (runsNewestFirst.length < SATURATION_RUN_WINDOW) return "exploring";

  const recent = runsNewestFirst.slice(0, RECENT_RUNS_CONSIDERED).map(computeRunYield);
  const lastN = recent.slice(0, SATURATION_RUN_WINDOW);

  if (lastN.every((y) => y < YIELD_STOP_THRESHOLD)) return "saturated";
  if (recent[0]! >= YIELD_PRODUCTIVE_THRESHOLD) return "productive";
  return "slowing";
}

// Pure. Purely count-based -- see the module header. discoveryRunsCount and
// existingPartnerCount together gate insufficient_data (a territory that
// has never been searched AND has no partners has nothing to judge yet).
export function computePotentialBand(
  qualifiedProspectCount: number,
  existingPartnerCount: number,
  discoveryRunsCount: number,
): PotentialBand {
  if (discoveryRunsCount === 0 && existingPartnerCount === 0) return "insufficient_data";
  const totalViable = qualifiedProspectCount + existingPartnerCount;
  if (totalViable >= POTENTIAL_HIGH_THRESHOLD) return "high";
  if (totalViable >= POTENTIAL_MEDIUM_THRESHOLD) return "medium";
  return "low";
}

// Deterministic, template-based only -- never a DeepSeek call (see 6.5 spec
// section 8: "All interpretation text must be deterministic/template-based
// in v1").
export function interpretSaturation(state: SaturationState): string {
  switch (state) {
    case "unexplored":
      return "No Discovery scan has been run yet for this territory.";
    case "exploring":
      return "Not enough discovery history yet to judge search productivity.";
    case "productive":
      return "Discovery is still producing meaningful new candidates.";
    case "slowing":
      return "Recent searches are producing fewer new candidates than before.";
    case "saturated":
      return "Recent searches are producing very few new candidates -- this territory appears close to discovery saturation.";
    case "insufficient_data":
      return "Not enough live-search history to assess discovery productivity yet.";
  }
}

export interface TerritoryPotentialSummary {
  territory_id: string;
  territory_name: string;

  discovered_company_count: number;
  qualified_prospect_count: number;
  accepted_prospect_count: number;
  available_prospect_count: number;
  existing_partner_count: number;
  active_recruitment_count: number;

  recent_new_company_count: number | null;
  recent_unique_company_count: number | null;
  duplicate_rate: number | null;
  new_candidate_yield: number | null;

  discovery_runs_count: number;
  last_discovery_at: string | null;

  saturation_state: SaturationState;
  potential_band: PotentialBand;
  saturation_interpretation: string;
}

// The only DB-touching function in this module -- everything else above is
// pure and independently unit-testable. Scoped to a single territory;
// callers (routes/authz) decide which territory(ies) a caller may request.
export async function getTerritoryPotential(territoryId: string, territoryName: string): Promise<TerritoryPotentialSummary> {
  const [prospects, activeRelationships, activeRecruitments, runRows] = await Promise.all([
    db.select().from(prospectsTable).where(eq(prospectsTable.territoryId, territoryId)),
    db
      .select()
      .from(partnerRelationshipsTable)
      .where(and(eq(partnerRelationshipsTable.territoryId, territoryId), eq(partnerRelationshipsTable.status, "active"))),
    db.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.territoryId, territoryId)),
    db
      .select({ run: scanRunsTable })
      .from(scanRunsTable)
      .innerJoin(scanConfigsTable, eq(scanRunsTable.scanConfigId, scanConfigsTable.id))
      .where(eq(scanConfigsTable.territoryId, territoryId))
      .orderBy(desc(scanRunsTable.startedAt)),
  ]);

  const discoveredCompanyIds = new Set(prospects.map((p) => p.companyId));
  const acceptedProspectCount = prospects.filter((p) => p.status === "accepted" || p.status === "pushed_to_hubspot").length;
  const availableProspectCount = prospects.filter((p) => p.status === "new").length;
  const activeRecruitmentCount = activeRecruitments.filter((r) => isActiveStage(r.stage as RecruitmentStage)).length;

  const runs = runRows.map((r) => r.run);
  const discoveryRunsCount = runs.length;
  const lastRun = runs[0] ?? null;
  const lastDiscoveryAt = lastRun ? (lastRun.completedAt ?? lastRun.startedAt).toISOString() : null;

  const usableRuns: RunProductivity[] = runs.filter(isUsableProductivityRun);
  const mostRecentUsable = usableRuns[0] ?? null;

  const saturationState = computeSaturationState(discoveryRunsCount, usableRuns);
  const potentialBand = computePotentialBand(prospects.length, activeRelationships.length, discoveryRunsCount);

  return {
    territory_id: territoryId,
    territory_name: territoryName,
    discovered_company_count: discoveredCompanyIds.size,
    qualified_prospect_count: prospects.length,
    accepted_prospect_count: acceptedProspectCount,
    available_prospect_count: availableProspectCount,
    existing_partner_count: activeRelationships.length,
    active_recruitment_count: activeRecruitmentCount,
    recent_new_company_count: mostRecentUsable ? mostRecentUsable.newCompaniesCount : null,
    recent_unique_company_count: mostRecentUsable ? mostRecentUsable.uniqueCompaniesSeen : null,
    duplicate_rate: mostRecentUsable ? computeRunDuplicateRate(mostRecentUsable) : null,
    new_candidate_yield: mostRecentUsable ? computeRunYield(mostRecentUsable) : null,
    discovery_runs_count: discoveryRunsCount,
    last_discovery_at: lastDiscoveryAt,
    saturation_state: saturationState,
    potential_band: potentialBand,
    saturation_interpretation: interpretSaturation(saturationState),
  };
}

// Head/Admin multi-territory view. Scoped to canonically-owned territories
// only -- same convention as targetService.getTeamTargets (a territory with
// no owner_user_id has no accountable PAM and isn't a meaningful Territory
// Potential subject).
export async function getTerritoryPotentialForAll(): Promise<TerritoryPotentialSummary[]> {
  const allTerritories = await db.select().from(territoriesTable);
  const owned = allTerritories.filter((t) => t.ownerUserId !== null);
  return Promise.all(owned.map((t) => getTerritoryPotential(t.id, t.name)));
}
