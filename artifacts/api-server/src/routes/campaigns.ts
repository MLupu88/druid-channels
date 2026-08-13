import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { campaignsTable, usersTable, companiesTable } from "@workspace/db";
import {
  ListCampaignsQueryParams,
  ListCampaignsResponse,
  CreateCampaignBody,
  CreateCampaignResponse,
  UpdateCampaignBody,
  UpdateCampaignResponse,
  DeleteCampaignResponse,
  SetCampaignOpportunitiesBody,
  SetCampaignOpportunitiesResponse,
} from "@workspace/api-zod";
import { eq, and, type SQL } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, assertOwnUserAccess, ForbiddenScopeError } from "../services/authz";
import { parseCurrencyParam, InvalidCurrencyError, FxUnavailableError, type SupportedCurrency } from "../services/fx";
import {
  CampaignValidationError,
  validateOpportunityLinks,
  replaceCampaignOpportunityLinks,
  computeCommercialImpact,
  assertPartnerChangeCompatibleWithLinks,
  type CampaignCommercialImpact,
} from "../services/campaignService";

const router: IRouter = Router();

// Every mutation response defaults to USD -- only the list view exposes a
// `currency` query param. A create/update/link response is a single-record
// confirmation, not a report; keeping it currency-invariant avoids a client
// having to re-request in a specific display currency just to get back the
// record it already knows the shape of.
const DEFAULT_RESPONSE_CURRENCY: SupportedCurrency = "USD";

function shapeCampaign(
  c: typeof campaignsTable.$inferSelect,
  ownerName: string,
  partnerCompanyName: string | null,
  impact: CampaignCommercialImpact,
) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    territory: c.territory,
    owner_user_id: c.ownerUserId,
    owner_name: ownerName,
    partner_company_id: c.partnerCompanyId,
    partner_company_name: partnerCompanyName,
    activity_date: c.activityDate,
    status: c.status,
    hubspot_link: c.hubspotLink,
    mqls: c.mqls,
    partner_referrals: c.partnerReferrals,
    notes: c.notes,
    created_at: c.createdAt.toISOString(),
    linked_opportunity_ids: impact.linkedOpportunityIds,
    linked_opportunity_count: impact.linkedOpportunityCount,
    linked_open_pipeline: impact.linkedOpenPipeline,
    linked_closed_revenue: impact.linkedClosedRevenue,
  };
}

// Central mapping for the authz/validation errors every campaign route can
// raise. Returns true once it has written a response (caller must return
// immediately after), false if `err` wasn't one of these (caller rethrows).
function handleCampaignError(err: unknown, res: Response): boolean {
  if (err instanceof ForbiddenScopeError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  if (err instanceof CampaignValidationError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof InvalidCurrencyError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof FxUnavailableError) {
    res.status(503).json({ error: err.message });
    return true;
  }
  return false;
}

router.get("/campaigns", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const parsedQuery = ListCampaignsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { partner_company_id, type, status, owner_user_id, currency } = parsedQuery.data;

  let selectedCurrency: SupportedCurrency;
  try {
    selectedCurrency = parseCurrencyParam(currency);
  } catch (err) {
    if (handleCampaignError(err, res)) return;
    throw err;
  }

  const filters: SQL[] = [];
  if (partner_company_id) filters.push(eq(campaignsTable.partnerCompanyId, partner_company_id));
  if (type) filters.push(eq(campaignsTable.type, type));
  if (status) filters.push(eq(campaignsTable.status, status));
  if (isGlobalUser(actingUser)) {
    if (owner_user_id) filters.push(eq(campaignsTable.ownerUserId, owner_user_id));
  } else {
    // Non-global scoping is unconditional -- never relaxed by any combination
    // of query params, matching every other authz-scoped list in this app.
    filters.push(eq(campaignsTable.ownerUserId, actingUser.id));
  }

  const rows = await db
    .select({ campaign: campaignsTable, owner: usersTable, partnerCompany: companiesTable })
    .from(campaignsTable)
    .leftJoin(usersTable, eq(campaignsTable.ownerUserId, usersTable.id))
    .leftJoin(companiesTable, eq(campaignsTable.partnerCompanyId, companiesTable.id))
    .where(and(...filters))
    .orderBy(campaignsTable.activityDate);

  let impactByCampaign: Map<string, CampaignCommercialImpact>;
  try {
    impactByCampaign = await computeCommercialImpact(
      rows.map((r) => r.campaign.id),
      actingUser,
      selectedCurrency,
    );
  } catch (err) {
    if (handleCampaignError(err, res)) return;
    throw err;
  }

  res.json(
    ListCampaignsResponse.parse(
      rows.map((r) =>
        shapeCampaign(r.campaign, r.owner?.name ?? "", r.partnerCompany?.name ?? null, impactByCampaign.get(r.campaign.id)!),
      ),
    ),
  );
});

router.post("/campaigns", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, type, territory, owner_user_id, partner_company_id, activity_date, status, hubspot_link, notes, opportunity_ids } =
    parsed.data;

  // Hoisted above the try/catch so TypeScript narrows partner_company_id to
  // `string` (not `string | null | undefined`) for the rest of the handler --
  // the DB column stays nullable (legacy rows), only NEW-activity creation
  // requires it.
  if (!partner_company_id) {
    res.status(400).json({ error: "Partner is required for a new marketing activity." });
    return;
  }

  let validatedOpportunities;
  try {
    assertOwnUserAccess(actingUser, owner_user_id);
    validatedOpportunities = await validateOpportunityLinks(actingUser, partner_company_id, opportunity_ids ?? []);
  } catch (err) {
    if (handleCampaignError(err, res)) return;
    throw err;
  }

  const [campaign] = await db
    .insert(campaignsTable)
    .values({
      name,
      type,
      territory,
      ownerUserId: owner_user_id,
      partnerCompanyId: partner_company_id,
      activityDate: activity_date ?? null,
      status: status ?? "planned",
      hubspotLink: hubspot_link ?? null,
      notes: notes ?? null,
    })
    .returning();

  await replaceCampaignOpportunityLinks(
    campaign.id,
    validatedOpportunities.map((o) => o.id),
  );

  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, owner_user_id));
  const [partnerCompany] = await db.select().from(companiesTable).where(eq(companiesTable.id, partner_company_id));
  const impactByCampaign = await computeCommercialImpact([campaign.id], actingUser, DEFAULT_RESPONSE_CURRENCY);

  res
    .status(201)
    .json(
      CreateCampaignResponse.parse(
        shapeCampaign(campaign, owner?.name ?? "", partnerCompany?.name ?? null, impactByCampaign.get(campaign.id)!),
      ),
    );
});

router.patch("/campaigns/:id", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;

  const [existing] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  const partnerChanged = data.partner_company_id !== undefined && data.partner_company_id !== existing.partnerCompanyId;
  const resultingPartnerCompanyId = data.partner_company_id !== undefined ? data.partner_company_id : existing.partnerCompanyId;

  let validatedOpportunities: Awaited<ReturnType<typeof validateOpportunityLinks>> | null = null;
  try {
    assertOwnUserAccess(actingUser, existing.ownerUserId);
    if (data.owner_user_id !== undefined) {
      assertOwnUserAccess(actingUser, data.owner_user_id);
    }

    if (data.opportunity_ids !== undefined) {
      validatedOpportunities = await validateOpportunityLinks(actingUser, resultingPartnerCompanyId, data.opportunity_ids ?? []);
    } else if (partnerChanged) {
      // Partner is changing but the caller didn't also resend the link set --
      // the EXISTING links must still be valid under the new partner, or this
      // edit is rejected rather than silently orphaning/misattributing them.
      await assertPartnerChangeCompatibleWithLinks(existing.id, resultingPartnerCompanyId);
    }
  } catch (err) {
    if (handleCampaignError(err, res)) return;
    throw err;
  }

  const updates: Partial<typeof campaignsTable.$inferInsert> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.territory !== undefined) updates.territory = data.territory;
  if (data.owner_user_id !== undefined) updates.ownerUserId = data.owner_user_id;
  if (data.partner_company_id !== undefined) updates.partnerCompanyId = data.partner_company_id;
  if (data.activity_date !== undefined) updates.activityDate = data.activity_date;
  if (data.status !== undefined) updates.status = data.status;
  if (data.hubspot_link !== undefined) updates.hubspotLink = data.hubspot_link;
  if (data.mqls !== undefined) updates.mqls = data.mqls;
  if (data.partner_referrals !== undefined) updates.partnerReferrals = data.partner_referrals;
  if (data.notes !== undefined) updates.notes = data.notes;

  const [updated] = Object.keys(updates).length
    ? await db.update(campaignsTable).set(updates).where(eq(campaignsTable.id, id)).returning()
    : [existing];

  if (validatedOpportunities !== null) {
    await replaceCampaignOpportunityLinks(
      id,
      validatedOpportunities.map((o) => o.id),
    );
  }

  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, updated.ownerUserId));
  const partnerCompany = updated.partnerCompanyId
    ? (await db.select().from(companiesTable).where(eq(companiesTable.id, updated.partnerCompanyId)))[0] ?? null
    : null;
  const impactByCampaign = await computeCommercialImpact([id], actingUser, DEFAULT_RESPONSE_CURRENCY);

  res.json(
    UpdateCampaignResponse.parse(shapeCampaign(updated, owner?.name ?? "", partnerCompany?.name ?? null, impactByCampaign.get(id)!)),
  );
});

router.put("/campaigns/:id/opportunities", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = SetCampaignOpportunitiesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  let validatedOpportunities;
  try {
    assertOwnUserAccess(actingUser, existing.ownerUserId);
    validatedOpportunities = await validateOpportunityLinks(actingUser, existing.partnerCompanyId, parsed.data.opportunity_ids);
  } catch (err) {
    if (handleCampaignError(err, res)) return;
    throw err;
  }

  await replaceCampaignOpportunityLinks(
    id,
    validatedOpportunities.map((o) => o.id),
  );

  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, existing.ownerUserId));
  const partnerCompany = existing.partnerCompanyId
    ? (await db.select().from(companiesTable).where(eq(companiesTable.id, existing.partnerCompanyId)))[0] ?? null
    : null;
  const impactByCampaign = await computeCommercialImpact([id], actingUser, DEFAULT_RESPONSE_CURRENCY);

  res.json(
    SetCampaignOpportunitiesResponse.parse(
      shapeCampaign(existing, owner?.name ?? "", partnerCompany?.name ?? null, impactByCampaign.get(id)!),
    ),
  );
});

router.delete("/campaigns/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [existing] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  try {
    assertOwnUserAccess(req.actingUser!, existing.ownerUserId);
  } catch (err) {
    if (handleCampaignError(err, res)) return;
    throw err;
  }

  // ON DELETE CASCADE on campaign_opportunities.campaign_id drops any linked
  // rows automatically -- never leaves a dangling link.
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));

  res.json(DeleteCampaignResponse.parse({ id, deleted: true }));
});

export default router;
