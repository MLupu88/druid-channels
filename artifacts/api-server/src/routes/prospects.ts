import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  prospectsTable,
  companiesTable,
  territoriesTable,
  usersTable,
  signalsTable,
  prospectActivityTable,
  scanConfigsTable,
} from "@workspace/db";
import {
  ListProspectsQueryParams,
  ListProspectsResponse,
  GetProspectResponse,
  MakeProspectDecisionBody,
  MakeProspectDecisionResponse,
  PushProspectToHubspotResponse,
  GetProspectStatsResponse,
  ListRecentProspectActivityQueryParams,
  ListRecentProspectActivityResponse,
  UpdateProspectBody,
  UpdateProspectResponse,
  DeleteProspectBody,
  DeleteProspectResponse,
} from "@workspace/api-zod";
import { eq, and, gte, sql, count, max, inArray, desc, asc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, assertOwnUserAccess, ForbiddenScopeError } from "../services/authz";
import { acceptForRecruitment, assertProspectHasNoRecruitment, ProspectHasRecruitmentError } from "../services/partnerRecruitmentService";
import { excludeCompanyForTerritory } from "../services/discoveryExclusions";

const router: IRouter = Router();

const DEFAULT_RECENCY_WINDOW_DAYS = 90;

type NextAction = "review" | "refresh_evidence" | "send_to_hubspot" | "none";

function computeNextAction(status: string, isStale: boolean): NextAction {
  // Discovery's job ends at acceptance -- what happens next lives in
  // Recruitment (see partnerRecruitmentService.ts's getNextStageAction),
  // not here. "send_to_hubspot" is kept in the NextAction type only for the
  // legacy pushed_to_hubspot display path; nothing maps to it anymore.
  if (status === "accepted" || status === "pushed_to_hubspot" || status === "rejected") return "none";
  // "new" or "deferred"
  return isStale ? "refresh_evidence" : "review";
}

// freshnessDays reflects actual research/evidence activity only -- never a
// generic record edit. If there's no research timestamp and no signal yet,
// freshness is unknown (null) and the prospect is treated as needing a
// refresh rather than fabricated as "fresh" just because the row is new.
function computeFreshness(
  lastResearchedAt: Date | null,
  latestSignalAt: Date | null,
  recencyWindowDays: number,
): { freshnessDays: number | null; isStale: boolean } {
  const candidates = [lastResearchedAt, latestSignalAt].filter((d): d is Date => d !== null);
  if (candidates.length === 0) {
    return { freshnessDays: null, isStale: true };
  }
  const reference = candidates.reduce((latest, d) => (d > latest ? d : latest));
  const freshnessDays = Math.max(0, Math.floor((Date.now() - reference.getTime()) / 86_400_000));
  return { freshnessDays, isStale: freshnessDays > recencyWindowDays };
}

// One scan config is expected per territory, but this stays deterministic
// even if that's ever violated: prefer the active config, tie-broken by id,
// rather than depending on incidental DB row order.
async function loadRecencyWindowsByTerritory(territoryIds: string[]): Promise<Map<string, number>> {
  if (territoryIds.length === 0) return new Map();
  const rows = await db
    .select({
      territoryId: scanConfigsTable.territoryId,
      recencyWindowDays: scanConfigsTable.recencyWindowDays,
    })
    .from(scanConfigsTable)
    .where(inArray(scanConfigsTable.territoryId, territoryIds))
    .orderBy(desc(scanConfigsTable.active), asc(scanConfigsTable.id));
  const byTerritory = new Map<string, number>();
  for (const row of rows) {
    if (!byTerritory.has(row.territoryId)) byTerritory.set(row.territoryId, row.recencyWindowDays);
  }
  return byTerritory;
}

async function getSignalStatsForCompany(companyId: string): Promise<{ count: number; latestAt: Date | null }> {
  const [row] = await db
    .select({ count: count(), latest: max(signalsTable.discoveredAt) })
    .from(signalsTable)
    .where(eq(signalsTable.companyId, companyId));
  return { count: Number(row?.count ?? 0), latestAt: row?.latest ?? null };
}

async function loadSignalTypesByCompany(companyIds: string[]): Promise<Map<string, Set<string>>> {
  if (companyIds.length === 0) return new Map();
  const rows = await db
    .select({ companyId: signalsTable.companyId, signalType: signalsTable.signalType })
    .from(signalsTable)
    .where(inArray(signalsTable.companyId, companyIds));
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!map.has(row.companyId)) map.set(row.companyId, new Set());
    map.get(row.companyId)!.add(row.signalType);
  }
  return map;
}

async function loadLatestSignalByCompany(companyIds: string[]): Promise<Map<string, Date>> {
  if (companyIds.length === 0) return new Map();
  const rows = await db
    .select({ companyId: signalsTable.companyId, latest: max(signalsTable.discoveredAt) })
    .from(signalsTable)
    .where(inArray(signalsTable.companyId, companyIds))
    .groupBy(signalsTable.companyId);
  return new Map(rows.map((r) => [r.companyId, r.latest!]));
}

function buildProspectShape(
  p: typeof prospectsTable.$inferSelect,
  company: typeof companiesTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
  assignedUser: typeof usersTable.$inferSelect | null,
  signalCount: number,
  latestSignalAt: Date | null,
  recencyWindowDays: number,
) {
  const { freshnessDays, isStale } = computeFreshness(p.lastResearchedAt ?? null, latestSignalAt, recencyWindowDays);
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
          location_label: assignedUser.locationLabel,
          timezone: assignedUser.timezone,
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
    priority_rationale: p.priorityRationale,
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
    freshness_days: freshnessDays,
    is_stale: isStale,
    next_action: computeNextAction(p.status, isStale),
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt?.toISOString() ?? null,
  };
}

router.get("/prospects/stats/summary", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  let ownTerritoryId: string | null = null;
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    ownTerritoryId = own.territoryId;
  }

  const allRows = await db
    .select({
      prospect: prospectsTable,
      territory: territoriesTable,
    })
    .from(prospectsTable)
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id));
  const all = ownTerritoryId ? allRows.filter((r) => r.prospect.territoryId === ownTerritoryId) : allRows;

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
    // No prospect history is compared here, so there is no week-over-week
    // figure to report -- null, never a fabricated ratio.
    week_over_week: null,
  }));
});

// Phase 4: powers the PAM Overview "Your Actions" recent-activity feed.
// Reuses prospect_activity (the existing activity/history abstraction) --
// no new table. Assignment-scoped for a PAM (their own prospects only,
// same convention as GET /prospects), unscoped for Head/Admin -- though
// this is a PAM-only UI feature today, so the frontend never calls this for
// a global user. Bounded to a small fixed count either way.
const RECENT_ACTIVITY_LIMIT = 20;
const RECENT_ACTIVITY_DEFAULT_DAYS = 7;

router.get("/prospects/activity/recent", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListRecentProspectActivityQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const actingUser = req.actingUser!;
  const days = parsedQuery.data.days ?? RECENT_ACTIVITY_DEFAULT_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ activity: prospectActivityTable, prospect: prospectsTable, company: companiesTable, actor: usersTable })
    .from(prospectActivityTable)
    .innerJoin(prospectsTable, eq(prospectActivityTable.prospectId, prospectsTable.id))
    .innerJoin(companiesTable, eq(prospectsTable.companyId, companiesTable.id))
    .leftJoin(usersTable, eq(prospectActivityTable.actorUserId, usersTable.id))
    .where(gte(prospectActivityTable.timestamp, since))
    .orderBy(desc(prospectActivityTable.timestamp));

  const scoped = isGlobalUser(actingUser) ? rows : rows.filter((r) => r.prospect.assignedUserId === actingUser.id);

  res.json(ListRecentProspectActivityResponse.parse(
    scoped.slice(0, RECENT_ACTIVITY_LIMIT).map((r) => ({
      id: r.activity.id,
      prospect_id: r.prospect.id,
      company_name: r.company.name,
      event_type: r.activity.eventType,
      timestamp: r.activity.timestamp.toISOString(),
      actor_name: r.actor?.name ?? null,
      note: r.activity.note,
    }))
  ));
});

router.get("/prospects", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListProspectsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { territory, pam_user_id, priority, partner_type, signal_type, status, search, next_action, freshness } = parsedQuery.data;
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
      res.status(403).json({ error: "You do not have access to that PAM's prospects." });
      return;
    }
    scopedTerritoryId = own.territoryId;
  }

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

  if (scopedTerritoryId) {
    // Role-separation hotfix: a PAM sees only prospects explicitly assigned
    // to them by Head/Admin -- territory membership alone is no longer
    // sufficient (a prospect can sit in a PAM's own territory, discovered
    // but not yet reviewed/pushed to anyone). Hard-scoped regardless of any
    // client-supplied filter (including pam_user_id, which can never widen
    // this for a non-global caller -- see the check above).
    filtered = filtered.filter((r) => r.prospect.territoryId === scopedTerritoryId && r.prospect.assignedUserId === actingUser.id);
  } else if (territory) {
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
      (r.company!.domain ?? "").toLowerCase().includes(q) ||
      r.prospect.whyNow.toLowerCase().includes(q) ||
      r.prospect.whyItFits.toLowerCase().includes(q)
    );
  }
  if (signal_type) {
    // A prospect matches if its company has at least one signal of this
    // type -- signals are recorded per-company (evidence can predate or
    // outlive any single prospect decision), not per-prospect.
    const candidateCompanyIds = [...new Set(filtered.map((r) => r.prospect.companyId))];
    const signalTypesByCompany = await loadSignalTypesByCompany(candidateCompanyIds);
    filtered = filtered.filter((r) => signalTypesByCompany.get(r.prospect.companyId)?.has(signal_type));
  }

  const companyIds = [...new Set(filtered.map((r) => r.prospect.companyId))];
  const territoryIds = [...new Set(filtered.map((r) => r.prospect.territoryId))];
  const [latestSignalByCompany, recencyWindowsByTerritory] = await Promise.all([
    loadLatestSignalByCompany(companyIds),
    loadRecencyWindowsByTerritory(territoryIds),
  ]);

  let shaped = filtered.map((r) =>
    buildProspectShape(
      r.prospect,
      r.company!,
      r.territory ?? null,
      r.assignedUser ?? null,
      signalCountMap.get(r.prospect.companyId) ?? 0,
      latestSignalByCompany.get(r.prospect.companyId) ?? null,
      recencyWindowsByTerritory.get(r.prospect.territoryId) ?? DEFAULT_RECENCY_WINDOW_DAYS,
    )
  );

  if (next_action) {
    shaped = shaped.filter((p) => p.next_action === next_action);
  }
  if (freshness === "stale") {
    shaped = shaped.filter((p) => p.is_stale);
  } else if (freshness === "fresh") {
    shaped = shaped.filter((p) => !p.is_stale);
  }

  res.json(ListProspectsResponse.parse(shaped));
});

router.get("/prospects/:id", requireAuth, async (req, res): Promise<void> => {
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

  try {
    await assertRecordTerritoryAccess(req.actingUser!, row.prospect.territoryId, row.territory?.name);
    // Role-separation hotfix: territory membership alone is no longer
    // sufficient for a PAM -- the prospect must be explicitly assigned to
    // them. A 404 (not 403) here, matching "not found" rather than
    // confirming a real-but-unassigned prospect exists in their territory.
    assertOwnUserAccess(req.actingUser!, row.prospect.assignedUserId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }
    throw err;
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

  const latestSignalAt = signals.reduce<Date | null>((latest, s) => (!latest || s.discoveredAt > latest ? s.discoveredAt : latest), null);
  const recencyWindowsByTerritory = await loadRecencyWindowsByTerritory([row.prospect.territoryId]);

  const base = buildProspectShape(
    row.prospect,
    row.company,
    row.territory ?? null,
    row.assignedUser ?? null,
    signals.length,
    latestSignalAt,
    recencyWindowsByTerritory.get(row.prospect.territoryId) ?? DEFAULT_RECENCY_WINDOW_DAYS,
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

router.post("/prospects/:id/decision", requireAuth, async (req, res): Promise<void> => {
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

  try {
    await assertRecordTerritoryAccess(req.actingUser!, existing.territoryId, null);
    // Role-separation hotfix: a PAM may only decide (accept/reject/defer) on
    // prospects explicitly assigned to them -- territory membership alone is
    // not enough. Head/admin are exempt via assertOwnUserAccess itself.
    assertOwnUserAccess(req.actingUser!, existing.assignedUserId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
  // Role-separation hotfix: assignment/reassignment is Head/Admin-only --
  // a PAM can no longer even self-assign. The decision field itself
  // (accept/reject/defer) remains available to a PAM on their own
  // assigned prospect, handled separately below.
  if (!isGlobalUser(req.actingUser!) && assigned_user_id) {
    res.status(403).json({ error: "Only Head of Channels or Admin can assign a prospect." });
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

  // Discovery -> Recruitment handoff: "Accept for Recruitment". Uses
  // updated.assignedUserId (the final, already-preserved PAM -- never the
  // acting user) so the handoff can never silently reassign ownership.
  // Idempotent: a repeated accept on an already-handed-off prospect is a
  // no-op here, never a duplicate or a reset back to "accepted".
  if (decision === "accepted") {
    await acceptForRecruitment(
      { id: updated.id, companyId: updated.companyId, territoryId: updated.territoryId, assignedUserId: updated.assignedUserId },
      req.actingUser!.id,
    );
  }

  // Fetch company and territory for response
  const [row] = await db
    .select({ company: companiesTable, territory: territoriesTable, assignedUser: usersTable })
    .from(companiesTable)
    .leftJoin(territoriesTable, eq(territoriesTable.id, updated.territoryId))
    .leftJoin(usersTable, eq(usersTable.id, updated.assignedUserId!))
    .where(eq(companiesTable.id, updated.companyId));

  const [signalStats, recencyWindowsByTerritory] = await Promise.all([
    getSignalStatsForCompany(updated.companyId),
    loadRecencyWindowsByTerritory([updated.territoryId]),
  ]);

  res.json(MakeProspectDecisionResponse.parse(
    buildProspectShape(
      updated,
      row.company,
      row.territory ?? null,
      row.assignedUser ?? null,
      signalStats.count,
      signalStats.latestAt,
      recencyWindowsByTerritory.get(updated.territoryId) ?? DEFAULT_RECENCY_WINDOW_DAYS,
    )
  ));
});

router.patch("/prospects/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateProspectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Prospect not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, existing.territoryId, null);
    // Role-separation hotfix: a PAM may only edit prospects explicitly
    // assigned to them -- territory membership alone is not enough.
    assertOwnUserAccess(req.actingUser!, existing.assignedUserId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
  // Role-separation hotfix: assignment/reassignment is Head/Admin-only --
  // a PAM can no longer even self-assign. All other editable fields below
  // (why_it_fits, pam_note, priority, etc.) remain available to a PAM on
  // their own assigned prospect.
  if (!isGlobalUser(req.actingUser!) && parsed.data.assigned_user_id !== undefined) {
    res.status(403).json({ error: "Only Head of Channels or Admin can assign a prospect." });
    return;
  }

  const data = parsed.data;
  const updates: Partial<typeof prospectsTable.$inferInsert> = { updatedAt: new Date() };
  if (data.why_it_fits !== undefined) updates.whyItFits = data.why_it_fits;
  if (data.why_now !== undefined) updates.whyNow = data.why_now;
  if (data.suggested_angle !== undefined) updates.suggestedAngle = data.suggested_angle;
  if (data.suggested_target_role !== undefined) updates.suggestedTargetRole = data.suggested_target_role;
  if (data.suggested_message !== undefined) updates.suggestedMessage = data.suggested_message;
  if (data.pam_note !== undefined) updates.pamNote = data.pam_note;
  if (data.priority !== undefined) updates.priority = data.priority;
  if (data.assigned_user_id !== undefined) updates.assignedUserId = data.assigned_user_id;

  const [updated] = await db
    .update(prospectsTable)
    .set(updates)
    .where(eq(prospectsTable.id, id))
    .returning();

  await db.insert(prospectActivityTable).values({
    prospectId: id,
    eventType: "note_added",
    note: "Prospect details edited",
    timestamp: new Date(),
  });

  const [row] = await db
    .select({ company: companiesTable, territory: territoriesTable, assignedUser: usersTable })
    .from(companiesTable)
    .leftJoin(territoriesTable, eq(territoriesTable.id, updated.territoryId))
    .leftJoin(usersTable, eq(usersTable.id, updated.assignedUserId!))
    .where(eq(companiesTable.id, updated.companyId));

  const [signalStats, recencyWindowsByTerritory] = await Promise.all([
    getSignalStatsForCompany(updated.companyId),
    loadRecencyWindowsByTerritory([updated.territoryId]),
  ]);

  res.json(UpdateProspectResponse.parse(
    buildProspectShape(
      updated,
      row.company,
      row.territory ?? null,
      row.assignedUser ?? null,
      signalStats.count,
      signalStats.latestAt,
      recencyWindowsByTerritory.get(updated.territoryId) ?? DEFAULT_RECENCY_WINDOW_DAYS,
    )
  ));
});

router.delete("/prospects/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  // Phase 11.5A: body is genuinely optional (no Content-Type/body sent at
  // all still parses as {} and validates fine) -- omitting it entirely
  // reproduces the exact original plain-delete behavior.
  const parsedBody = DeleteProspectBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const { reason, exclude_company } = parsedBody.data;

  const [existing] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Prospect not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, existing.territoryId, null);
    // Role-separation hotfix: a PAM may only delete prospects explicitly
    // assigned to them -- territory membership alone is not enough. Also
    // the natural scope for Phase 11.5A exclusion CREATION below: whatever
    // authorization already permits removing this prospect is exactly what
    // permits excluding its company for the same territory -- no separate
    // RBAC concept needed.
    assertOwnUserAccess(req.actingUser!, existing.assignedUserId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    await assertProspectHasNoRecruitment(id);
  } catch (err) {
    if (err instanceof ProspectHasRecruitmentError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }

  // Phase 11.5A: the delete and the (optional) exclusion it may create run
  // in one transaction -- if excludeCompanyForTerritory throws for any
  // reason, the prospect delete rolls back too, rather than leaving the
  // prospect gone with no exclusion and a misleading 500 response (the
  // client would otherwise have no way to know whether "remove and don't
  // suggest again" actually happened).
  const excluded = await db.transaction(async (tx) => {
    // Resolved before the prospect row is gone -- discovery_exclusions is
    // keyed by domain (and, when known, companyId for display), never by
    // prospectId, so this must be captured now.
    const [company] = await tx.select({ domain: companiesTable.domain }).from(companiesTable).where(eq(companiesTable.id, existing.companyId));

    await tx.delete(prospectActivityTable).where(eq(prospectActivityTable.prospectId, id));
    await tx.delete(prospectsTable).where(eq(prospectsTable.id, id));

    // "duplicate" never creates an exclusion (see excludeCompanyForTerritory's
    // own comment) -- a duplicate RESULT doesn't mean the underlying company
    // is illegitimate; only the redundant prospect row is removed.
    if (exclude_company && reason !== "duplicate" && company?.domain) {
      await excludeCompanyForTerritory(
        {
          territoryId: existing.territoryId,
          domain: company.domain,
          companyId: existing.companyId,
          reason: reason ?? "other",
          createdByUserId: req.actingUser!.id,
        },
        tx,
      );
      return true;
    }
    return false;
  });

  res.json(DeleteProspectResponse.parse({ id, deleted: true, excluded }));
});

router.post("/prospects/:id/hubspot", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [existing] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Prospect not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, existing.territoryId, null);
    // Role-separation hotfix: a PAM may only push prospects explicitly
    // assigned to them -- territory membership alone is not enough.
    assertOwnUserAccess(req.actingUser!, existing.assignedUserId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
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
