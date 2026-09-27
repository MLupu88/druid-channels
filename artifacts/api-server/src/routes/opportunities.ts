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
import { eq, inArray, and, sql, type SQL } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { z } from "zod";
import {
  isGlobalUser,
  getOwnTerritory,
  assertRecordTerritoryAccess,
  assertOwnUserAccess,
  resolveScopedTerritory,
  ForbiddenScopeError,
  type ActingUser,
} from "../services/authz";
import { recordChannelChangeEvent } from "../services/channelChangeEventsService";
import { resolveProviderSecret } from "../services/connections";
import { findCompanyByDomain, searchDeals, HubSpotAmbiguousCompanyError, HubSpotProviderError, type HubSpotDeal } from "../services/hubspot";
import { toRegistrableDomain } from "../services/companyIdentity";
import { normalizeCompanyName } from "../services/companyMatchingService";
import { reconcilePortfolioRelationshipForOpportunity } from "../services/partnerRelationshipService";

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

// Aniri / Channel Chief evidence infrastructure: the explicit, narrow set of
// fields whose change is commercially material -- deal identity/ownership
// (company, territory, assigned user, attribution type), deal economics
// (status, deal value, currency, credit value/date), and the dates that
// govern reporting-period/commercial interpretation (opportunity_date,
// expected_close_date, closed_at). customer_name is included -- it
// identifies WHO the commercial counterpart is, not just internal metadata.
// Deliberately EXCLUDED: name (a relabeling, not a commercial fact), note
// (free-text commentary), source_system/external_id/source_updated_at/
// last_synced_at (sync bookkeeping, not a business decision a human made).
// A PATCH that only touches excluded fields is a real, saved write -- it
// just never rises to a "material change" Aniri/Irina should hear about.
function materialOpportunityFields(row: typeof partnerOpportunitiesTable.$inferSelect): Record<string, unknown> {
  return {
    company_id: row.companyId,
    territory_id: row.territoryId,
    assigned_user_id: row.assignedUserId,
    attribution_type: row.attributionType,
    status: row.status,
    deal_value: Number(row.dealValue),
    currency: row.currency,
    opportunity_date: row.opportunityDate,
    expected_close_date: row.expectedCloseDate,
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
    credit_value: row.creditValue !== null ? Number(row.creditValue) : null,
    credit_date: row.creditDate,
    customer_name: row.customerName,
  };
}

// Pure, DB-free: compares the two ALREADY-normalized material-field maps
// above and returns only the keys whose value actually differs -- never a
// full snapshot of every material field, and never a result at all (null)
// when nothing material changed, so a PATCH that only edits (e.g.) note or
// name never produces a fabricated "material change" event.
export function diffMaterialOpportunityFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { oldValues: Record<string, unknown>; newValues: Record<string, unknown> } | null {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      oldValues[key] = before[key];
      newValues[key] = after[key];
    }
  }
  return Object.keys(newValues).length > 0 ? { oldValues, newValues } : null;
}

// Same "run either standalone or embedded in a caller's own transaction"
// pattern as partnerRelationshipService.ts/channelChangeEventsService.ts's
// Executor type. Exported (not inlined in the route handlers) specifically
// so the atomic mutation+event behavior is directly unit-testable against a
// real DB, without an HTTP test harness -- see
// tests/channelChangeFeed.test.ts.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

/**
 * Inserts an opportunity, its channel_change_events "created" row, and
 * reconciles a Portfolio relationship for its (company, territory) --
 * atomically. A creation is always material. Phase 12 Portfolio
 * Reconciliation: every opportunity, manual or imported, must leave its
 * company with SOME Portfolio relationship (creating a neutral
 * "needs_review" one if none exists yet, reusing an existing one untouched
 * otherwise) -- see reconcilePortfolioRelationshipForOpportunity. The
 * relationship write shares this same transaction as the opportunity insert,
 * so either both succeed or both roll back together -- an opportunity must
 * never exist without SOME Portfolio relationship for its company/territory.
 */
export async function applyOpportunityCreate(
  executor: Executor,
  values: typeof partnerOpportunitiesTable.$inferInsert,
): Promise<typeof partnerOpportunitiesTable.$inferSelect> {
  const [row] = await executor.insert(partnerOpportunitiesTable).values(values).returning();
  await recordChannelChangeEvent(executor, {
    entityType: "opportunity",
    entityId: row!.id,
    eventType: "created",
    actorUserId: values.createdByUserId ?? null,
    oldValues: null,
    newValues: materialOpportunityFields(row!),
    // company_id/territory_id are duplicated into metadata (in addition to
    // already being in new_values here) so channelChangeFeedService.ts can
    // resolve company_name/territory_name for this entity from every one of
    // its events uniformly -- see the "updated" branch below for why that
    // matters.
    metadata: { name: row!.name, company_id: row!.companyId, territory_id: row!.territoryId },
  });

  await reconcilePortfolioRelationshipForOpportunity(
    { companyId: row!.companyId, territoryId: row!.territoryId, opportunityAssignedUserId: row!.assignedUserId },
    values.createdByUserId ?? null,
    executor,
  );

  return row!;
}

/**
 * Updates an opportunity and, only when at least one material field
 * actually changed, records a channel_change_events "updated" row -- both
 * atomically. A PATCH touching only non-material fields (note, name,
 * sync bookkeeping) still saves normally but never records an event.
 */
export async function applyOpportunityUpdate(
  executor: Executor,
  existing: typeof partnerOpportunitiesTable.$inferSelect,
  updates: Partial<typeof partnerOpportunitiesTable.$inferInsert>,
  actorUserId: string,
): Promise<typeof partnerOpportunitiesTable.$inferSelect> {
  const [row] = await executor.update(partnerOpportunitiesTable).set(updates).where(eq(partnerOpportunitiesTable.id, existing.id)).returning();

  const diff = diffMaterialOpportunityFields(materialOpportunityFields(existing), materialOpportunityFields(row!));
  if (diff) {
    await recordChannelChangeEvent(executor, {
      entityType: "opportunity",
      entityId: row!.id,
      eventType: "updated",
      actorUserId,
      oldValues: diff.oldValues,
      newValues: diff.newValues,
      // company_id/territory_id are stable identity context, not part of
      // the "what changed" diff -- an update that only touches e.g. status
      // or deal_value never puts them in old_values/new_values (diff only
      // ever contains the fields that actually changed), so without this
      // the feed's context.company_name/territory_name would silently go
      // missing for the common case of an update that doesn't reassign the
      // opportunity. Always populated here (not conditionally), same as
      // the "created" branch above, so every opportunity event resolves
      // context the same way regardless of which fields changed.
      metadata: { name: row!.name, company_id: row!.companyId, territory_id: row!.territoryId },
    });
  }

  return row!;
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

const OpportunityImportReconcileBody = z.object({
  rows: z.array(z.object({ row_number: z.number().int().positive(), partner_domain: z.string().max(500), opportunity_name: z.string().max(500) })).max(100),
});

const OpportunityImportEnsureCompanyBody = z.object({
  domain: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  country: z.string().max(200).optional(),
  hubspot_company_id: z.string().max(200).nullable().optional(),
});

function normalizeImportDealName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function hubSpotImportWarning(error: unknown): string {
  if (error instanceof HubSpotProviderError) {
    switch (error.code) {
      case "authentication_error": return "HubSpot authentication failed; continuing with local-only reconciliation.";
      case "permission_error": return "HubSpot access was denied; continuing with local-only reconciliation.";
      case "rate_limited": return "HubSpot rate limit reached; continuing with local-only reconciliation.";
      case "timeout": return "HubSpot timed out; continuing with local-only reconciliation.";
      case "network_error": return "HubSpot is unavailable; continuing with local-only reconciliation.";
      default: return "HubSpot returned an invalid response; continuing with local-only reconciliation.";
    }
  }
  return "HubSpot reconciliation is unavailable; continuing with local-only reconciliation.";
}

function isUniqueCompanyDomainViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string; constraint?: string } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

// Head/Admin-only, bounded, read-only reconciliation. The browser sends only
// normalized identifying fields; the HubSpot token is resolved here and is
// never returned or logged. Local exact-domain matches always win and avoid a
// HubSpot company call.
router.post("/opportunities/import/reconcile", requireAdmin, async (req, res): Promise<void> => {
  const parsed = OpportunityImportReconcileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let accessToken: string | null = null;
  let providerWarning: string | null = null;
  try {
    accessToken = await resolveProviderSecret("hubspot");
  } catch (error) {
    providerWarning = hubSpotImportWarning(error);
  }

  const companyCache = new Map<string, { source: "local" | "hubspot" | "none" | "ambiguous"; company: { id: string; name: string; domain: string | null; country: string } | null; hubspotCompanyId: string | null; hubspotCompanyName: string | null; hubspotCompanyDomain: string | null; hubspotCompanyCountry: string | null }>();
  const dealCache = new Map<string, { deal: HubSpotDeal | null; ambiguous: boolean }>();
  const output: Array<Record<string, unknown>> = [];

  for (const row of parsed.data.rows) {
    const canonicalDomain = toRegistrableDomain(row.partner_domain);
    let companyResult = canonicalDomain ? companyCache.get(canonicalDomain) : undefined;
    if (!companyResult && canonicalDomain) {
      const matches = await db.select().from(companiesTable).where(sql`lower(${companiesTable.domain}) = ${canonicalDomain}`);
      if (matches.length > 1) {
        companyResult = { source: "ambiguous", company: null, hubspotCompanyId: null, hubspotCompanyName: null, hubspotCompanyDomain: null, hubspotCompanyCountry: null };
      } else if (matches.length === 1) {
        const company = matches[0]!;
        companyResult = { source: "local", company: { id: company.id, name: company.name, domain: company.domain, country: company.country }, hubspotCompanyId: null, hubspotCompanyName: null, hubspotCompanyDomain: null, hubspotCompanyCountry: null };
      } else if (!accessToken || providerWarning) {
        companyResult = { source: "none", company: null, hubspotCompanyId: null, hubspotCompanyName: null, hubspotCompanyDomain: null, hubspotCompanyCountry: null };
      } else {
        try {
          const match = await findCompanyByDomain(accessToken, canonicalDomain);
          if (!match) companyResult = { source: "none", company: null, hubspotCompanyId: null, hubspotCompanyName: null, hubspotCompanyDomain: null, hubspotCompanyCountry: null };
          else companyResult = {
            source: "hubspot",
            company: match.name ? { id: "", name: match.name, domain: match.domain, country: "Unknown" } : null,
            hubspotCompanyId: match.objectId || match.id,
            hubspotCompanyName: match.name,
            hubspotCompanyDomain: match.domain ?? canonicalDomain,
            hubspotCompanyCountry: "Unknown",
          };
        } catch (error) {
          if (error instanceof HubSpotAmbiguousCompanyError) {
            companyResult = { source: "ambiguous", company: null, hubspotCompanyId: null, hubspotCompanyName: null, hubspotCompanyDomain: null, hubspotCompanyCountry: null };
            // Continue with deal reconciliation; the company ambiguity alone
            // keeps this row out of Ready until a human resolves it.
          } else {
            providerWarning ??= hubSpotImportWarning(error);
            companyResult = { source: "none", company: null, hubspotCompanyId: null, hubspotCompanyName: null, hubspotCompanyDomain: null, hubspotCompanyCountry: null };
          }
        }
      }
      companyCache.set(canonicalDomain, companyResult);
    }

    const dealKey = normalizeImportDealName(row.opportunity_name);
    let dealResult = dealCache.get(dealKey);
    if (!dealResult && accessToken && !providerWarning && dealKey) {
      try {
        const deals = await searchDeals(accessToken, { query: row.opportunity_name, limit: 20 });
        const exact = deals.filter((deal) => normalizeImportDealName(deal.dealName ?? "") === dealKey);
        dealResult = { deal: exact.length === 1 ? exact[0]! : null, ambiguous: exact.length > 1 };
      } catch (error) {
        providerWarning ??= hubSpotImportWarning(error);
        dealResult = { deal: null, ambiguous: false };
      }
      dealCache.set(dealKey, dealResult);
    }

    output.push({
      row_number: row.row_number,
      company_source: companyResult?.source ?? "none",
      company: companyResult?.company ?? null,
      hubspot_company_id: companyResult?.hubspotCompanyId ?? null,
      hubspot_company_name: companyResult?.hubspotCompanyName ?? null,
      hubspot_company_domain: companyResult?.hubspotCompanyDomain ?? null,
      hubspot_company_country: companyResult?.hubspotCompanyCountry ?? null,
      deal: dealResult?.deal ? {
        id: dealResult.deal.id,
        dealName: dealResult.deal.dealName,
        amount: dealResult.deal.amount,
        closeDate: dealResult.deal.closeDate,
        createDate: dealResult.deal.createDate,
      } : null,
      deal_ambiguous: dealResult?.ambiguous ?? false,
    });
  }

  res.json({ provider_warning: providerWarning, rows: output });
});

// Ensures only the local company identity needed by partner_opportunities.
// This never creates a Portfolio/recruitment record and never writes to
// HubSpot. The canonical domain unique index plus the retry lookup makes
// concurrent/repeated cutover confirms idempotent.
router.post("/opportunities/import/ensure-company", requireAdmin, async (req, res): Promise<void> => {
  const parsed = OpportunityImportEnsureCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const canonicalDomain = toRegistrableDomain(parsed.data.domain);
  if (!canonicalDomain) {
    res.status(400).json({ error: "A valid company domain is required." });
    return;
  }

  const selectMatches = () => db.select().from(companiesTable).where(sql`lower(${companiesTable.domain}) = ${canonicalDomain}`);
  let matches = await selectMatches();
  if (matches.length > 1) {
    res.status(409).json({ error: "Multiple local companies share this domain." });
    return;
  }
  if (matches.length === 1) {
    const existing = matches[0]!;
    if (parsed.data.hubspot_company_id && !existing.hubspotCompanyId) {
      const [updated] = await db.update(companiesTable).set({ hubspotCompanyId: parsed.data.hubspot_company_id, updatedAt: new Date() }).where(eq(companiesTable.id, existing.id)).returning();
      res.json({ id: updated!.id, name: updated!.name, domain: updated!.domain, country: updated!.country });
      return;
    }
    res.json({ id: existing.id, name: existing.name, domain: existing.domain, country: existing.country });
    return;
  }

  try {
    const [created] = await db.insert(companiesTable).values({
      name: parsed.data.name.trim(),
      normalizedName: normalizeCompanyName(parsed.data.name),
      domain: canonicalDomain,
      country: parsed.data.country?.trim() || "Unknown",
      hubspotCompanyId: parsed.data.hubspot_company_id ?? null,
    }).returning();
    res.status(201).json({ id: created!.id, name: created!.name, domain: created!.domain, country: created!.country });
  } catch (error) {
    if (!isUniqueCompanyDomainViolation(error)) throw error;
    matches = await selectMatches();
    if (matches.length === 1) {
      const existing = matches[0]!;
      res.json({ id: existing.id, name: existing.name, domain: existing.domain, country: existing.country });
      return;
    }
    res.status(409).json({ error: "Multiple local companies share this domain." });
  }
});

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
  // Additive Phase 6 filter for the Marketing Activities opportunity-link
  // picker (scope choices to the activity's selected partner). Applied on
  // top of, never in place of, the existing territory/assignment scoping
  // below -- a PAM filtering by company_id still only ever sees their own.
  if (parsedQuery.data.company_id) filters.push(eq(partnerOpportunitiesTable.companyId, parsedQuery.data.company_id));
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

  // Phase 11.6.1: the insert and its channel_change_events "created" row are
  // atomic -- see applyOpportunityCreate above (same convention as
  // targetService.ts's upsertTarget).
  let created: typeof partnerOpportunitiesTable.$inferSelect;
  try {
    created = await db.transaction((tx) =>
      applyOpportunityCreate(tx, {
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
      }),
    );
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

  // Phase 11.6.1: the update and its conditional channel_change_events
  // "updated" row are atomic -- see applyOpportunityUpdate above.
  const updated = await db.transaction((tx) => applyOpportunityUpdate(tx, existing, updates, actingUser.id));

  res.json(UpdateOpportunityResponse.parse((await shapeRows([updated]))[0]));
});

export default router;
