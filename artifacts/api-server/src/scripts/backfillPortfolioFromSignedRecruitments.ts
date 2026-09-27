// Canonical Portfolio Truth: ONE-TIME backfill for recruitments that reached
// "signed" without a matching Portfolio relationship (e.g. signed before the
// Signed transition reconciled Portfolio, or data loaded directly). Finds
// every recruitment whose CURRENT stage is "signed", groups them by
// (company_id, territory_id), and runs the exact same
// reconcilePortfolioRelationshipForSignedRecruitment the live Signed
// transition uses (services/partnerRelationshipService.ts) -- never a
// second copy of the logic:
//
//   - no relationship yet        -> create active, origin_type=recruitment
//   - relationship is needs_review -> promote to active (provenance kept)
//   - relationship active/dormant/closed -> status untouched, signed event only
//
// Only signed recruitments are candidates. accepted/contacting/engaged/
// agreement are recruitment PIPELINE and are reported as ignored, never
// reconciled. Legacy prospects.status (accepted/pushed_to_hubspot) is never
// read at all -- it is not partner truth.
//
// Read-only by default (dry run): reports the plan and exits without
// writing anything. Pass --apply to actually write. Idempotent: re-running
// (with or without --apply) after a partial or full previous run is safe.
//
// Not run automatically by anything -- run it yourself, manually, against
// whichever DATABASE_URL is exported in that shell:
//
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillPortfolioFromSignedRecruitments.ts            # dry run (default)
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfillPortfolioFromSignedRecruitments.ts --apply    # writes
import { fileURLToPath } from "node:url";
import { inArray } from "drizzle-orm";
import { db, pool, partnerRecruitmentsTable, companiesTable, territoriesTable, type PartnerRecruitment } from "@workspace/db";
import {
  planSignedRecruitmentReconciliation,
  reconcilePortfolioRelationshipForSignedRecruitment,
} from "../services/partnerRelationshipService";

type RecruitmentRow = Pick<PartnerRecruitment, "id" | "companyId" | "territoryId" | "assignedUserId" | "stage" | "signedAt" | "createdAt">;

export interface SignedRecruitmentGroup {
  companyId: string;
  territoryId: string;
  // The recruitment reconciled for this pair: earliest signed_at (missing
  // signed_at sorts last), then earliest created_at, then id -- deterministic.
  canonical: RecruitmentRow;
  // Other signed recruitments for the same pair -- reported, not reconciled
  // (one relationship per pair; the canonical one already confirms it).
  duplicates: RecruitmentRow[];
}

// Pure, exported for unit testing. Callers must pass only signed rows.
export function groupSignedRecruitmentsByCompanyTerritory(rows: RecruitmentRow[]): SignedRecruitmentGroup[] {
  const sorted = [...rows].sort((a, b) => {
    const aSigned = a.signedAt ? a.signedAt.getTime() : Number.POSITIVE_INFINITY;
    const bSigned = b.signedAt ? b.signedAt.getTime() : Number.POSITIVE_INFINITY;
    if (aSigned !== bSigned) return aSigned - bSigned;
    if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt.getTime() - b.createdAt.getTime();
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const byKey = new Map<string, SignedRecruitmentGroup>();
  for (const row of sorted) {
    const key = `${row.companyId}::${row.territoryId}`;
    const existing = byKey.get(key);
    if (existing) existing.duplicates.push(row);
    else byKey.set(key, { companyId: row.companyId, territoryId: row.territoryId, canonical: row, duplicates: [] });
  }
  return [...byKey.values()];
}

export interface SignedBackfillCounts {
  recruitments_scanned: number;
  ignored_not_signed: number;
  signed_recruitments: number;
  candidates: number; // distinct (company, territory) pairs with a signed recruitment
  duplicate_signed_skipped: number;
  create: number;
  promote_needs_review: number;
  reuse_existing: number;
  signed_events: number;
  unresolved_assignment: number;
  signed_at_missing: number;
  errors: number;
}

export interface SignedBackfillOptions {
  apply: boolean;
  // Restricts the scan to these companies. Used by tests so a run against a
  // shared disposable DB never touches other fixtures; the CLI never sets it.
  onlyCompanyIds?: string[];
  log?: (line: string) => void;
}

export async function runSignedRecruitmentBackfill(opts: SignedBackfillOptions): Promise<SignedBackfillCounts> {
  const log = opts.log ?? (() => {});

  const rows = await db
    .select({
      id: partnerRecruitmentsTable.id,
      companyId: partnerRecruitmentsTable.companyId,
      territoryId: partnerRecruitmentsTable.territoryId,
      assignedUserId: partnerRecruitmentsTable.assignedUserId,
      stage: partnerRecruitmentsTable.stage,
      signedAt: partnerRecruitmentsTable.signedAt,
      createdAt: partnerRecruitmentsTable.createdAt,
    })
    .from(partnerRecruitmentsTable)
    .where(opts.onlyCompanyIds ? inArray(partnerRecruitmentsTable.companyId, opts.onlyCompanyIds) : undefined);

  const signed = rows.filter((r) => r.stage === "signed");
  const ignoredByStage = new Map<string, number>();
  for (const r of rows) if (r.stage !== "signed") ignoredByStage.set(r.stage, (ignoredByStage.get(r.stage) ?? 0) + 1);

  const groups = groupSignedRecruitmentsByCompanyTerritory(signed);

  const counts: SignedBackfillCounts = {
    recruitments_scanned: rows.length,
    ignored_not_signed: rows.length - signed.length,
    signed_recruitments: signed.length,
    candidates: groups.length,
    duplicate_signed_skipped: 0,
    create: 0,
    promote_needs_review: 0,
    reuse_existing: 0,
    signed_events: 0,
    unresolved_assignment: 0,
    signed_at_missing: 0,
    errors: 0,
  };

  const [companies, territories] = await Promise.all([db.select().from(companiesTable), db.select().from(territoriesTable)]);
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
  const territoryNameById = new Map(territories.map((t) => [t.id, t.name]));

  log(`===== ${rows.length} recruitment(s) scanned; ${signed.length} currently signed; ${counts.ignored_not_signed} ignored (not signed) =====`);
  for (const [stage, n] of ignoredByStage) log(`  ignored stage=${stage}: ${n} (recruitment pipeline, not a partner)`);
  log(`===== ${groups.length} distinct (company, territory) pair(s) with a signed recruitment =====\n`);

  for (const group of groups) {
    const label = `${companyNameById.get(group.companyId) ?? group.companyId} / ${territoryNameById.get(group.territoryId) ?? group.territoryId}`;
    const r = group.canonical;
    if (!r.signedAt) counts.signed_at_missing++;
    for (const dup of group.duplicates) {
      counts.duplicate_signed_skipped++;
      log(`  [duplicate_signed_skipped] ${label} -- recruitment ${dup.id} (pair reconciled via ${r.id})`);
    }

    try {
      if (!opts.apply) {
        const plan = await planSignedRecruitmentReconciliation(r);
        if (plan.needsSignedEvent) counts.signed_events++;
        if (plan.action === "create") {
          counts.create++;
          if (!plan.resolvedAssignedUserId) counts.unresolved_assignment++;
          log(`  [would_create] ${label} -- recruitment ${r.id}, status=active, origin=recruitment, assigned_user_id=${plan.resolvedAssignedUserId ?? "(none -- unresolved)"}${r.signedAt ? "" : ", started_at unknown (signed_at missing)"}`);
        } else if (plan.action === "promote") {
          counts.promote_needs_review++;
          if (!plan.existing!.assignedUserId) counts.unresolved_assignment++;
          log(`  [would_promote] ${label} -- relationship ${plan.existing!.id} needs_review -> active (origin=${plan.existing!.originType} kept)`);
        } else {
          counts.reuse_existing++;
          log(`  [reuse_existing] ${label} -- relationship ${plan.existing!.id} status=${plan.existing!.status} left untouched${plan.needsSignedEvent ? ", would record recruitment_signed" : ""}`);
        }
        continue;
      }

      const result = await reconcilePortfolioRelationshipForSignedRecruitment(r, null);
      if (result.signedEventRecorded) counts.signed_events++;
      if (result.action === "created") {
        counts.create++;
        if (!result.resolvedAssignedUserId) counts.unresolved_assignment++;
        log(`  [created] ${label} -- relationship ${result.relationship.id}, status=active, assigned_user_id=${result.resolvedAssignedUserId ?? "(none -- unresolved)"}`);
      } else if (result.action === "promoted") {
        counts.promote_needs_review++;
        if (!result.relationship.assignedUserId) counts.unresolved_assignment++;
        log(`  [promoted] ${label} -- relationship ${result.relationship.id} needs_review -> active (origin=${result.relationship.originType} kept)`);
      } else {
        counts.reuse_existing++;
        log(`  [reuse_existing] ${label} -- relationship ${result.relationship.id} status=${result.relationship.status} left untouched${result.signedEventRecorded ? ", recorded recruitment_signed" : ""}`);
      }
    } catch (err) {
      counts.errors++;
      log(`  [error] ${label} -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return counts;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY mode -- Portfolio relationships will be created/confirmed.\n" : "DRY RUN -- nothing will be written. Pass --apply to write.\n");

  const counts = await runSignedRecruitmentBackfill({ apply, log: (line) => console.log(line) });

  const verb = (dry: string, done: string) => (apply ? done : dry);
  console.log("\n===== Summary =====");
  console.log(`  recruitments_scanned:      ${counts.recruitments_scanned}`);
  console.log(`  ignored_not_signed:        ${counts.ignored_not_signed}`);
  console.log(`  signed_recruitments:       ${counts.signed_recruitments}`);
  console.log(`  candidates (pairs):        ${counts.candidates}`);
  console.log(`  duplicate_signed_skipped:  ${counts.duplicate_signed_skipped}`);
  console.log(`  ${verb("would_create", "created")}:              ${counts.create}`);
  console.log(`  ${verb("would_promote", "promoted")} (needs_review): ${counts.promote_needs_review}`);
  console.log(`  reuse_existing:            ${counts.reuse_existing}`);
  console.log(`  recruitment_signed events: ${counts.signed_events}`);
  console.log(`  unresolved_assignment:     ${counts.unresolved_assignment}`);
  console.log(`  signed_at_missing:         ${counts.signed_at_missing}`);
  console.log(`  errors:                    ${counts.errors}`);
  console.log(apply ? "\nDone." : "\nDry run complete. No data was modified. Re-run with --apply to write.");
  if (counts.errors > 0) process.exitCode = 1;
}

// ESM entrypoint guard -- same pattern as backfillPortfolioFromOpportunities.ts:
// only run (and close the shared pool) when executed directly, never when
// imported by a test.
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
