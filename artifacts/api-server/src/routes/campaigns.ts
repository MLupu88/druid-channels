import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { campaignsTable, usersTable, companiesTable } from "@workspace/db";
import {
  ListCampaignsResponse,
  CreateCampaignBody,
  CreateCampaignResponse,
  UpdateCampaignBody,
  UpdateCampaignResponse,
  DeleteCampaignResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, assertOwnUserAccess, ForbiddenScopeError } from "../services/authz";

const router: IRouter = Router();

function shapeCampaign(c: typeof campaignsTable.$inferSelect, ownerName: string, partnerCompanyName: string | null) {
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
  };
}

router.get("/campaigns", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const rows = await db
    .select({ campaign: campaignsTable, owner: usersTable, partnerCompany: companiesTable })
    .from(campaignsTable)
    .leftJoin(usersTable, eq(campaignsTable.ownerUserId, usersTable.id))
    .leftJoin(companiesTable, eq(campaignsTable.partnerCompanyId, companiesTable.id))
    .orderBy(campaignsTable.activityDate);

  const scoped = isGlobalUser(actingUser) ? rows : rows.filter((r) => r.campaign.ownerUserId === actingUser.id);

  res.json(
    ListCampaignsResponse.parse(
      scoped.map((r) => shapeCampaign(r.campaign, r.owner?.name ?? "", r.partnerCompany?.name ?? null)),
    ),
  );
});

router.post("/campaigns", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, type, territory, owner_user_id, partner_company_id, activity_date, status, hubspot_link, notes } = parsed.data;

  try {
    assertOwnUserAccess(req.actingUser!, owner_user_id);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [campaign] = await db
    .insert(campaignsTable)
    .values({
      name,
      type,
      territory,
      ownerUserId: owner_user_id,
      partnerCompanyId: partner_company_id ?? null,
      activityDate: activity_date ?? null,
      status: status ?? "planned",
      hubspotLink: hubspot_link ?? null,
      notes: notes ?? null,
    })
    .returning();

  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, owner_user_id));
  const partnerCompany = partner_company_id
    ? (await db.select().from(companiesTable).where(eq(companiesTable.id, partner_company_id)))[0] ?? null
    : null;

  res
    .status(201)
    .json(CreateCampaignResponse.parse(shapeCampaign(campaign, owner?.name ?? "", partnerCompany?.name ?? null)));
});

router.patch("/campaigns/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Activity not found" });
    return;
  }

  try {
    assertOwnUserAccess(req.actingUser!, existing.ownerUserId);
    if (parsed.data.owner_user_id !== undefined) {
      assertOwnUserAccess(req.actingUser!, parsed.data.owner_user_id);
    }
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const data = parsed.data;
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

  const [updated] = await db.update(campaignsTable).set(updates).where(eq(campaignsTable.id, id)).returning();

  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, updated.ownerUserId));
  const partnerCompany = updated.partnerCompanyId
    ? (await db.select().from(companiesTable).where(eq(companiesTable.id, updated.partnerCompanyId)))[0] ?? null
    : null;

  res.json(UpdateCampaignResponse.parse(shapeCampaign(updated, owner?.name ?? "", partnerCompany?.name ?? null)));
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
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));

  res.json(DeleteCampaignResponse.parse({ id, deleted: true }));
});

export default router;
