// Phase 12 Portfolio Reconciliation: ONE-TIME backfill for opportunities
// that were imported/created before this reconciliation existed (see
// reconcilePortfolioRelationshipForOpportunity in
// services/partnerRelationshipService.ts, now called automatically by
// every new opportunity creation -- routes/opportunities.ts's
// applyOpportunityCreate). This script finds every distinct
// (company_id, territory_id) pair referenced by an existing
// partner_opportunities row that has no Portfolio relationship yet, and
// creates the same safe, neutral "needs_review" relationship the live path
// creates -- reusing that exact function, never a second copy of the logic.
//
// Read-only by default (dry run): reports counts and exits without writing
// anything. Pass --apply to actually create the missing relationships.
//
// Never creates duplicates and never touches an existing relationship's
// fields -- reconcilePortfolioRelationshipForOpportunity is idempotent via
// createRelationshipIfMissing's own (company_id, territory_id)
// onConflictDoNothing, so re-running this script (with or without --apply)
// after a partial or full previous run is always safe.
//
// This is NOT run automatically by anything (no scheduler, no startup
// hook) -- run it yourself, manually, from a terminal, against whichever
// DATABASE_URL is exported in that shell:
//
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillPortfolioFromOpportunities.ts            # dry run (default)
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillPortfolioFromOpportunities.ts --apply    # actually creates relationships
//
// or, from inside artifacts/api-server:
//
//   pnpm exec tsx src/scripts/backfillPortfolioFromOpportunities.ts
//   pnpm exec tsx src/scripts/backfillPortfolioFromOpportunities.ts --apply
import { fileURLToPath } from "node:url";
import { inArray } from "drizzle-orm";
import { db, pool, partnerOpportunitiesTable, companiesTable, territoriesTable } from "@workspace/db";
import { reconcilePortfolioRelationshipForOpportunity, findRelationshipByCompanyAndTerritory, resolveRelationshipAssigneeForOpportunity } from "../services/partnerRelationshipService";

interface CandidatePair {
  companyId: string;
  territoryId: string;
  // Distinct assigned_user_ids seen in this (company, territory) group,
  // oldest opportunity first. Only element [0] -- the canonical (oldest)
  // opportunity's assignee -- is ever used for PAM assignment (see
  // canonicalOpportunityAssignee below); the rest are informational.
  opportunityAssignedUserIds: string[];
}

// Exported for unit testing -- pure grouping, no DB. Distinct
// (company_id, territory_id) pairs referenced by any opportunity row, each
// carrying every assigned_user_id seen for that pair (oldest opportunity
// first). Ordered by created_at, then opportunity id as a deterministic
// tie-breaker, so the canonical (first) opportunity -- and therefore the
// only assignee ever used -- never depends on database return order.
export function groupOpportunitiesByCompanyTerritory(
  rows: { id: string; companyId: string; territoryId: string; assignedUserId: string; createdAt: Date }[],
): CandidatePair[] {
  const sorted = [...rows].sort((a, b) => {
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const byKey = new Map<string, CandidatePair>();
  for (const row of sorted) {
    const key = `${row.companyId}::${row.territoryId}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.opportunityAssignedUserIds.includes(row.assignedUserId)) existing.opportunityAssignedUserIds.push(row.assignedUserId);
    } else {
      byKey.set(key, { companyId: row.companyId, territoryId: row.territoryId, opportunityAssignedUserIds: [row.assignedUserId] });
    }
  }
  return [...byKey.values()];
}

export interface BackfillCounts {
  candidates: number;
  already_in_portfolio: number;
  created: number;
  unresolved_pam: number;
  errors: number;
}

// The one assignee both dry run and --apply use for a pair: the canonical
// (oldest) opportunity's assigned_user_id -- exactly what
// reconcilePortfolioRelationshipForOpportunity receives on apply. Never
// searches later opportunities for a "better" PAM: if the canonical
// assignee isn't an active PAM owning this territory, the relationship is
// created unassigned (unresolved_pam), in the dry-run report and in
// reality alike.
export function canonicalOpportunityAssignee(pair: CandidatePair): string {
  return pair.opportunityAssignedUserIds[0]!;
}

export interface OpportunityBackfillOptions {
  apply: boolean;
  // Restricts the scan to these companies. Used by tests so a run against a
  // shared disposable DB never touches other fixtures; the CLI never sets it.
  onlyCompanyIds?: string[];
  log?: (line: string) => void;
}

export async function runOpportunityBackfill(opts: OpportunityBackfillOptions): Promise<BackfillCounts> {
  const { apply } = opts;
  const log = opts.log ?? (() => {});

  const opportunityRows = await db
    .select({
      id: partnerOpportunitiesTable.id,
      companyId: partnerOpportunitiesTable.companyId,
      territoryId: partnerOpportunitiesTable.territoryId,
      assignedUserId: partnerOpportunitiesTable.assignedUserId,
      createdAt: partnerOpportunitiesTable.createdAt,
    })
    .from(partnerOpportunitiesTable)
    .where(opts.onlyCompanyIds ? inArray(partnerOpportunitiesTable.companyId, opts.onlyCompanyIds) : undefined);

  const pairs = groupOpportunitiesByCompanyTerritory(opportunityRows);

  const [companies, territories] = await Promise.all([db.select().from(companiesTable), db.select().from(territoriesTable)]);
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
  const territoryNameById = new Map(territories.map((t) => [t.id, t.name]));

  const counts: BackfillCounts = { candidates: pairs.length, already_in_portfolio: 0, created: 0, unresolved_pam: 0, errors: 0 };

  log(`===== ${pairs.length} distinct (company, territory) pair(s) referenced by existing opportunities =====\n`);

  for (const pair of pairs) {
    const label = `${companyNameById.get(pair.companyId) ?? pair.companyId} / ${territoryNameById.get(pair.territoryId) ?? pair.territoryId}`;
    const assignee = canonicalOpportunityAssignee(pair);
    try {
      const existing = await findRelationshipByCompanyAndTerritory(pair.companyId, pair.territoryId);
      if (existing) {
        counts.already_in_portfolio++;
        log(`  [already_in_portfolio] ${label} -- existing relationship ${existing.id} (status=${existing.status}), left untouched`);
        continue;
      }

      if (!apply) {
        const resolved = await resolveRelationshipAssigneeForOpportunity(assignee, pair.territoryId);
        if (!resolved) counts.unresolved_pam++;
        counts.created++; // "would create" in dry-run terms
        log(`  [would_create] ${label} -- status=needs_review, assigned_user_id=${resolved ?? "(none -- unresolved_pam)"}`);
        continue;
      }

      const result = await reconcilePortfolioRelationshipForOpportunity(
        { companyId: pair.companyId, territoryId: pair.territoryId, opportunityAssignedUserId: assignee },
        null,
      );
      if (!result.created) {
        // Only possible if a concurrent writer created the relationship
        // between our existence check above and this call -- still safe,
        // just recount it correctly rather than double-counting "created".
        counts.already_in_portfolio++;
        log(`  [already_in_portfolio] ${label} -- created concurrently as ${result.relationship.id}`);
        continue;
      }
      counts.created++;
      if (!result.resolvedAssignedUserId) counts.unresolved_pam++;
      log(`  [created] ${label} -- relationship ${result.relationship.id}, status=needs_review, assigned_user_id=${result.resolvedAssignedUserId ?? "(none -- unresolved_pam)"}`);
    } catch (err) {
      counts.errors++;
      log(`  [error] ${label} -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return counts;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY mode -- missing Portfolio relationships will be created.\n" : "DRY RUN -- nothing will be written. Pass --apply to actually create relationships.\n");

  const counts = await runOpportunityBackfill({ apply, log: (line) => console.log(line) });

  console.log("\n===== Summary =====");
  console.log(`  candidates:           ${counts.candidates}`);
  console.log(`  already_in_portfolio: ${counts.already_in_portfolio}`);
  console.log(`  ${apply ? "created" : "would_create"}:              ${counts.created}`);
  console.log(`  unresolved_pam:       ${counts.unresolved_pam}`);
  console.log(`  errors:               ${counts.errors}`);
  console.log(apply ? "\nDone." : "\nDry run complete. No data was modified. Re-run with --apply to create the missing relationships.");
  // Per-pair errors never abort the scan (every pair is still attempted),
  // but a run with any error must still exit non-zero -- same as
  // backfillPortfolioFromSignedRecruitments.ts.
  if (counts.errors > 0) process.exitCode = 1;
}

// ESM entrypoint guard: only run (and close the shared @workspace/db pool)
// when this file is executed directly as a script -- never as a side
// effect of another module importing groupOpportunitiesByCompanyTerritory
// (see tests/portfolioOpportunityReconciliation.test.ts, which does exactly
// that for pure unit testing). require.main doesn't exist under this
// package's ESM ("type": "module") setup, so this compares process.argv[1]
// (the path Node/tsx was actually invoked with) against this module's own
// resolved path -- true only when someone runs
// `tsx src/scripts/backfillPortfolioFromOpportunities.ts` directly, false
// when the test runner's entry file is doing the importing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
