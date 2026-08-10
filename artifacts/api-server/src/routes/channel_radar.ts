import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { channelRadarSignalsTable, channelRadarConfigsTable, territoriesTable, usersTable } from "@workspace/db";
import {
  ListChannelRadarSignalsQueryParams,
  ListChannelRadarSignalsResponse,
  GetChannelRadarSignalResponse,
  UpdateChannelRadarSignalBody,
  UpdateChannelRadarSignalResponse,
  RunChannelRadarBody,
  RunChannelRadarResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, ForbiddenScopeError } from "../services/authz";
import { runRadarForConfig, isValidStatusTransition, ChannelRadarNotConfiguredError, ChannelRadarRunFailedError } from "../services/channelRadarEngine";
import { getExistingPartnerContext, type ExistingPartnerContext } from "../services/partnerRelationshipService";

const router: IRouter = Router();

function shapeAssignedUser(u: typeof usersTable.$inferSelect | null) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, territory: u.territory, location_label: u.locationLabel, timezone: u.timezone, active: u.active };
}

function shapeSignal(
  s: typeof channelRadarSignalsTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
  assignedUser: typeof usersTable.$inferSelect | null,
  existingPartnerContext?: ExistingPartnerContext,
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
    confidence: s.confidence,
    source_title: s.sourceTitle,
    source_url: s.sourceUrl,
    source_domain: s.sourceDomain,
    source_published_at: s.sourcePublishedAt,
    discovered_at: s.discoveredAt.toISOString(),
    status: s.status,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    ...(existingPartnerContext ? { existing_partner_context: existingPartnerContext } : {}),
  };
}

router.get("/channel-radar", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListChannelRadarSignalsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { territory, signal_type, implication, impact, status, search } = parsedQuery.data;
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

  let filtered = rows;
  if (scopedTerritoryId) {
    filtered = filtered.filter((r) => r.signal.territoryId === scopedTerritoryId);
  } else if (territory) {
    filtered = filtered.filter((r) => r.territory?.name === territory || r.signal.territoryId === territory);
  }
  if (signal_type) filtered = filtered.filter((r) => r.signal.signalType === signal_type);
  if (implication) filtered = filtered.filter((r) => r.signal.implication === implication);
  if (impact) filtered = filtered.filter((r) => r.signal.impact === impact);
  if (status) filtered = filtered.filter((r) => r.signal.status === status);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((r) => r.signal.entityName.toLowerCase().includes(q) || r.signal.headline.toLowerCase().includes(q));
  }

  res.json(ListChannelRadarSignalsResponse.parse(filtered.map((r) => shapeSignal(r.signal, r.territory, r.assignedUser))));
});

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

  const existingPartnerContext = await getExistingPartnerContext(row.signal.companyId, row.signal.territoryId);
  res.json(GetChannelRadarSignalResponse.parse(shapeSignal(row.signal, row.territory, row.assignedUser, existingPartnerContext)));
});

router.patch("/channel-radar/:id", requireAuth, async (req, res): Promise<void> => {
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

  res.json(UpdateChannelRadarSignalResponse.parse(shapeSignal(updated!, row?.territory ?? null, row?.assignedUser ?? null)));
});

router.post("/channel-radar/run", requireAuth, async (req, res): Promise<void> => {
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
