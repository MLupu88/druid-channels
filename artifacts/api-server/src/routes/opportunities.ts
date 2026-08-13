import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { partnerOpportunitiesTable, companiesTable, territoriesTable, usersTable } from "@workspace/db";
import {
  ListOpportunitiesQueryParams,
  ListOpportunitiesResponse,
  CreateOpportunityBody,
  CreateOpportunityResponse,
  GetOpportunityResponse,
  UpdateOpportunityBody,
  UpdateOpportunityResponse,
} from "@workspace/api-zod";
import { eq, inArray, and, type SQL } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import {
  isGlobalUser,
  getOwnTerritory,
  assertRecordTerritoryAccess,
  assertOwnUserAccess,
  resolveScopedTerritory,
  ForbiddenScopeError,
  type ActingUser,
} from "../services/authz";

const router: IRouter = Router();

// The exact index name declared in schema/partner_opportunities.ts's
// partner_opportunities_source_external_unique.
const SOURCE_EXTERNAL_UNIQUE_CONSTRAINT = "partner_opportunities_source_external_unique";

// drizzle-orm (node-postgres driver) wraps the real Postgres error in a
// "Failed query: ..." wrapper, attaching the actual `pg` DatabaseError as
// `.cause` -- same shape documented in tests/migrationInvariants.test.ts's
// isUniqueViolation helper. That DatabaseError exposes the violated
// index/constraint name STRUCTURALLY as `.constraint` (parsed from the
// Postgres wire protocol's ErrorResponse "n" field), so this checks that
// field directly rather than substring-matching the error message text.
// Scoped to this exact constraint name -- any OTHER 23505 on this table
// (or elsewhere) must rethrow unchanged rather than being mislabeled as an
// imported-opportunity duplicate. Exported so the narrowing behavior itself
// is unit-testable without needing a second live unique constraint.
export function isSourceExternalUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === "23505" && cause?.constraint === SOURCE_EXTERNAL_UNIQUE_CONSTRAINT;
}

// Batch-fetched company/territory/user name lookups -- same pattern as
// routes/metric_targets.ts's shapeRows.
async function shapeRows(rows: (typeof partnerOpportunitiesTable.$inferSelect)[]) {
  const companyIds = [...new Set(rows.map((r) => r.companyId))];
  const territoryIds = [...new Set(rows.map((r) => r.territoryId))];
  const userIds = [...new Set([...rows.map((r) => r.assignedUserId), ...rows.map((r) => r.createdByUserId)].filter((id): id is string => id !== null))];

  const [companies, territories, users] = await Promise.all([
    companyIds.length ? db.select().from(companiesTable).where(inArray(companiesTable.id, companyIds)) : ([] as (typeof companiesTable.$inferSelect)[]),
    territoryIds.length ? db.select().from(territoriesTable).where(inArray(territoriesTable.id, territoryIds)) : ([] as (typeof territoriesTable.$inferSelect)[]),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : ([] as (typeof usersTable.$inferSelect)[]),
  ]);
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? "Unknown";
  const territoryName = (id: string) => territories.find((t) => t.id === id)?.name ?? "Unknown";
  const userName = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    company_id: r.companyId,
    company_name: companyName(r.companyId),
    territory_id: r.territoryId,
    territory_name: territoryName(r.territoryId),
    assigned_user_id: r.assignedUserId,
    assigned_user_name: userName(r.assignedUserId) ?? "Unknown",
    attribution_type: r.attributionType,
    status: r.status,
    deal_value: Number(r.dealValue),
    currency: r.currency,
    opportunity_date: r.opportunityDate,
    expected_close_date: r.expectedCloseDate,
    closed_at: r.closedAt ? r.closedAt.toISOString() : null,
    credit_value: r.creditValue !== null ? Number(r.creditValue) : null,
    credit_date: r.creditDate,
    customer_name: r.customerName,
    note: r.note,
    source_system: r.sourceSystem,
    external_id: r.externalId,
    source_updated_at: r.sourceUpdatedAt ? r.sourceUpdatedAt.toISOString() : null,
    last_synced_at: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    created_by_user_id: r.createdByUserId,
    created_by_name: userName(r.createdByUserId),
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }));
}

// status=won requires a real closed_at -- the one DB-unenforced invariant
// the Phase 5A brief calls out explicitly (closed_at legitimately has no
// value at all for a not-yet-won deal, so this can never be a CHECK
// constraint). Never falsified/defaulted -- the caller must provide it.
function assertWonHasClosedAt(status: string, closedAt: string | null | undefined): void {
  if (status === "won" && !closedAt) {
    throw new OpportunityValidationError("status=won requires closed_at to be set.");
  }
}

function assertCreditValuePositive(creditValue: number | null | undefined): void {
  if (creditValue !== null && creditValue !== undefined && creditValue <= 0) {
    throw new OpportunityValidationError("credit_value must be positive when present.");
  }
}

class OpportunityValidationError extends Error {}

// A PAM's scope on an existing record is BOTH their own canonical territory
// AND their own assignment -- the Phase 5A brief lists "own territory" and
// "assigned to self" as two independent, explicitly-named constraints, so
// both are enforced here rather than treating either alone as sufficient.
async function assertPamOwnsOpportunity(actingUser: ActingUser, opp: typeof partnerOpportunitiesTable.$inferSelect): Promise<void> {
  await assertRecordTerritoryAccess(actingUser, opp.territoryId, null);
  assertOwnUserAccess(actingUser, opp.assignedUserId);
}

router.get("/opportunities", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const parsedQuery = ListOpportunitiesQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  let scopedTerritory;
  try {
    scopedTerritory = await resolveScopedTerritory(actingUser, parsedQuery.data.territory);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const filters: SQL[] = [];
  if (scopedTerritory.territoryId) filters.push(eq(partnerOpportunitiesTable.territoryId, scopedTerritory.territoryId));
  if (parsedQuery.data.status) filters.push(eq(partnerOpportunitiesTable.status, parsedQuery.data.status));
  if (parsedQuery.data.attribution_type) filters.push(eq(partnerOpportunitiesTable.attributionType, parsedQuery.data.attribution_type));
  if (!isGlobalUser(actingUser)) filters.push(eq(partnerOpportunitiesTable.assignedUserId, actingUser.id));

  const rows = filters.length
    ? await db.select().from(partnerOpportunitiesTable).where(and(...filters))
    : await db.select().from(partnerOpportunitiesTable);

  res.json(ListOpportunitiesResponse.parse(await shapeRows(rows)));
});

router.get("/opportunities/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [existing] = await db.select().from(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }

  try {
    await assertPamOwnsOpportunity(req.actingUser!, existing);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json(GetOpportunityResponse.parse((await shapeRows([existing]))[0]));
});

router.post("/opportunities", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const parsed = CreateOpportunityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  try {
    if (!isGlobalUser(actingUser)) {
      const own = await getOwnTerritory(actingUser.id);
      if (!own) throw new ForbiddenScopeError("Your account has no territory assigned. Contact an admin.");
      if (data.territory_id !== own.territoryId) {
        throw new ForbiddenScopeError("You can only create opportunities in your own territory.");
      }
      assertOwnUserAccess(actingUser, data.assigned_user_id);
    }
    assertWonHasClosedAt(data.status ?? "open", data.closed_at);
    assertCreditValuePositive(data.credit_value);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof OpportunityValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  let created: typeof partnerOpportunitiesTable.$inferSelect;
  try {
    [created] = await db
      .insert(partnerOpportunitiesTable)
      .values({
        name: data.name,
        companyId: data.company_id,
        territoryId: data.territory_id,
        assignedUserId: data.assigned_user_id,
        attributionType: data.attribution_type,
        status: data.status ?? "open",
        dealValue: String(data.deal_value),
        currency: data.currency,
        opportunityDate: data.opportunity_date,
        expectedCloseDate: data.expected_close_date ?? null,
        closedAt: data.closed_at ? new Date(data.closed_at) : null,
        creditValue: data.credit_value !== null && data.credit_value !== undefined ? String(data.credit_value) : null,
        creditDate: data.credit_date ?? null,
        customerName: data.customer_name ?? null,
        note: data.note ?? null,
        sourceSystem: data.source_system ?? "manual",
        externalId: data.external_id ?? null,
        sourceUpdatedAt: data.source_updated_at ? new Date(data.source_updated_at) : null,
        createdByUserId: actingUser.id,
      })
      .returning()
      .then((rows) => rows as [typeof partnerOpportunitiesTable.$inferSelect]);
  } catch (err) {
    // Guards partner_opportunities_source_external_unique specifically (see
    // schema): a repeat import upload for the same source_system+external_id
    // must surface as an explicit, distinguishable conflict -- never a raw
    // 500 -- so the historical-cutover importer (Phase 5B-3) can report it
    // as a skipped duplicate instead of a mysterious failure. Any OTHER
    // 23505 (a different unique constraint, now or in the future) is
    // deliberately NOT caught here -- see isSourceExternalUniqueViolation.
    if (isSourceExternalUniqueViolation(err)) {
      res.status(409).json({ error: "An opportunity with this source_system and external_id already exists." });
      return;
    }
    throw err;
  }

  res.status(201).json(CreateOpportunityResponse.parse((await shapeRows([created]))[0]));
});

router.patch("/opportunities/:id", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateOpportunityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [existing] = await db.select().from(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }

  try {
    await assertPamOwnsOpportunity(actingUser, existing);
    if (!isGlobalUser(actingUser)) {
      if (data.assigned_user_id !== undefined) assertOwnUserAccess(actingUser, data.assigned_user_id);
      if (data.territory_id !== undefined) {
        const own = await getOwnTerritory(actingUser.id);
        if (!own || data.territory_id !== own.territoryId) {
          throw new ForbiddenScopeError("You cannot widen this opportunity's territory scope.");
        }
      }
    }
    const resultingStatus = data.status ?? existing.status;
    const resultingClosedAt = data.closed_at !== undefined ? data.closed_at : existing.closedAt ? existing.closedAt.toISOString() : null;
    assertWonHasClosedAt(resultingStatus, resultingClosedAt);
    if (data.credit_value !== undefined) assertCreditValuePositive(data.credit_value);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof OpportunityValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  const updates: Partial<typeof partnerOpportunitiesTable.$inferInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.company_id !== undefined) updates.companyId = data.company_id;
  if (data.territory_id !== undefined) updates.territoryId = data.territory_id;
  if (data.assigned_user_id !== undefined) updates.assignedUserId = data.assigned_user_id;
  if (data.attribution_type !== undefined) updates.attributionType = data.attribution_type;
  if (data.status !== undefined) updates.status = data.status;
  if (data.deal_value !== undefined) updates.dealValue = String(data.deal_value);
  if (data.currency !== undefined) updates.currency = data.currency;
  if (data.opportunity_date !== undefined) updates.opportunityDate = data.opportunity_date;
  if (data.expected_close_date !== undefined) updates.expectedCloseDate = data.expected_close_date;
  if (data.closed_at !== undefined) updates.closedAt = data.closed_at ? new Date(data.closed_at) : null;
  if (data.credit_value !== undefined) updates.creditValue = data.credit_value !== null ? String(data.credit_value) : null;
  if (data.credit_date !== undefined) updates.creditDate = data.credit_date;
  if (data.customer_name !== undefined) updates.customerName = data.customer_name;
  if (data.note !== undefined) updates.note = data.note;
  if (data.source_system !== undefined) updates.sourceSystem = data.source_system;
  if (data.external_id !== undefined) updates.externalId = data.external_id;
  if (data.source_updated_at !== undefined) updates.sourceUpdatedAt = data.source_updated_at ? new Date(data.source_updated_at) : null;

  const [updated] = await db.update(partnerOpportunitiesTable).set(updates).where(eq(partnerOpportunitiesTable.id, id)).returning();

  res.json(UpdateOpportunityResponse.parse((await shapeRows([updated]))[0]));
});

export default router;
