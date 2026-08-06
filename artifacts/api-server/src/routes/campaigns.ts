import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { campaignsTable, usersTable, campaignProspectsTable, prospectsTable, companiesTable, territoriesTable } from "@workspace/db";
import {
  ListCampaignsResponse,
  CreateCampaignBody,
  CreateCampaignResponse,
  GetCampaignResponse,
} from "@workspace/api-zod";
import { eq, count } from "drizzle-orm";

const router: IRouter = Router();

function shapeCampaign(c: typeof campaignsTable.$inferSelect, ownerName: string) {
  return {
    id: c.id,
    name: c.name,
    territory: c.territory,
    owner_user_id: c.ownerUserId,
    owner_name: ownerName,
    segment: c.segment,
    prospect_count: c.prospectCount,
    message_angle: c.messageAngle,
    start_date: c.startDate,
    status: c.status,
    replies: c.replies,
    qualified_meetings: c.qualifiedMeetings,
    signed_partners: c.signedPartners,
    created_at: c.createdAt.toISOString(),
  };
}

router.get("/campaigns", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ campaign: campaignsTable, owner: usersTable })
    .from(campaignsTable)
    .leftJoin(usersTable, eq(campaignsTable.ownerUserId, usersTable.id))
    .orderBy(campaignsTable.createdAt);

  res.json(ListCampaignsResponse.parse(rows.map((r) => shapeCampaign(r.campaign, r.owner?.name ?? ""))));
});

router.post("/campaigns", async (req, res): Promise<void> => {
  const parsed = CreateCampaignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, territory, owner_user_id, segment, message_angle, start_date, prospect_ids } = parsed.data;

  const [campaign] = await db
    .insert(campaignsTable)
    .values({
      name,
      territory,
      ownerUserId: owner_user_id,
      segment,
      messageAngle: message_angle,
      startDate: start_date ?? null,
      prospectCount: prospect_ids?.length ?? 0,
    })
    .returning();

  if (prospect_ids && prospect_ids.length > 0) {
    await db.insert(campaignProspectsTable).values(
      prospect_ids.map((pid) => ({ campaignId: campaign.id, prospectId: pid }))
    );
  }

  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, owner_user_id));
  res.status(201).json(CreateCampaignResponse.parse(shapeCampaign(campaign, owner?.name ?? "")));
});

router.get("/campaigns/:id", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({ campaign: campaignsTable, owner: usersTable })
    .from(campaignsTable)
    .leftJoin(usersTable, eq(campaignsTable.ownerUserId, usersTable.id))
    .where(eq(campaignsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  // Get associated prospects
  const prospectLinks = await db
    .select({
      prospect: prospectsTable,
      company: companiesTable,
      territory: territoriesTable,
      assignedUser: usersTable,
    })
    .from(campaignProspectsTable)
    .innerJoin(prospectsTable, eq(campaignProspectsTable.prospectId, prospectsTable.id))
    .leftJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(prospectsTable.assignedUserId, usersTable.id))
    .where(eq(campaignProspectsTable.campaignId, id));

  const prospects = prospectLinks
    .filter((r) => r.company !== null)
    .map((r) => ({
      id: r.prospect.id,
      company: {
        id: r.company!.id,
        name: r.company!.name,
        normalized_name: r.company!.normalizedName,
        domain: r.company!.domain,
        website_url: r.company!.websiteUrl,
        country: r.company!.country,
        headquarters: r.company!.headquarters,
        employee_band: r.company!.employeeBand,
        description: r.company!.description,
        linkedin_url: r.company!.linkedinUrl,
        hubspot_company_id: r.company!.hubspotCompanyId,
      },
      territory_id: r.prospect.territoryId,
      territory_name: r.territory?.name ?? null,
      assigned_user: r.assignedUser ? {
        id: r.assignedUser.id, name: r.assignedUser.name, email: r.assignedUser.email,
        role: r.assignedUser.role, territory: r.assignedUser.territory, active: r.assignedUser.active,
      } : null,
      partner_type: r.prospect.partnerType,
      priority: r.prospect.priority,
      enterprise_access: r.prospect.enterpriseAccess,
      relevant_capability: r.prospect.relevantCapability,
      technology_adjacency: r.prospect.technologyAdjacency,
      partnership_openness: r.prospect.partnershipOpenness,
      recent_trigger: r.prospect.recentTrigger,
      why_it_fits: r.prospect.whyItFits,
      why_now: r.prospect.whyNow,
      suggested_angle: r.prospect.suggestedAngle,
      suggested_target_role: r.prospect.suggestedTargetRole,
      suggested_message: r.prospect.suggestedMessage,
      status: r.prospect.status,
      rejection_reason: r.prospect.rejectionReason,
      pam_note: r.prospect.pamNote,
      accepted_at: r.prospect.acceptedAt?.toISOString() ?? null,
      hubspot_company_id: r.prospect.hubspotCompanyId,
      signal_count: 0,
      created_at: r.prospect.createdAt.toISOString(),
      updated_at: r.prospect.updatedAt?.toISOString() ?? null,
    }));

  res.json(GetCampaignResponse.parse({
    ...shapeCampaign(row.campaign, row.owner?.name ?? ""),
    prospects,
  }));
});

export default router;
