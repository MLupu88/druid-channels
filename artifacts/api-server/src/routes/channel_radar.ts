import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { channelRadarSignalsTable, channelRadarConfigsTable, channelRadarSignalEvidenceTable, territoriesTable, usersTable } from "@workspace/db";
import {
  ListChannelRadarSignalsQueryParams,
  ListChannelRadarSignalsResponse,
  GetChannelRadarSignalResponse,
  UpdateChannelRadarSignalBody,
  UpdateChannelRadarSignalResponse,
  RunChannelRadarBody,
  RunChannelRadarResponse,
  GetChannelRadarSummaryQueryParams,
  GetChannelRadarSummaryResponse,
} from "@workspace/api-zod";
import { eq, inArray, count } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, ForbiddenScopeError } from "../services/authz";
import {
  runRadarForConfig,
  isValidStatusTransition,
  boundListPagination,
  coerceBooleanFilter,
  applyChannelRadarFilters,
  resolveSignalEvidence,
  resolveEvidenceCount,
  ChannelRadarNotConfiguredError,
  ChannelRadarRunFailedError,
} from "../services/channelRadarEngine";
import { getExistingPartnerContext, type ExistingPartnerContext } from "../services/partnerRelationshipService";

const router: IRouter = Router();

function shapeAssignedUser(u: typeof usersTable.$inferSelect | null) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, territory: u.territory, location_label: u.locationLabel, timezone: u.timezone, active: u.active };
}

interface ShapeSignalOptions {
  evidenceCount: number;
  evidence?: Array<{
    id: string;
    source_title: string;
    source_url: string;
    source_domain: string | null;
    source_published_at: string | null;
    discovered_at: string;
    is_primary: boolean;
  }>;
  existingPartnerContext?: ExistingPartnerContext;
  relatedEntityContext?: ExistingPartnerContext;
}

function shapeSignal(
  s: typeof channelRadarSignalsTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
  assignedUser: typeof usersTable.$inferSelect | null,
  opts: ShapeSignalOptions,
) {
  return {
    id: s.id,
    territory_id: s.territoryId,
    territory_name: territory?.name ?? null,
    assigned_user: shapeAssignedUser(assignedUser),
    entity_name: s.entityName,
    entity_type: s.entityType,
    signal_type: s.signalType,
    headline: s.headline,
    summary: s.summary,
    why_it_matters: s.whyItMatters,
    implication: s.implication,
    impact: s.impact,
    recommended_action: s.recommendedAction,
    druid_partner_motion: s.druidPartnerMotion,
    confidence: s.confidence,
    source_title: s.sourceTitle,
    source_url: s.sourceUrl,
    source_domain: s.sourceDomain,
    source_published_at: s.sourcePublishedAt,
    discovered_at: s.discoveredAt.toISOString(),
    status: s.status,
    requires_validation: s.requiresValidation,
    related_entity_name: s.relatedEntityName,
    related_entity_type: s.relatedEntityType,
    relationship_label: s.relationshipLabel,
    // Pre-Phase-10 rows never had last_evidence_at set -- fall back to
    // discoveredAt, exactly as the candidate-window logic itself does (see
    // channelRadarEngine.ts's selectEventCandidates).
    last_evidence_at: (s.lastEvidenceAt ?? s.discoveredAt).toISOString(),
    evidence_count: opts.evidenceCount,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
    ...(opts.existingPartnerContext ? { existing_partner_context: opts.existingPartnerContext } : {}),
    ...(opts.relatedEntityContext ? { related_entity_context: opts.relatedEntityContext } : {}),
  };
}

// Read-only, own-territory-scoped: a PAM may read persisted intelligence
// for their own canonical territory (never trigger research or see other
// territories -- see requireAdmin on POST /channel-radar/run and the
// channel-radar-configs routes below, which remain the only paid-provider-
// triggering / configuration surfaces). Territory scoping below already
// implements the reject-not-widen convention (services/authz.ts) --
// unchanged by this authorization-model update, only the gate itself
// (requireAuth instead of requireAdmin) changed.
router.get("/channel-radar", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListChannelRadarSignalsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { territory, signal_type, entity_type, implication, impact, status, requires_validation, search, limit, offset } = parsedQuery.data;
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
    scopedTerritoryId = own.territoryId;
  }

  const rows = await db
    .select({ signal: channelRadarSignalsTable, territory: territoriesTable, assignedUser: usersTable })
    .from(channelRadarSignalsTable)
    .leftJoin(territoriesTable, eq(channelRadarSignalsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(channelRadarSignalsTable.assignedUserId, usersTable.id))
    .orderBy(channelRadarSignalsTable.discoveredAt);

  // Phase 10 fix: the exact same filter function GET /channel-radar/summary
  // calls below, so the two can never silently diverge on what "the active
  // filters" means.
  const filtered = applyChannelRadarFilters(rows, {
    scopedTerritoryId,
    territory,
    signalType: signal_type,
    entityType: entity_type,
    implication,
    impact,
    status,
    requiresValidation: coerceBooleanFilter(requires_validation),
    search,
  });

  // Pagination applied last, after every filter -- limit/offset describe a
  // window over the already-filtered set, not the unfiltered table.
  const { limit: boundedLimit, offset: boundedOffset } = boundListPagination(limit, offset);
  const page = filtered.slice(boundedOffset, boundedOffset + boundedLimit);

  // One bulk grouped count query for just this page's evidence -- never a
  // per-row query, and never the full evidence rows on the list endpoint
  // (evidence itself is only on the single-signal detail response).
  const pageIds = page.map((r) => r.signal.id);
  const evidenceCounts =
    pageIds.length > 0
      ? await db
          .select({ signalId: channelRadarSignalEvidenceTable.signalId, value: count() })
          .from(channelRadarSignalEvidenceTable)
          .where(inArray(channelRadarSignalEvidenceTable.signalId, pageIds))
          .groupBy(channelRadarSignalEvidenceTable.signalId)
      : [];
  const evidenceCountBySignalId = new Map(evidenceCounts.map((e) => [e.signalId, Number(e.value)]));

  res.json(
    ListChannelRadarSignalsResponse.parse(
      page.map((r) =>
        shapeSignal(r.signal, r.territory, r.assignedUser, {
          // Phase 10 fix: a pre-Phase-10 signal with a real legacy source
          // but zero evidence rows must never report evidence_count: 0 --
          // matches the synthesized item GET /channel-radar/:id exposes for
          // the same signal (resolveSignalEvidence).
          evidenceCount: resolveEvidenceCount(evidenceCountBySignalId.get(r.signal.id) ?? 0, !!r.signal.sourceUrl),
        }),
      ),
    ),
  );
});

// Read-only, own-territory-scoped -- same authorization model as the list
// endpoint above.
router.get("/channel-radar/summary", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = GetChannelRadarSummaryQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { territory, signal_type, entity_type, implication, impact, status, requires_validation, search } = parsedQuery.data;
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
    scopedTerritoryId = own.territoryId;
  }

  // Same territory-scoping convention as the list endpoint above -- this is
  // a server-side aggregate over exactly the same visible set, so it stays
  // correct even once the list endpoint itself is paginated. Never
  // paginated itself (no limit/offset) -- `total` below is always the true
  // count matching the active filters, which is exactly what the list
  // endpoint's pagination needs it for.
  const rows = await db
    .select({ signal: channelRadarSignalsTable, territory: territoriesTable })
    .from(channelRadarSignalsTable)
    .leftJoin(territoriesTable, eq(channelRadarSignalsTable.territoryId, territoriesTable.id));

  // Phase 10 fix: the exact same filter function GET /channel-radar (list)
  // calls above, so the two can never silently diverge on what "the active
  // filters" means.
  const filtered = applyChannelRadarFilters(rows, {
    scopedTerritoryId,
    territory,
    signalType: signal_type,
    entityType: entity_type,
    implication,
    impact,
    status,
    requiresValidation: coerceBooleanFilter(requires_validation),
    search,
  });

  const byImplication = { opportunity: 0, threat: 0, watch: 0, neutral: 0 };
  const byImpact = { high: 0, medium: 0, low: 0 };
  const byStatus = { new: 0, reviewed: 0, dismissed: 0 };
  let requiresValidationCount = 0;
  for (const r of filtered) {
    if (r.signal.implication in byImplication) byImplication[r.signal.implication as keyof typeof byImplication]++;
    if (r.signal.impact in byImpact) byImpact[r.signal.impact as keyof typeof byImpact]++;
    if (r.signal.status in byStatus) byStatus[r.signal.status as keyof typeof byStatus]++;
    if (r.signal.requiresValidation) requiresValidationCount++;
  }

  res.json(
    GetChannelRadarSummaryResponse.parse({
      total: filtered.length,
      by_implication: byImplication,
      by_impact: byImpact,
      by_status: byStatus,
      requires_validation_count: requiresValidationCount,
    }),
  );
});

// Read-only -- record-level territory access is enforced below via
// assertRecordTerritoryAccess (same reject-not-widen convention).
router.get("/channel-radar/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({ signal: channelRadarSignalsTable, territory: territoriesTable, assignedUser: usersTable })
    .from(channelRadarSignalsTable)
    .leftJoin(territoriesTable, eq(channelRadarSignalsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(channelRadarSignalsTable.assignedUserId, usersTable.id))
    .where(eq(channelRadarSignalsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Channel Radar signal not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, row.signal.territoryId, row.territory?.name);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const evidenceRows = await db
    .select()
    .from(channelRadarSignalEvidenceTable)
    .where(eq(channelRadarSignalEvidenceTable.signalId, row.signal.id))
    .orderBy(channelRadarSignalEvidenceTable.discoveredAt);

  // Phase 10 fix: a pre-Phase-10 signal with zero evidence rows but a real
  // legacy source_url must never present as having no evidence -- see
  // resolveSignalEvidence's compatibility rule.
  const evidence = resolveSignalEvidence(evidenceRows, row.signal);

  const [existingPartnerContext, relatedEntityContext] = await Promise.all([
    getExistingPartnerContext(row.signal.companyId, row.signal.territoryId),
    row.signal.relatedEntityCompanyId
      ? getExistingPartnerContext(row.signal.relatedEntityCompanyId, row.signal.territoryId)
      : Promise.resolve<ExistingPartnerContext>({ relationship: null }),
  ]);

  res.json(
    GetChannelRadarSignalResponse.parse(
      shapeSignal(row.signal, row.territory, row.assignedUser, {
        evidenceCount: evidence.length,
        evidence,
        existingPartnerContext,
        relatedEntityContext,
      }),
    ),
  );
});

// Head/Admin-only, deliberately: reviewing/dismissing a signal is a
// management action a PAM does not get in this phase, even for their own
// territory's signals -- PAM Radar access is read-only.
router.patch("/channel-radar/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateChannelRadarSignalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(channelRadarSignalsTable).where(eq(channelRadarSignalsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Channel Radar signal not found" });
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

  if (!isValidStatusTransition(existing.status, parsed.data.status)) {
    res.status(400).json({ error: `Cannot move from "${existing.status}" to "${parsed.data.status}".` });
    return;
  }

  const [updated] = await db
    .update(channelRadarSignalsTable)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(eq(channelRadarSignalsTable.id, id))
    .returning();

  const [row] = await db
    .select({ territory: territoriesTable, assignedUser: usersTable })
    .from(territoriesTable)
    .leftJoin(usersTable, eq(usersTable.id, updated!.assignedUserId!))
    .where(eq(territoriesTable.id, updated!.territoryId));

  const [evidenceCountRow] = await db
    .select({ value: count() })
    .from(channelRadarSignalEvidenceTable)
    .where(eq(channelRadarSignalEvidenceTable.signalId, updated!.id));

  res.json(
    UpdateChannelRadarSignalResponse.parse(
      shapeSignal(updated!, row?.territory ?? null, row?.assignedUser ?? null, {
        evidenceCount: resolveEvidenceCount(Number(evidenceCountRow?.value ?? 0), !!updated!.sourceUrl),
      }),
    ),
  );
});

// Head/Admin-only: the only route that spends paid provider credits
// (Tavily/DeepSeek, via runRadarForConfig) -- a PAM must never be able to
// trigger this, regardless of territory ownership.
router.post("/channel-radar/run", requireAdmin, async (req, res): Promise<void> => {
  const parsed = RunChannelRadarBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { territory_id } = parsed.data;

  try {
    await assertRecordTerritoryAccess(req.actingUser!, territory_id, null);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [config] = await db.select().from(channelRadarConfigsTable).where(eq(channelRadarConfigsTable.territoryId, territory_id));
  if (!config) {
    res.status(404).json({ error: "No Channel Radar config exists for this territory yet." });
    return;
  }
  if (!config.active) {
    res.status(400).json({ error: "This territory's Channel Radar config is inactive." });
    return;
  }

  try {
    const { resultsFound, resultsQualified } = await runRadarForConfig(config.id);
    res.json(RunChannelRadarResponse.parse({
      results_found: resultsFound,
      results_qualified: resultsQualified,
      message: `Scan completed. Found ${resultsFound}, ${resultsQualified} qualified as meaningful signals.`,
    }));
  } catch (err) {
    if (err instanceof ChannelRadarNotConfiguredError) {
      res.status(400).json({ error: err.message });
      return;
    }
    const message = err instanceof ChannelRadarRunFailedError
      ? err.message
      : "Channel Radar scan could not be completed. Please try again or contact an administrator.";
    res.status(500).json({ error: message });
  }
});

export default router;
