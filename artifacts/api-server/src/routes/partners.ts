import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  prospectsTable,
  companiesTable,
  territoriesTable,
  usersTable,
  partnerResearchItemsTable,
  rfpsTable,
  partnerEventsTable,
  partnerRelationshipsTable,
} from "@workspace/db";
import {
  ListPartnersResponse,
  GetPartnerResponse,
  UpdatePartnerHelpNeededBody,
  UpdatePartnerHelpNeededResponse,
} from "@workspace/api-zod";
import { eq, and, or, inArray } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, ForbiddenScopeError } from "../services/authz";
import { findRelationshipByCompanyAndTerritory, type RelationshipStatus } from "../services/partnerRelationshipService";

// DEPRECATED legacy compatibility view (see openapi.yaml). Canonical Portfolio
// Truth: "partner" is defined ONLY by partner_relationships (one row per
// company + territory; see routes/portfolio.ts). prospects.status
// accepted/pushed_to_hubspot is Discovery truth, not partner truth -- a
// prospect can be accepted into recruitment and never become a partner. So
// every endpoint here now requires a canonical relationship for the
// prospect's own (company_id, territory_id) whose status is a CONFIRMED
// one (active/dormant/closed -- dormant/closed stay visible as confirmed
// historical states). needs_review never qualifies: it is an unconfirmed,
// app-inferred row (e.g. from opportunity evidence), not a partner. The
// remaining prospect-status condition is NOT a partner definition: it only
// exists because this legacy response contract (Partner.status enum) can
// only represent those two prospect statuses. No live UI route renders these endpoints any more (the
// campaign partner picker reads /portfolio); remove them once nothing calls
// them.
const CONFIRMED_RELATIONSHIP_STATUSES = ["active", "dormant", "closed"] as const satisfies readonly RelationshipStatus[];

function isConfirmedRelationshipStatus(status: string): boolean {
  return (CONFIRMED_RELATIONSHIP_STATUSES as readonly string[]).includes(status);
}

const hasCanonicalRelationship = and(
  eq(partnerRelationshipsTable.companyId, prospectsTable.companyId),
  eq(partnerRelationshipsTable.territoryId, prospectsTable.territoryId),
  inArray(partnerRelationshipsTable.status, [...CONFIRMED_RELATIONSHIP_STATUSES]),
);

const router: IRouter = Router();

function shapeCompany(c: typeof companiesTable.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    normalized_name: c.normalizedName,
    domain: c.domain,
    website_url: c.websiteUrl,
    country: c.country,
    headquarters: c.headquarters,
    employee_band: c.employeeBand,
    description: c.description,
    linkedin_url: c.linkedinUrl,
    hubspot_company_id: c.hubspotCompanyId,
  };
}

function shapePartner(
  p: typeof prospectsTable.$inferSelect,
  company: typeof companiesTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
  assignedUser: typeof usersTable.$inferSelect | null,
  openResearchCount: number,
) {
  return {
    id: p.id,
    company: shapeCompany(company),
    territory_id: p.territoryId,
    territory_name: territory?.name ?? null,
    assigned_user: assignedUser
      ? {
          id: assignedUser.id,
          name: assignedUser.name,
          email: assignedUser.email,
          role: assignedUser.role,
          territory: assignedUser.territory,
          active: assignedUser.active,
        }
      : null,
    status: p.status as "accepted" | "pushed_to_hubspot",
    last_researched_at: p.lastResearchedAt?.toISOString() ?? null,
    help_needed_type: p.helpNeededType,
    help_needed_note: p.helpNeededNote,
    open_research_count: openResearchCount,
    created_at: (p.acceptedAt ?? p.createdAt).toISOString(),
  };
}

router.get("/partners", requireAuth, async (req, res): Promise<void> => {
  const { territory } = req.query as { territory?: string };
  const actingUser = req.actingUser!;

  let scopedTerritoryId: string | null = null;
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    if (territory && territory !== "global" && territory !== "Global" && territory !== own.territoryId && territory !== own.territoryName) {
      res.status(403).json({ error: "You do not have access to that territory." });
      return;
    }
    scopedTerritoryId = own.territoryId;
  }

  const rows = await db
    .select({ prospect: prospectsTable, company: companiesTable, territoryRow: territoriesTable, assignedUser: usersTable })
    .from(prospectsTable)
    .innerJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(prospectsTable.assignedUserId, usersTable.id))
    .innerJoin(partnerRelationshipsTable, hasCanonicalRelationship)
    .where(or(eq(prospectsTable.status, "accepted"), eq(prospectsTable.status, "pushed_to_hubspot")));

  let filtered = scopedTerritoryId
    ? rows.filter((r) => r.territoryRow?.id === scopedTerritoryId)
    : territory && territory !== "global" && territory !== "Global"
    ? rows.filter((r) => r.territoryRow?.name === territory || r.territoryRow?.id === territory)
    : rows;

  const companyIds = filtered.map((r) => r.company.id);
  const researchCounts = companyIds.length
    ? await db
        .select({ companyId: partnerResearchItemsTable.companyId })
        .from(partnerResearchItemsTable)
        .where(inArray(partnerResearchItemsTable.companyId, companyIds))
    : [];
  const countByCompany = new Map<string, number>();
  for (const r of researchCounts) {
    countByCompany.set(r.companyId, (countByCompany.get(r.companyId) ?? 0) + 1);
  }

  res.json(
    ListPartnersResponse.parse(
      filtered.map((r) =>
        shapePartner(r.prospect, r.company, r.territoryRow, r.assignedUser, countByCompany.get(r.company.id) ?? 0),
      ),
    ),
  );
});

router.get("/partners/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({ prospect: prospectsTable, company: companiesTable, territoryRow: territoriesTable, assignedUser: usersTable })
    .from(prospectsTable)
    .innerJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(prospectsTable.assignedUserId, usersTable.id))
    .innerJoin(partnerRelationshipsTable, hasCanonicalRelationship)
    .where(and(eq(prospectsTable.id, id), or(eq(prospectsTable.status, "accepted"), eq(prospectsTable.status, "pushed_to_hubspot"))));

  if (!row) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, row.prospect.territoryId, row.territoryRow?.name);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [researchItems, rfpRows, eventRows] = await Promise.all([
    db.select().from(partnerResearchItemsTable).where(eq(partnerResearchItemsTable.companyId, row.company.id)),
    db.select().from(rfpsTable).where(eq(rfpsTable.companyId, row.company.id)),
    db.select().from(partnerEventsTable).where(eq(partnerEventsTable.companyId, row.company.id)),
  ]);

  res.json(
    GetPartnerResponse.parse({
      id: row.prospect.id,
      company: shapeCompany(row.company),
      territory_id: row.prospect.territoryId,
      territory_name: row.territoryRow?.name ?? null,
      assigned_user: row.assignedUser
        ? {
            id: row.assignedUser.id,
            name: row.assignedUser.name,
            email: row.assignedUser.email,
            role: row.assignedUser.role,
            territory: row.assignedUser.territory,
            active: row.assignedUser.active,
          }
        : null,
      status: row.prospect.status as "accepted" | "pushed_to_hubspot",
      last_researched_at: row.prospect.lastResearchedAt?.toISOString() ?? null,
      help_needed_type: row.prospect.helpNeededType,
      help_needed_note: row.prospect.helpNeededNote,
      commercial: {
        pipeline_sourced: row.prospect.pipelineSourced ? Number(row.prospect.pipelineSourced) : null,
        pipeline_influenced: row.prospect.pipelineInfluenced ? Number(row.prospect.pipelineInfluenced) : null,
        revenue_closed: row.prospect.revenueClosed ? Number(row.prospect.revenueClosed) : null,
        renewal_date: row.prospect.renewalDate ?? null,
      },
      research_items: researchItems.map((r) => ({
        id: r.id,
        category: r.category,
        source_kind: r.sourceKind,
        title: r.title,
        summary: r.summary,
        is_possible_customer_opening: r.isPossibleCustomerOpening,
        source_url: r.sourceUrl,
        source_domain: r.sourceDomain,
        published_at: r.publishedAt,
        discovered_at: r.discoveredAt.toISOString(),
      })),
      rfps: rfpRows.map((r) => ({
        id: r.id,
        title: r.title,
        country: r.country,
        deadline: r.deadline,
        why_relevant: r.whyRelevant,
        source_url: r.sourceUrl,
        source_domain: r.sourceDomain,
        discovered_at: r.discoveredAt.toISOString(),
      })),
      events: eventRows.map((e) => ({
        id: e.id,
        name: e.name,
        event_date: e.eventDate,
        location: e.location,
        why_it_matters: e.whyItMatters,
        suggested_action: e.suggestedAction,
        source_url: e.sourceUrl,
        discovered_at: e.discoveredAt.toISOString(),
      })),
      created_at: (row.prospect.acceptedAt ?? row.prospect.createdAt).toISOString(),
    }),
  );
});

router.patch("/partners/:id/help-needed", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdatePartnerHelpNeededBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id));
  const relationship = existing ? await findRelationshipByCompanyAndTerritory(existing.companyId, existing.territoryId) : null;
  if (
    !existing ||
    (existing.status !== "accepted" && existing.status !== "pushed_to_hubspot") ||
    !relationship ||
    !isConfirmedRelationshipStatus(relationship.status)
  ) {
    res.status(404).json({ error: "Partner not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, existing.territoryId, null);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [updated] = await db
    .update(prospectsTable)
    .set({ helpNeededType: parsed.data.help_needed_type, helpNeededNote: parsed.data.help_needed_note ?? null })
    .where(eq(prospectsTable.id, id))
    .returning();

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, updated.companyId));
  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, updated.territoryId));
  const assignedUser = updated.assignedUserId
    ? (await db.select().from(usersTable).where(eq(usersTable.id, updated.assignedUserId)))[0] ?? null
    : null;

  res.json(UpdatePartnerHelpNeededResponse.parse(shapePartner(updated, company, territory, assignedUser, 0)));
});

export default router;
