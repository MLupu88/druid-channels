import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  prospectsTable,
  companiesTable,
  territoriesTable,
  usersTable,
  signalsTable,
  prospectActivityTable,
} from "@workspace/db";
import {
  ListProspectsResponse,
  GetProspectResponse,
  MakeProspectDecisionBody,
  MakeProspectDecisionResponse,
  PushProspectToHubspotResponse,
  GetProspectStatsResponse,
} from "@workspace/api-zod";
import { eq, and, sql, count } from "drizzle-orm";

const router: IRouter = Router();

function buildProspectShape(
  p: typeof prospectsTable.$inferSelect,
  company: typeof companiesTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
  assignedUser: typeof usersTable.$inferSelect | null,
  signalCount: number,
) {
  return {
    id: p.id,
    company: {
      id: company.id,
      name: company.name,
      normalized_name: company.normalizedName,
      domain: company.domain,
      website_url: company.websiteUrl,
      country: company.country,
      headquarters: company.headquarters,
      employee_band: company.employeeBand,
      description: company.description,
      linkedin_url: company.linkedinUrl,
      hubspot_company_id: company.hubspotCompanyId,
    },
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
    partner_type: p.partnerType,
    priority: p.priority,
    enterprise_access: p.enterpriseAccess,
    relevant_capability: p.relevantCapability,
    technology_adjacency: p.technologyAdjacency,
    partnership_openness: p.partnershipOpenness,
    recent_trigger: p.recentTrigger,
    why_it_fits: p.whyItFits,
    why_now: p.whyNow,
    suggested_angle: p.suggestedAngle,
    suggested_target_role: p.suggestedTargetRole,
    suggested_message: p.suggestedMessage,
    status: p.status,
    rejection_reason: p.rejectionReason,
    pam_note: p.pamNote,
    accepted_at: p.acceptedAt?.toISOString() ?? null,
    hubspot_company_id: p.hubspotCompanyId,
    signal_count: signalCount,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt?.toISOString() ?? null,
  };
}

router.get("/prospects/stats/summary", async (_req, res): Promise<void> => {
  const all = await db
    .select({
      prospect: prospectsTable,
      territory: territoriesTable,
    })
    .from(prospectsTable)
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id));

  const byTerritory: Record<string, { territory: string; total: number; new: number; accepted: number; rejected: number; deferred: number; pushed_to_hubspot: number; priority_a: number; priority_b: number }> = {};

  for (const row of all) {
    const tname = row.territory?.name ?? "Unknown";
    if (!byTerritory[tname]) {
      byTerritory[tname] = { territory: tname, total: 0, new: 0, accepted: 0, rejected: 0, deferred: 0, pushed_to_hubspot: 0, priority_a: 0, priority_b: 0 };
    }
    const entry = byTerritory[tname];
    entry.total++;
    entry[row.prospect.status as keyof typeof entry]++;
    if (row.prospect.priority === "A") entry.priority_a++;
    else entry.priority_b++;
  }

  const byStatus: Record<string, number> = { new: 0, accepted: 0, rejected: 0, deferred: 0, pushed_to_hubspot: 0 };
  const byPartnerType: Record<string, number> = {};
  for (const row of all) {
    byStatus[row.prospect.status] = (byStatus[row.prospect.status] ?? 0) + 1;
    byPartnerType[row.prospect.partnerType] = (byPartnerType[row.prospect.partnerType] ?? 0) + 1;
  }

  res.json(GetProspectStatsResponse.parse({
    total: all.length,
    by_territory: Object.values(byTerritory),
    by_status: byStatus,
    by_partner_type: byPartnerType,
    week_over_week: 1.15,
  }));
});

router.get("/prospects", async (req, res): Promise<void> => {
  const { territory, pam_user_id, priority, partner_type, signal_type, status, search } = req.query as Record<string, string | undefined>;

  const rows = await db
    .select({
      prospect: prospectsTable,
      company: companiesTable,
      territory: territoriesTable,
      assignedUser: usersTable,
    })
    .from(prospectsTable)
    .leftJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(prospectsTable.assignedUserId, usersTable.id))
    .orderBy(sql`CASE WHEN ${prospectsTable.priority} = 'A' THEN 0 ELSE 1 END`, prospectsTable.createdAt);

  // Count signals per prospect
  const signalCounts = await db
    .select({ companyId: signalsTable.companyId, count: count() })
    .from(signalsTable)
    .groupBy(signalsTable.companyId);
  const signalCountMap = new Map(signalCounts.map((s) => [s.companyId, Number(s.count)]));

  let filtered = rows.filter((row) => row.company !== null);

  if (territory) {
    // support filter by territory name OR territory id
    filtered = filtered.filter((r) => r.territory?.name === territory || r.prospect.territoryId === territory);
  }
  if (pam_user_id) {
    filtered = filtered.filter((r) => r.prospect.assignedUserId === pam_user_id);
  }
  if (priority) {
    filtered = filtered.filter((r) => r.prospect.priority === priority);
  }
  if (partner_type) {
    filtered = filtered.filter((r) => r.prospect.partnerType === partner_type);
  }
  if (status) {
    filtered = filtered.filter((r) => r.prospect.status === status);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((r) =>
      r.company!.name.toLowerCase().includes(q) ||
      r.company!.domain.toLowerCase().includes(q) ||
      r.prospect.whyNow.toLowerCase().includes(q) ||
      r.prospect.whyItFits.toLowerCase().includes(q)
    );
  }

  const shaped = filtered.map((r) =>
    buildProspectShape(
      r.prospect,
      r.company!,
      r.territory ?? null,
      r.assignedUser ?? null,
      signalCountMap.get(r.prospect.companyId) ?? 0,
    )
  );

  res.json(ListProspectsResponse.parse(shaped));
});

router.get("/prospects/:id", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({
      prospect: prospectsTable,
      company: companiesTable,
      territory: territoriesTable,
      assignedUser: usersTable,
    })
    .from(prospectsTable)
    .leftJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(prospectsTable.assignedUserId, usersTable.id))
    .where(eq(prospectsTable.id, id));

  if (!row || !row.company) {
    res.status(404).json({ error: "Prospect not found" });
    return;
  }

  const signals = await db
    .select()
    .from(signalsTable)
    .where(eq(signalsTable.companyId, row.prospect.companyId))
    .orderBy(signalsTable.discoveredAt);

  const activityRows = await db
    .select({ activity: prospectActivityTable, actor: usersTable })
    .from(prospectActivityTable)
    .leftJoin(usersTable, eq(prospectActivityTable.actorUserId, usersTable.id))
    .where(eq(prospectActivityTable.prospectId, id))
    .orderBy(prospectActivityTable.timestamp);

  const base = buildProspectShape(
    row.prospect,
    row.company,
    row.territory ?? null,
    row.assignedUser ?? null,
    signals.length,
  );

  res.json(GetProspectResponse.parse({
    ...base,
    signals: signals.map((s) => ({
      id: s.id,
      company_id: s.companyId,
      signal_type: s.signalType,
      title: s.title,
      summary: s.summary,
      source_url: s.sourceUrl,
      source_domain: s.sourceDomain,
      published_at: s.publishedAt,
      discovered_at: s.discoveredAt.toISOString(),
      confidence: s.confidence,
      raw_excerpt: s.rawExcerpt,
    })),
    activity: activityRows.map((a) => ({
      id: a.activity.id,
      event_type: a.activity.eventType,
      timestamp: a.activity.timestamp.toISOString(),
      actor_name: a.actor?.name ?? null,
      note: a.activity.note,
    })),
  }));
});

router.post("/prospects/:id/decision", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = MakeProspectDecisionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { decision, rejection_reason, note, assigned_user_id } = parsed.data;

  const [existing] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Prospect not found" });
    return;
  }

  const updates: Partial<typeof prospectsTable.$inferInsert> = {
    status: decision,
    updatedAt: new Date(),
  };
  if (decision === "accepted") {
    updates.acceptedAt = new Date();
  }
  if (decision === "rejected" && rejection_reason) {
    updates.rejectionReason = rejection_reason;
  }
  if (note) {
    updates.pamNote = note;
  }
  if (assigned_user_id) {
    updates.assignedUserId = assigned_user_id;
  }

  const [updated] = await db
    .update(prospectsTable)
    .set(updates)
    .where(eq(prospectsTable.id, id))
    .returning();

  // Log activity
  await db.insert(prospectActivityTable).values({
    prospectId: id,
    eventType: decision,
    note: note ?? null,
    timestamp: new Date(),
  });

  // Fetch company and territory for response
  const [row] = await db
    .select({ company: companiesTable, territory: territoriesTable, assignedUser: usersTable })
    .from(companiesTable)
    .leftJoin(territoriesTable, eq(territoriesTable.id, updated.territoryId))
    .leftJoin(usersTable, eq(usersTable.id, updated.assignedUserId!))
    .where(eq(companiesTable.id, updated.companyId));

  const signalRows = await db.select({ count: count() }).from(signalsTable).where(eq(signalsTable.companyId, updated.companyId));
  const sigCount = Number(signalRows[0]?.count ?? 0);

  res.json(MakeProspectDecisionResponse.parse(
    buildProspectShape(updated, row.company, row.territory ?? null, row.assignedUser ?? null, sigCount)
  ));
});

router.post("/prospects/:id/hubspot", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [existing] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Prospect not found" });
    return;
  }
  if (existing.status !== "accepted" && existing.status !== "pushed_to_hubspot") {
    res.status(400).json({ error: "Prospect must be accepted before pushing to HubSpot" });
    return;
  }

  const mockId = `MOCK-${Math.floor(10000 + Math.random() * 90000)}`;

  await db
    .update(prospectsTable)
    .set({ status: "pushed_to_hubspot", hubspotCompanyId: mockId, updatedAt: new Date() })
    .where(eq(prospectsTable.id, id));

  await db.insert(prospectActivityTable).values({
    prospectId: id,
    eventType: "hubspot_pushed",
    note: `Mock push — HubSpot ID: ${mockId}`,
    timestamp: new Date(),
  });

  res.json(PushProspectToHubspotResponse.parse({
    status: "mock_success",
    hubspot_company_id: mockId,
    message: "Successfully added to HubSpot (mock mode)",
  }));
});

export default router;
