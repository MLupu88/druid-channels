// Phase 3A/3B: READ-ONLY production duplicate + integrity audit, run before
// the Phase 3B unique-index migration. Reports:
//   1. canonical-domain GROUPS with more than one company row (Phase 3A)
//   2. NON_CANONICAL_ROWS -- any non-null companies.domain whose stored
//      value isn't already the canonical registrable domain (Phase 3B)
//   3. active-prospect CONFLICTS -- any (company_id, territory_id) pair
//      with more than one non-rejected prospect (Phase 3B)
//
// This script NEVER writes, updates, or deletes anything -- every query
// below is a SELECT. It does not call Tavily, DeepSeek, HubSpot, or any
// other live provider. It is not run automatically by anything; run it
// yourself, manually, from a terminal, against whichever DATABASE_URL is
// exported in that shell:
//
//   pnpm --filter @workspace/api-server exec tsx src/scripts/auditCompanyDuplicates.ts
//
// or, from inside artifacts/api-server:
//
//   pnpm exec tsx src/scripts/auditCompanyDuplicates.ts
import { db, pool } from "@workspace/db";
import {
  companiesTable,
  prospectsTable,
  territoriesTable,
  partnerRecruitmentsTable,
  partnerRelationshipsTable,
  signalsTable,
  prospectActivityTable,
  campaignsTable,
  partnerResearchItemsTable,
  rfpsTable,
  partnerEventsTable,
  channelRadarSignalsTable,
  portfolioImportRowsTable,
  type Company,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  groupCompaniesByCanonicalDomain,
  classifyDuplicateGroup,
  findNonCanonicalRows,
  findActiveProspectConflicts,
  type DuplicateGroupMember,
} from "../services/companyDuplicateAudit";

async function countWhere(table: any, column: any, value: string): Promise<number> {
  const rows = await db.select({ id: table.id }).from(table).where(eq(column, value));
  return rows.length;
}

// Shared per-company detail block -- used both for duplicate-group members
// and standalone non-canonical rows, so the two report sections show
// exactly the same evidence/lifecycle facts in the same shape.
async function printCompanyDetail(company: Company, territoryNameById: Map<string, string>): Promise<DuplicateGroupMember> {
  const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, company.id));
  const recruitmentCount = await countWhere(partnerRecruitmentsTable, partnerRecruitmentsTable.companyId, company.id);
  const relationships = await db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.companyId, company.id));
  const signalCount = await countWhere(signalsTable, signalsTable.companyId, company.id);

  const prospectIds = prospects.map((p) => p.id);
  const activityCount =
    prospectIds.length > 0
      ? (await db.select({ id: prospectActivityTable.id }).from(prospectActivityTable).where(inArray(prospectActivityTable.prospectId, prospectIds))).length
      : 0;

  const otherReferenceCounts = {
    campaigns: await countWhere(campaignsTable, campaignsTable.partnerCompanyId, company.id),
    partner_research_items: await countWhere(partnerResearchItemsTable, partnerResearchItemsTable.companyId, company.id),
    rfps: await countWhere(rfpsTable, rfpsTable.companyId, company.id),
    partner_events: await countWhere(partnerEventsTable, partnerEventsTable.companyId, company.id),
    channel_radar_signals: await countWhere(channelRadarSignalsTable, channelRadarSignalsTable.companyId, company.id),
    portfolio_import_rows: await countWhere(portfolioImportRowsTable, portfolioImportRowsTable.matchedCompanyId, company.id),
  };

  console.log(`\n  Company ${company.id}`);
  console.log(`    name: ${company.name}`);
  console.log(`    domain (as currently stored): ${company.domain ?? "(none)"}`);
  console.log(`    country: ${company.country}`);
  console.log(`    created_at: ${company.createdAt.toISOString()}`);
  console.log(`    prospects: ${prospects.length}`);
  for (const p of prospects) {
    console.log(`      - territory=${territoryNameById.get(p.territoryId) ?? p.territoryId} status=${p.status} prospect_id=${p.id}`);
  }
  console.log(`    partner_recruitments references: ${recruitmentCount}`);
  console.log(`    partner_relationships (Portfolio): ${relationships.length}`);
  for (const r of relationships) {
    console.log(`      - territory=${territoryNameById.get(r.territoryId) ?? r.territoryId} status=${r.status} relationship_id=${r.id}`);
  }
  console.log(`    signals (evidence): ${signalCount}`);
  console.log(`    prospect_activity (history entries across its prospects): ${activityCount}`);
  console.log(`    other table references: ${JSON.stringify(otherReferenceCounts)}`);

  return {
    companyId: company.id,
    prospectTerritoryStatuses: prospects.map((p) => ({ territoryId: p.territoryId, status: p.status })),
    portfolioTerritoryIds: relationships.map((r) => r.territoryId),
    hasRecruitmentReference: recruitmentCount > 0,
  };
}

async function main(): Promise<void> {
  console.log("READ-ONLY report -- nothing below was or will be modified.\n");

  const companies = await db.select().from(companiesTable);
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const territories = await db.select().from(territoriesTable);
  const territoryNameById = new Map(territories.map((t) => [t.id, t.name]));

  // ---- 1. Canonical-domain duplicate GROUPS (Phase 3A) ----------------------

  const groups = groupCompaniesByCanonicalDomain(companies.map((c) => ({ id: c.id, domain: c.domain })));
  const groupSummary: Array<{ canonicalDomain: string; rowCount: number; classification: string }> = [];

  if (groups.size === 0) {
    console.log("===== Duplicate canonical-domain groups: none found =====\n");
  } else {
    console.log(`===== Duplicate canonical-domain groups: ${groups.size} found =====`);
    let groupIndex = 0;
    for (const [canonicalDomain, companyIds] of groups) {
      groupIndex++;
      console.log(`\n--- Group ${groupIndex}: ${canonicalDomain} (${companyIds.length} company rows) ---`);

      const members: DuplicateGroupMember[] = [];
      for (const companyId of companyIds) {
        members.push(await printCompanyDetail(companyById.get(companyId)!, territoryNameById));
      }

      const classification = classifyDuplicateGroup(members);
      groupSummary.push({ canonicalDomain, rowCount: companyIds.length, classification });

      console.log(`\n  Classification: ${classification.toUpperCase()}`);
      if (classification === "risky") {
        console.log(
          "  Reason: more than 2 rows, a Recruitment reference, or a same-territory conflict (two active prospects, or two Portfolio " +
            "relationships, in the same territory) between rows in this group -- resolve manually, do not merge mechanically.",
        );
      } else {
        console.log(
          "  Reason: no same-territory active-prospect/Portfolio conflict and no Recruitment reference was found between these rows. " +
            "This is a lower-risk starting point, NOT a merge authorization -- this tool never merges anything itself.",
        );
      }
    }
    console.log("");
  }

  // ---- 2. NON_CANONICAL_ROWS (Phase 3B) --------------------------------------
  //
  // These do not block CREATE UNIQUE INDEX (it only rejects byte-identical
  // stored strings, and none of these are duplicates of anything by
  // definition of this check) -- they're reported because a non-canonical
  // stored value is latent risk for the future: a canonical write for the
  // same real company would produce a different string and the index would
  // never catch that collision. Consider normalizing them by hand,
  // independent of and not required by the Phase 3B migration.

  const nonCanonicalRows = findNonCanonicalRows(companies.map((c) => ({ id: c.id, domain: c.domain })));

  if (nonCanonicalRows.length === 0) {
    console.log("===== Non-canonical stored domains: none found -- every non-null companies.domain is already canonical =====\n");
  } else {
    console.log(`===== Non-canonical stored domains: ${nonCanonicalRows.length} found =====`);
    for (const row of nonCanonicalRows) {
      const company = companyById.get(row.companyId)!;
      console.log(`\n  stored: "${row.storedDomain}"  ->  canonical: ${row.canonicalDomain ?? "(unparseable -- cannot be canonicalized at all)"}`);
      await printCompanyDetail(company, territoryNameById);
    }
    console.log("");
  }

  // ---- 3. Active-prospect CONFLICTS (Phase 3B) -------------------------------
  //
  // Direct check for invariant B, independent of domain duplication -- any
  // (company_id, territory_id) pair with more than one non-rejected
  // prospect today would make `CREATE UNIQUE INDEX ... WHERE status <>
  // 'rejected'` fail outright. Checked here so that failure is never a
  // surprise from raw Postgres error text.

  const allProspects = await db.select().from(prospectsTable);
  const conflicts = findActiveProspectConflicts(
    allProspects.map((p) => ({ id: p.id, companyId: p.companyId, territoryId: p.territoryId, status: p.status })),
  );

  if (conflicts.length === 0) {
    console.log("===== Active-prospect (company_id, territory_id) conflicts: none found =====\n");
  } else {
    console.log(`===== Active-prospect (company_id, territory_id) conflicts: ${conflicts.length} found -- THESE WILL BLOCK THE PHASE 3B PROSPECT INDEX =====`);
    for (const conflict of conflicts) {
      const company = companyById.get(conflict.companyId);
      console.log(
        `\n  company=${conflict.companyId} (${company?.name ?? "unknown"}) territory=${territoryNameById.get(conflict.territoryId) ?? conflict.territoryId}`,
      );
      console.log(`    conflicting prospect ids: ${conflict.prospectIds.join(", ")}`);
    }
    console.log("");
  }

  // ---- Final summary ----------------------------------------------------------

  console.log("===== Final summary =====");
  console.log(`  Duplicate canonical-domain groups: ${groups.size}`);
  for (const s of groupSummary) {
    console.log(`    - ${s.canonicalDomain}: ${s.rowCount} rows, ${s.classification}`);
  }
  console.log(`  Non-canonical stored-domain rows: ${nonCanonicalRows.length}`);
  console.log(`  Active-prospect (company_id, territory_id) conflicts: ${conflicts.length}`);
  console.log(
    conflicts.length === 0
      ? "\nThe Phase 3B prospect uniqueness index has no known blocker. The company-domain index has no known blocker either (no exact-string duplicates)."
      : "\nThe Phase 3B prospect uniqueness index WILL FAIL to create until the conflicts above are resolved (see Task 4/8 of the Phase 3B report for what 'resolved' means -- this tool never resolves them for you).",
  );
  console.log("\nDone. No data was modified.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
