import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  partnerRecruitmentsTable,
  partnerRecruitmentHistoryTable,
  prospectsTable,
  companiesTable,
  territoriesTable,
  usersTable,
  signalsTable,
} from "@workspace/db";
import {
  ListRecruitmentsQueryParams,
  ListRecruitmentsResponse,
  GetRecruitmentResponse,
  TransitionRecruitmentBody,
  TransitionRecruitmentResponse,
  UpdateRecruitmentBody,
  UpdateRecruitmentResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, ForbiddenScopeError } from "../services/authz";
import {
  computeDaysInStage,
  isStalled,
  getNextStageAction,
  transitionRecruitmentStage,
  InvalidTransitionError,
  type RecruitmentStage,
} from "../services/partnerRecruitmentService";

const router: IRouter = Router();

function shapeAssignedUser(u: typeof usersTable.$inferSelect | null) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, territory: u.territory, location_label: u.locationLabel, timezone: u.timezone, active: u.active };
}

// Shared by list and detail -- the row already carries everything needed
// for the summary shape; detail just adds the discovery/signals/history
// sections on top.
function shapeRecruitmentSummary(
  r: typeof partnerRecruitmentsTable.$inferSelect,
  company: typeof companiesTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
  assignedUser: typeof usersTable.$inferSelect | null,
  prospect: typeof prospectsTable.$inferSelect,
) {
  const daysInStage = computeDaysInStage(r.stageEnteredAt);
  const nextAction = getNextStageAction(r.stage as RecruitmentStage);
  return {
    id: r.id,
    prospect_id: r.prospectId,
    company: { id: company.id, name: company.name, domain: company.domain },
    territory_id: r.territoryId,
    territory_name: territory?.name ?? null,
    assigned_user: shapeAssignedUser(assignedUser),
    priority: prospect.priority,
    partner_type: prospect.partnerType,
    stage: r.stage,
    previous_stage: r.previousStage,
    not_pursuing_reason: r.notPursuingReason,
    next_step: r.nextStep,
    follow_up_date: r.followUpDate,
    days_in_stage: daysInStage,
    is_stalled: isStalled(r.stage, daysInStage),
    next_stage_action: nextAction ? { stage: nextAction.stage, label: nextAction.label } : null,
    stage_entered_at: r.stageEnteredAt.toISOString(),
    signed_at: r.signedAt ? r.signedAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

router.get("/recruitment", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListRecruitmentsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { territory, pam_user_id, stage, search } = parsedQuery.data;
  const actingUser = req.actingUser!;

  let scopedTerritoryId: string | null = null;
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    if (territory && territory !== own.territoryId && territory !== own.territoryName) {
      res.status(403).json({ error: "You do not have access to that territory." });
      return;
    }
    if (pam_user_id && pam_user_id !== actingUser.id) {
      res.status(403).json({ error: "You do not have access to that PAM's recruitment pipeline." });
      return;
    }
    scopedTerritoryId = own.territoryId;
  }

  const rows = await db
    .select({
      recruitment: partnerRecruitmentsTable,
      company: companiesTable,
      territory: territoriesTable,
      assignedUser: usersTable,
      prospect: prospectsTable,
    })
    .from(partnerRecruitmentsTable)
    .innerJoin(companiesTable, eq(partnerRecruitmentsTable.companyId, companiesTable.id))
    .innerJoin(prospectsTable, eq(partnerRecruitmentsTable.prospectId, prospectsTable.id))
    .leftJoin(territoriesTable, eq(partnerRecruitmentsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(partnerRecruitmentsTable.assignedUserId, usersTable.id));

  let filtered = rows;
  if (scopedTerritoryId) {
    filtered = filtered.filter((r) => r.recruitment.territoryId === scopedTerritoryId);
  } else if (territory) {
    filtered = filtered.filter((r) => r.territory?.name === territory || r.recruitment.territoryId === territory);
  }
  if (pam_user_id) {
    filtered = filtered.filter((r) => r.recruitment.assignedUserId === pam_user_id);
  }
  if (stage) {
    filtered = filtered.filter((r) => r.recruitment.stage === stage);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((r) => r.company.name.toLowerCase().includes(q) || r.company.domain.toLowerCase().includes(q));
  }

  const shaped = filtered.map((r) => shapeRecruitmentSummary(r.recruitment, r.company, r.territory, r.assignedUser, r.prospect));
  res.json(ListRecruitmentsResponse.parse(shaped));
});

router.get("/recruitment/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({
      recruitment: partnerRecruitmentsTable,
      company: companiesTable,
      territory: territoriesTable,
      assignedUser: usersTable,
      prospect: prospectsTable,
    })
    .from(partnerRecruitmentsTable)
    .innerJoin(companiesTable, eq(partnerRecruitmentsTable.companyId, companiesTable.id))
    .innerJoin(prospectsTable, eq(partnerRecruitmentsTable.prospectId, prospectsTable.id))
    .leftJoin(territoriesTable, eq(partnerRecruitmentsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(partnerRecruitmentsTable.assignedUserId, usersTable.id))
    .where(eq(partnerRecruitmentsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Recruitment not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, row.recruitment.territoryId, row.territory?.name);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [signals, historyRows] = await Promise.all([
    db.select().from(signalsTable).where(eq(signalsTable.companyId, row.recruitment.companyId)).orderBy(signalsTable.discoveredAt),
    db
      .select({ history: partnerRecruitmentHistoryTable, actor: usersTable })
      .from(partnerRecruitmentHistoryTable)
      .leftJoin(usersTable, eq(partnerRecruitmentHistoryTable.changedByUserId, usersTable.id))
      .where(eq(partnerRecruitmentHistoryTable.recruitmentId, id))
      .orderBy(partnerRecruitmentHistoryTable.createdAt),
  ]);

  const base = shapeRecruitmentSummary(row.recruitment, row.company, row.territory, row.assignedUser, row.prospect);

  res.json(GetRecruitmentResponse.parse({
    ...base,
    why_it_fits: row.prospect.whyItFits,
    why_now: row.prospect.whyNow,
    suggested_angle: row.prospect.suggestedAngle,
    suggested_target_role: row.prospect.suggestedTargetRole,
    priority_rationale: row.prospect.priorityRationale,
    enterprise_access: row.prospect.enterpriseAccess,
    relevant_capability: row.prospect.relevantCapability,
    technology_adjacency: row.prospect.technologyAdjacency,
    partnership_openness: row.prospect.partnershipOpenness,
    recent_trigger: row.prospect.recentTrigger,
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
    history: historyRows.map((h) => ({
      id: h.history.id,
      from_stage: h.history.fromStage,
      to_stage: h.history.toStage,
      note: h.history.note,
      actor_name: h.actor?.name ?? null,
      created_at: h.history.createdAt.toISOString(),
    })),
  }));
});

router.post("/recruitment/:id/transition", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = TransitionRecruitmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Recruitment not found" });
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

  let updated;
  try {
    updated = await transitionRecruitmentStage(id, parsed.data.to_stage as RecruitmentStage, req.actingUser!.id, {
      note: parsed.data.note,
      notPursuingReason: parsed.data.not_pursuing_reason,
    });
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  if (!updated) {
    res.status(404).json({ error: "Recruitment not found" });
    return;
  }

  const [row] = await db
    .select({ company: companiesTable, territory: territoriesTable, assignedUser: usersTable, prospect: prospectsTable })
    .from(companiesTable)
    .innerJoin(prospectsTable, eq(prospectsTable.id, updated.prospectId))
    .leftJoin(territoriesTable, eq(territoriesTable.id, updated.territoryId))
    .leftJoin(usersTable, eq(usersTable.id, updated.assignedUserId!))
    .where(eq(companiesTable.id, updated.companyId));

  res.json(TransitionRecruitmentResponse.parse(shapeRecruitmentSummary(updated, row.company, row.territory ?? null, row.assignedUser ?? null, row.prospect)));
});

router.patch("/recruitment/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateRecruitmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Recruitment not found" });
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

  const data = parsed.data;
  const updates: Partial<typeof partnerRecruitmentsTable.$inferInsert> = { updatedAt: new Date() };
  if (data.next_step !== undefined) updates.nextStep = data.next_step;
  if (data.follow_up_date !== undefined) updates.followUpDate = data.follow_up_date;

  const [updated] = await db.update(partnerRecruitmentsTable).set(updates).where(eq(partnerRecruitmentsTable.id, id)).returning();

  const [row] = await db
    .select({ company: companiesTable, territory: territoriesTable, assignedUser: usersTable, prospect: prospectsTable })
    .from(companiesTable)
    .innerJoin(prospectsTable, eq(prospectsTable.id, updated!.prospectId))
    .leftJoin(territoriesTable, eq(territoriesTable.id, updated!.territoryId))
    .leftJoin(usersTable, eq(usersTable.id, updated!.assignedUserId!))
    .where(eq(companiesTable.id, updated!.companyId));

  res.json(UpdateRecruitmentResponse.parse(shapeRecruitmentSummary(updated!, row.company, row.territory ?? null, row.assignedUser ?? null, row.prospect)));
});

export default router;
