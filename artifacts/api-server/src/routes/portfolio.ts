import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  partnerRelationshipsTable,
  partnerRelationshipHistoryTable,
  partnerActivitiesTable,
  companiesTable,
  territoriesTable,
  usersTable,
  partnerRecruitmentsTable,
  channelRadarSignalsTable,
} from "@workspace/db";
import {
  ListPortfolioQueryParams,
  ListPortfolioResponse,
  CreatePortfolioRelationshipBody,
  CreatePortfolioRelationshipResponse,
  GetPortfolioRelationshipResponse,
  UpdatePortfolioRelationshipBody,
  UpdatePortfolioRelationshipResponse,
  TransitionPortfolioStatusBody,
  TransitionPortfolioStatusResponse,
  ReassignPortfolioRelationshipBody,
  ReassignPortfolioRelationshipResponse,
  AddPortfolioActivityBody,
  AddPortfolioActivityResponse,
  GetPortfolioSummaryQueryParams,
  GetPortfolioSummaryResponse,
} from "@workspace/api-zod";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, resolveScopedTerritory, ForbiddenScopeError } from "../services/authz";
import {
  createRelationshipIfMissing,
  transitionRelationshipStatus,
  reassignRelationshipOwner,
  ReassignmentTerritoryMismatchError,
  addActivity,
  InvalidRelationshipTransitionError,
  type RelationshipStatus,
} from "../services/partnerRelationshipService";
import { resolveCompanyMatch, normalizeCompanyName } from "../services/companyMatchingService";
import { backfillRadarSignalsForCompany } from "../services/radarCompanyBridge";
import { isActiveStage, type RecruitmentStage } from "../services/partnerRecruitmentService";
import { resolvePeriodRange, resolvePeriodKey, splitPeriodKey } from "../services/kpiRegistry";

const router: IRouter = Router();

function shapeCompany(c: typeof companiesTable.$inferSelect) {
  return { id: c.id, name: c.name, domain: c.domain, country: c.country };
}

function shapeAssignedUser(u: typeof usersTable.$inferSelect | null) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, territory: u.territory, location_label: u.locationLabel, timezone: u.timezone, active: u.active };
}

function shapeRelationship(
  r: typeof partnerRelationshipsTable.$inferSelect,
  company: typeof companiesTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
  assignedUser: typeof usersTable.$inferSelect | null,
) {
  return {
    id: r.id,
    company: shapeCompany(company),
    territory_id: r.territoryId,
    territory_name: territory?.name ?? null,
    assigned_user: shapeAssignedUser(assignedUser),
    status: r.status,
    partner_type: r.partnerType,
    strategic_importance: r.strategicImportance,
    relationship_summary: r.relationshipSummary,
    relationship_started_at: r.relationshipStartedAt,
    started_at_precision: r.startedAtPrecision,
    started_at_provenance: r.startedAtProvenance,
    relationship_ended_at: r.relationshipEndedAt,
    last_interaction_at: r.lastInteractionAt ? r.lastInteractionAt.toISOString() : null,
    next_action: r.nextAction,
    next_action_due_at: r.nextActionDueAt,
    origin_type: r.originType,
    origin_recruitment_id: r.originRecruitmentId,
    source_as_of_date: r.sourceAsOfDate,
    imported_at: r.importedAt ? r.importedAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

async function loadRelationshipRow(id: string) {
  const [row] = await db
    .select({ relationship: partnerRelationshipsTable, company: companiesTable, territory: territoriesTable, assignedUser: usersTable })
    .from(partnerRelationshipsTable)
    .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(partnerRelationshipsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(partnerRelationshipsTable.assignedUserId, usersTable.id))
    .where(eq(partnerRelationshipsTable.id, id));
  return row ?? null;
}

router.get("/portfolio/summary", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = GetPortfolioSummaryQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const actingUser = req.actingUser!;

  let target;
  try {
    target = await resolveScopedTerritory(actingUser, parsedQuery.data.territory);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const periodKey = resolvePeriodKey(parsedQuery.data.period);
  const periodInfo = resolvePeriodRange(periodKey);
  const periodGranularity: "quarter" | "year" = splitPeriodKey(periodKey)?.quarterKey === "ytd" ? "year" : "quarter";
  const periodStartMs = new Date(periodInfo.start).getTime();
  const periodEndMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();

  const [allRelationships, allRecruitments] = await Promise.all([
    db.select().from(partnerRelationshipsTable),
    db.select().from(partnerRecruitmentsTable),
  ]);

  const scopedRelationships = target.territoryId ? allRelationships.filter((r) => r.territoryId === target.territoryId) : allRelationships;
  const scopedRecruitments = target.territoryId ? allRecruitments.filter((r) => r.territoryId === target.territoryId) : allRecruitments;

  const activePartners = scopedRelationships.filter((r) => r.status === "active").length;

  const eligiblePrecisions =
    periodGranularity === "year" ? new Set(["exact_date", "month", "quarter", "year"]) : new Set(["exact_date", "month", "quarter"]);
  const newPartnersInPeriod = scopedRelationships.filter((r) => {
    if (!r.relationshipStartedAt || !eligiblePrecisions.has(r.startedAtPrecision)) return false;
    const startedMs = new Date(r.relationshipStartedAt).getTime();
    return startedMs >= periodStartMs && startedMs <= periodEndMs;
  }).length;

  const inRecruitment = scopedRecruitments.filter((r) => isActiveStage(r.stage as RecruitmentStage)).length;

  const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const needsAttention = scopedRelationships.filter((r) => {
    if (r.status !== "active") return false;
    if (r.nextAction) return false;
    const lastInteractionMs = r.lastInteractionAt ? r.lastInteractionAt.getTime() : null;
    return lastInteractionMs === null || lastInteractionMs < thirtyDaysAgoMs;
  }).length;

  res.json(
    GetPortfolioSummaryResponse.parse({
      period: periodInfo.label,
      active_partners: activePartners,
      new_partners_in_period: newPartnersInPeriod,
      in_recruitment: inRecruitment,
      needs_attention: needsAttention,
    }),
  );
});

router.get("/portfolio", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListPortfolioQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { territory, pam_user_id, status, search } = parsedQuery.data;
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
      res.status(403).json({ error: "You do not have access to that PAM's portfolio." });
      return;
    }
    scopedTerritoryId = own.territoryId;
  }

  const rows = await db
    .select({ relationship: partnerRelationshipsTable, company: companiesTable, territory: territoriesTable, assignedUser: usersTable })
    .from(partnerRelationshipsTable)
    .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(partnerRelationshipsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(partnerRelationshipsTable.assignedUserId, usersTable.id));

  let filtered = rows;
  if (scopedTerritoryId) {
    filtered = filtered.filter((r) => r.relationship.territoryId === scopedTerritoryId);
  } else if (territory) {
    filtered = filtered.filter((r) => r.territory?.name === territory || r.relationship.territoryId === territory);
  }
  if (pam_user_id) {
    filtered = filtered.filter((r) => r.relationship.assignedUserId === pam_user_id);
  }
  if (status) {
    filtered = filtered.filter((r) => r.relationship.status === status);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((r) => r.company.name.toLowerCase().includes(q) || (r.company.domain ?? "").toLowerCase().includes(q));
  }

  const shaped = filtered.map((r) => shapeRelationship(r.relationship, r.company, r.territory, r.assignedUser));
  res.json(ListPortfolioResponse.parse(shaped));
});

router.post("/portfolio", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreatePortfolioRelationshipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const actingUser = req.actingUser!;

  try {
    await assertRecordTerritoryAccess(actingUser, data.territory_id, null);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  if (!data.company_id && !data.new_company) {
    res.status(400).json({ error: "Provide either company_id or new_company." });
    return;
  }
  if (data.company_id && data.new_company) {
    res.status(400).json({ error: "Provide only one of company_id or new_company." });
    return;
  }

  let companyId = data.company_id ?? null;
  if (!companyId && data.new_company) {
    const match = await resolveCompanyMatch(
      { name: data.new_company.name, domain: data.new_company.domain ?? null, country: data.new_company.country },
      data.territory_id,
    );
    if (match.status === "invalid") {
      res.status(400).json({ error: "Company name is required." });
      return;
    }
    if (match.status === "possible_duplicate") {
      res.status(400).json({ error: "Multiple similar companies already exist. Use company search to select the correct one instead." });
      return;
    }
    if (match.status === "matched_existing_company" && match.matchedCompanyId) {
      companyId = match.matchedCompanyId;
    } else {
      const [newCompany] = await db
        .insert(companiesTable)
        .values({
          name: data.new_company.name,
          normalizedName: normalizeCompanyName(data.new_company.name),
          // Never a fabricated placeholder -- null when the PAM doesn't know it.
          domain: data.new_company.domain?.trim() || null,
          country: data.new_company.country,
        })
        .returning();
      companyId = newCompany!.id;
    }
    // Best-effort, deterministic-only -- resolves any previously-unlinked
    // Radar signals now that this company canonically exists. Never blocks
    // the response on failure.
    backfillRadarSignalsForCompany(companyId, data.new_company.name).catch(() => {});
  }

  let assignedUserId = data.assigned_user_id ?? null;
  if (!isGlobalUser(actingUser)) {
    if (assignedUserId && assignedUserId !== actingUser.id) {
      res.status(403).json({ error: "You can only create relationships assigned to yourself." });
      return;
    }
    assignedUserId = assignedUserId ?? actingUser.id;
  }

  const { relationship } = await createRelationshipIfMissing(
    {
      companyId: companyId!,
      territoryId: data.territory_id,
      assignedUserId,
      status: data.status ?? "active",
      partnerType: data.partner_type ?? null,
      strategicImportance: data.strategic_importance ?? null,
      relationshipSummary: data.relationship_summary ?? null,
      relationshipStartedAt: data.relationship_started_at ?? null,
      startedAtPrecision: data.started_at_precision ?? (data.relationship_started_at ? "exact_date" : "unknown"),
      startedAtProvenance: data.started_at_provenance ?? (data.relationship_started_at ? "explicit" : null),
      nextAction: data.next_action ?? null,
      nextActionDueAt: data.next_action_due_at ?? null,
      originType: "manual",
    },
    actingUser.id,
  );

  const row = await loadRelationshipRow(relationship.id);
  res.json(CreatePortfolioRelationshipResponse.parse(shapeRelationship(row!.relationship, row!.company, row!.territory, row!.assignedUser)));
});

router.get("/portfolio/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const row = await loadRelationshipRow(id);
  if (!row) {
    res.status(404).json({ error: "Partner relationship not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, row.relationship.territoryId, row.territory?.name);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [historyRows, activityRows, recruitmentRows, radarSignalRows] = await Promise.all([
    db
      .select({ history: partnerRelationshipHistoryTable })
      .from(partnerRelationshipHistoryTable)
      .where(eq(partnerRelationshipHistoryTable.relationshipId, id))
      .orderBy(desc(partnerRelationshipHistoryTable.occurredAt)),
    db
      .select({ activity: partnerActivitiesTable, actor: usersTable })
      .from(partnerActivitiesTable)
      .leftJoin(usersTable, eq(partnerActivitiesTable.actorUserId, usersTable.id))
      .where(eq(partnerActivitiesTable.relationshipId, id))
      .orderBy(desc(partnerActivitiesTable.occurredAt)),
    db
      .select()
      .from(partnerRecruitmentsTable)
      .where(eq(partnerRecruitmentsTable.companyId, row.relationship.companyId))
      .orderBy(desc(partnerRecruitmentsTable.updatedAt)),
    db
      .select()
      .from(channelRadarSignalsTable)
      .where(eq(channelRadarSignalsTable.companyId, row.relationship.companyId))
      .orderBy(desc(channelRadarSignalsTable.discoveredAt))
      .limit(5),
  ]);

  // History rows need from/to/changed-by user names resolved separately
  // (three independent nullable FKs on one row -- a single multi-join would
  // ambiguously alias usersTable three times) -- small dataset, resolved
  // via one lookup map.
  const userIds = new Set<string>();
  for (const h of historyRows) {
    if (h.history.fromUserId) userIds.add(h.history.fromUserId);
    if (h.history.toUserId) userIds.add(h.history.toUserId);
    if (h.history.changedByUserId) userIds.add(h.history.changedByUserId);
  }
  const userRows = userIds.size ? await db.select().from(usersTable) : [];
  const userNameById = new Map(userRows.filter((u) => userIds.has(u.id)).map((u) => [u.id, u.name]));

  const latestRecruitment = recruitmentRows[0] ?? null;

  res.json(
    GetPortfolioRelationshipResponse.parse({
      ...shapeRelationship(row.relationship, row.company, row.territory, row.assignedUser),
      history: historyRows.map((h) => ({
        id: h.history.id,
        event_type: h.history.eventType,
        from_status: h.history.fromStatus,
        to_status: h.history.toStatus,
        from_user_name: h.history.fromUserId ? userNameById.get(h.history.fromUserId) ?? null : null,
        to_user_name: h.history.toUserId ? userNameById.get(h.history.toUserId) ?? null : null,
        source_recruitment_id: h.history.sourceRecruitmentId,
        note: h.history.note,
        changed_by_name: h.history.changedByUserId ? userNameById.get(h.history.changedByUserId) ?? null : null,
        occurred_at: h.history.occurredAt.toISOString(),
        created_at: h.history.createdAt.toISOString(),
      })),
      activities: activityRows.map((a) => ({
        id: a.activity.id,
        activity_type: a.activity.activityType,
        note: a.activity.note,
        actor_name: a.actor?.name ?? null,
        occurred_at: a.activity.occurredAt.toISOString(),
        created_at: a.activity.createdAt.toISOString(),
      })),
      context: {
        related_recruitment: latestRecruitment
          ? {
              id: latestRecruitment.id,
              stage: latestRecruitment.stage,
              not_pursuing_reason: latestRecruitment.notPursuingReason,
              updated_at: latestRecruitment.updatedAt.toISOString(),
            }
          : null,
        related_radar_signals: radarSignalRows.map((s) => ({
          id: s.id,
          headline: s.headline,
          signal_type: s.signalType,
          discovered_at: s.discoveredAt.toISOString(),
        })),
      },
    }),
  );
});

router.patch("/portfolio/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdatePortfolioRelationshipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Partner relationship not found" });
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
  const updates: Partial<typeof partnerRelationshipsTable.$inferInsert> = { updatedAt: new Date() };
  if (data.partner_type !== undefined) updates.partnerType = data.partner_type;
  if (data.strategic_importance !== undefined) updates.strategicImportance = data.strategic_importance;
  if (data.relationship_summary !== undefined) updates.relationshipSummary = data.relationship_summary;
  if (data.next_action !== undefined) updates.nextAction = data.next_action;
  if (data.next_action_due_at !== undefined) updates.nextActionDueAt = data.next_action_due_at;

  await db.update(partnerRelationshipsTable).set(updates).where(eq(partnerRelationshipsTable.id, id));

  const row = await loadRelationshipRow(id);
  res.json(UpdatePortfolioRelationshipResponse.parse(shapeRelationship(row!.relationship, row!.company, row!.territory, row!.assignedUser)));
});

router.post("/portfolio/:id/status", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = TransitionPortfolioStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Partner relationship not found" });
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
    updated = await transitionRelationshipStatus(id, parsed.data.status as RelationshipStatus, req.actingUser!.id, {
      occurredAt: parsed.data.occurred_at ? new Date(parsed.data.occurred_at) : undefined,
      note: parsed.data.note,
    });
  } catch (err) {
    if (err instanceof InvalidRelationshipTransitionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  if (!updated) {
    res.status(404).json({ error: "Partner relationship not found" });
    return;
  }

  const row = await loadRelationshipRow(id);
  res.json(TransitionPortfolioStatusResponse.parse(shapeRelationship(row!.relationship, row!.company, row!.territory, row!.assignedUser)));
});

router.post("/portfolio/:id/reassign", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isGlobalUser(req.actingUser!)) {
    res.status(403).json({ error: "Only Head of Channels/admin can reassign ownership." });
    return;
  }

  const parsed = ReassignPortfolioRelationshipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let updated;
  try {
    updated = await reassignRelationshipOwner(id, parsed.data.assigned_user_id, req.actingUser!.id);
  } catch (err) {
    if (err instanceof ReassignmentTerritoryMismatchError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  if (!updated) {
    res.status(404).json({ error: "Partner relationship not found" });
    return;
  }

  const row = await loadRelationshipRow(id);
  res.json(ReassignPortfolioRelationshipResponse.parse(shapeRelationship(row!.relationship, row!.company, row!.territory, row!.assignedUser)));
});

router.post("/portfolio/:id/activities", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = AddPortfolioActivityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Partner relationship not found" });
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

  const activity = await addActivity({
    relationshipId: id,
    activityType: parsed.data.activity_type,
    note: parsed.data.note,
    occurredAt: new Date(parsed.data.occurred_at),
    actorUserId: req.actingUser!.id,
  });

  res.json(
    AddPortfolioActivityResponse.parse({
      id: activity.id,
      activity_type: activity.activityType,
      note: activity.note,
      actor_name: req.actingUser!.name,
      occurred_at: activity.occurredAt.toISOString(),
      created_at: activity.createdAt.toISOString(),
    }),
  );
});

export default router;
