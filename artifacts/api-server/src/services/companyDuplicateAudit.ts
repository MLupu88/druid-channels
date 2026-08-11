// Phase 3A: pure, DB-free logic backing the read-only production duplicate
// audit script (src/scripts/auditCompanyDuplicates.ts). Kept separate from
// the script itself so the grouping/classification decisions are directly
// unit-testable without a DB connection -- the script is a thin orchestrator
// that fetches rows and calls these functions.
import { toRegistrableDomain } from "./companyIdentity";

// Groups company ids by canonical registrable domain. Companies with no
// domain, or a domain that can't safely resolve to one (see
// companyIdentity.ts), are never grouped -- there's nothing deterministic to
// group them by. Only groups with more than one company are returned; a
// canonical domain with exactly one company isn't a duplicate.
export function groupCompaniesByCanonicalDomain(
  companies: ReadonlyArray<{ id: string; domain: string | null }>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const company of companies) {
    const canonical = toRegistrableDomain(company.domain);
    if (!canonical) continue;
    const ids = groups.get(canonical);
    if (ids) ids.push(company.id);
    else groups.set(canonical, [company.id]);
  }
  for (const [key, ids] of groups) {
    if (ids.length < 2) groups.delete(key);
  }
  return groups;
}

export interface DuplicateGroupMember {
  companyId: string;
  // One entry per prospect row this company has, across all territories.
  prospectTerritoryStatuses: ReadonlyArray<{ territoryId: string; status: string }>;
  // Territories where this company already has a partner_relationships
  // (Portfolio) row.
  portfolioTerritoryIds: ReadonlyArray<string>;
  hasRecruitmentReference: boolean;
}

export type DuplicateGroupClassification = "simple" | "risky";

// Deterministic only -- never a guess. A group is "risky" (needs a human to
// decide how to merge, if at all) whenever merging it naively would either
// destroy information or create an ambiguous "which row wins" situation:
//
// - more than 2 rows in the group (wider blast radius than a pairwise
//   duplicate -- always reviewed by hand)
// - any row has ever been through Recruitment (high-stakes history; never
//   auto-classified)
// - two or more rows each have a non-rejected prospect in the SAME
//   territory (merging would have to pick a survivor and orphan the other's
//   activity trail)
// - two or more rows each have a Portfolio relationship in the SAME
//   territory (the unique (company, territory) constraint on
//   partner_relationships would reject a naive merge outright, and picking
//   a survivor is a real product decision, not a mechanical one)
//
// A group is "simple" only when none of the above applies -- e.g. one row
// carries all the real lifecycle data and the other(s) are empty
// Discovery-only shells, or the group's active territories don't overlap at
// all. "Simple" is a signal for where to look first, never a merge
// authorization -- this tool never merges anything itself.
export function classifyDuplicateGroup(members: ReadonlyArray<DuplicateGroupMember>): DuplicateGroupClassification {
  if (members.length > 2) return "risky";
  if (members.some((m) => m.hasRecruitmentReference)) return "risky";

  const activeProspectTerritoryCounts = new Map<string, number>();
  for (const member of members) {
    const activeTerritories = new Set(
      member.prospectTerritoryStatuses.filter((p) => p.status !== "rejected").map((p) => p.territoryId),
    );
    for (const territoryId of activeTerritories) {
      activeProspectTerritoryCounts.set(territoryId, (activeProspectTerritoryCounts.get(territoryId) ?? 0) + 1);
    }
  }
  if ([...activeProspectTerritoryCounts.values()].some((count) => count > 1)) return "risky";

  const portfolioTerritoryCounts = new Map<string, number>();
  for (const member of members) {
    for (const territoryId of new Set(member.portfolioTerritoryIds)) {
      portfolioTerritoryCounts.set(territoryId, (portfolioTerritoryCounts.get(territoryId) ?? 0) + 1);
    }
  }
  if ([...portfolioTerritoryCounts.values()].some((count) => count > 1)) return "risky";

  return "simple";
}
