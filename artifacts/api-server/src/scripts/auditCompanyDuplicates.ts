// Phase 3A: READ-ONLY production duplicate audit. Groups existing companies
// that collapse to the same canonical registrable domain (see
// services/companyIdentity.ts) and reports everything relevant to deciding
// whether/how to merge them by hand in Phase 3B.
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
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { groupCompaniesByCanonicalDomain, classifyDuplicateGroup, type DuplicateGroupMember } from "../services/companyDuplicateAudit";

async function countWhere(table: any, column: any, value: string): Promise<number> {
  const rows = await db.select({ id: table.id }).from(table).where(eq(column, value));
  return rows.length;
}

async function main(): Promise<void> {
  const companies = await db.select().from(companiesTable);
  const companyById = new Map(companies.map((c) => [c.id, c]));

  const groups = groupCompaniesByCanonicalDomain(companies.map((c) => ({ id: c.id, domain: c.domain })));

  if (groups.size === 0) {
    console.log("No duplicate company groups found (by canonical registrable domain). Nothing to review.");
    return;
  }

  const territories = await db.select().from(territoriesTable);
  const territoryNameById = new Map(territories.map((t) => [t.id, t.name]));

  console.log(`Found ${groups.size} canonical-domain group(s) with more than one company row.`);
  console.log("This is a READ-ONLY report -- nothing below was modified. Review each group manually before any Phase 3B merge.\n");

  let groupIndex = 0;
  const summary: Array<{ canonicalDomain: string; rowCount: number; classification: string }> = [];

  for (const [canonicalDomain, companyIds] of groups) {
    groupIndex++;
    console.log(`===== Group ${groupIndex}: ${canonicalDomain} (${companyIds.length} company rows) =====`);

    const members: DuplicateGroupMember[] = [];

    for (const companyId of companyIds) {
      const company = companyById.get(companyId)!;

      const prospects = await db.select().from(prospectsTable).where(eq(prospectsTable.companyId, companyId));
      const recruitmentCount = await countWhere(partnerRecruitmentsTable, partnerRecruitmentsTable.companyId, companyId);
      const relationships = await db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.companyId, companyId));
      const signalCount = await countWhere(signalsTable, signalsTable.companyId, companyId);

      const prospectIds = prospects.map((p) => p.id);
      const activityCount =
        prospectIds.length > 0
          ? (await db.select({ id: prospectActivityTable.id }).from(prospectActivityTable).where(inArray(prospectActivityTable.prospectId, prospectIds))).length
          : 0;

      const otherReferenceCounts = {
        campaigns: await countWhere(campaignsTable, campaignsTable.partnerCompanyId, companyId),
        partner_research_items: await countWhere(partnerResearchItemsTable, partnerResearchItemsTable.companyId, companyId),
        rfps: await countWhere(rfpsTable, rfpsTable.companyId, companyId),
        partner_events: await countWhere(partnerEventsTable, partnerEventsTable.companyId, companyId),
        channel_radar_signals: await countWhere(channelRadarSignalsTable, channelRadarSignalsTable.companyId, companyId),
        portfolio_import_rows: await countWhere(portfolioImportRowsTable, portfolioImportRowsTable.matchedCompanyId, companyId),
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

      members.push({
        companyId,
        prospectTerritoryStatuses: prospects.map((p) => ({ territoryId: p.territoryId, status: p.status })),
        portfolioTerritoryIds: relationships.map((r) => r.territoryId),
        hasRecruitmentReference: recruitmentCount > 0,
      });
    }

    const classification = classifyDuplicateGroup(members);
    summary.push({ canonicalDomain, rowCount: companyIds.length, classification });

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
    console.log("");
  }

  console.log("===== Summary =====");
  for (const s of summary) {
    console.log(`  ${s.canonicalDomain}: ${s.rowCount} rows, ${s.classification}`);
  }
  console.log(`\nDone. ${groupIndex} group(s) reported above. No data was modified.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
