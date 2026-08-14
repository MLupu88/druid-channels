import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { channelRadarConfigsTable, territoriesTable } from "@workspace/db";
import {
  ListChannelRadarConfigsResponse,
  GetChannelRadarConfigResponse,
  CreateChannelRadarConfigBody,
  CreateChannelRadarConfigResponse,
  UpdateChannelRadarConfigBody,
  UpdateChannelRadarConfigResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, ForbiddenScopeError } from "../services/authz";

const router: IRouter = Router();

function shapeConfig(c: typeof channelRadarConfigsTable.$inferSelect, territoryName: string) {
  return {
    id: c.id,
    territory_id: c.territoryId,
    territory_name: territoryName,
    active: c.active,
    monitored_entities: c.monitoredEntities as string[],
    enabled_signal_types: c.enabledSignalTypes as string[],
    lookback_days: c.lookbackDays,
  };
}

// Phase 10 authorization model: Channel Radar CONFIGURATION (this file) and
// research triggering (POST /channel-radar/run) stay Head-of-Channels/Admin-
// only -- a PAM gets no API access here, not even read-only, because a
// config controls what paid-provider research runs. This is now distinct
// from persisted SIGNAL access (routes/channel_radar.ts's GET routes),
// which a PAM can read for their own territory -- see that file's header
// comments for the split.
router.get("/channel-radar-configs", requireAdmin, async (req, res): Promise<void> => {
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

  const rows = await db
    .select({ config: channelRadarConfigsTable, territory: territoriesTable })
    .from(channelRadarConfigsTable)
    .leftJoin(territoriesTable, eq(channelRadarConfigsTable.territoryId, territoriesTable.id))
    .orderBy(territoriesTable.name);

  const scoped = ownTerritoryId ? rows.filter((r) => r.config.territoryId === ownTerritoryId) : rows;

  res.json(ListChannelRadarConfigsResponse.parse(scoped.map((r) => shapeConfig(r.config, r.territory?.name ?? ""))));
});

router.get("/channel-radar-configs/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({ config: channelRadarConfigsTable, territory: territoriesTable })
    .from(channelRadarConfigsTable)
    .leftJoin(territoriesTable, eq(channelRadarConfigsTable.territoryId, territoriesTable.id))
    .where(eq(channelRadarConfigsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Channel Radar config not found" });
    return;
  }

  try {
    await assertRecordTerritoryAccess(req.actingUser!, row.config.territoryId, row.territory?.name);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json(GetChannelRadarConfigResponse.parse(shapeConfig(row.config, row.territory?.name ?? "")));
});

// Management-only, same one-per-territory convention as scan-configs:
// created with schema defaults, 409 if one already exists for the
// territory. Criteria (entities/signal types/lookback) is defined
// afterward via PATCH.
router.post("/channel-radar-configs", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateChannelRadarConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { territory_id } = parsed.data;

  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, territory_id));
  if (!territory) {
    res.status(404).json({ error: "Territory not found" });
    return;
  }

  const [existing] = await db.select().from(channelRadarConfigsTable).where(eq(channelRadarConfigsTable.territoryId, territory_id));
  if (existing) {
    res.status(409).json({ error: "A Channel Radar config already exists for this territory." });
    return;
  }

  const [created] = await db.insert(channelRadarConfigsTable).values({ territoryId: territory_id }).returning();

  res.status(201).json(CreateChannelRadarConfigResponse.parse(shapeConfig(created!, territory.name)));
});

// Management-only: Channel Radar setup is a management control, same
// convention as Partner Search Criteria's PUT /scan-configs/:id.
router.patch("/channel-radar-configs/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateChannelRadarConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(channelRadarConfigsTable).where(eq(channelRadarConfigsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Channel Radar config not found" });
    return;
  }

  const data = parsed.data;
  const updates: Partial<typeof channelRadarConfigsTable.$inferInsert> = { updatedAt: new Date() };
  if (data.active !== undefined) updates.active = data.active;
  if (data.monitored_entities !== undefined) updates.monitoredEntities = data.monitored_entities;
  if (data.enabled_signal_types !== undefined) updates.enabledSignalTypes = data.enabled_signal_types;
  if (data.lookback_days !== undefined) updates.lookbackDays = data.lookback_days;

  const [updated] = await db.update(channelRadarConfigsTable).set(updates).where(eq(channelRadarConfigsTable.id, id)).returning();

  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, updated!.territoryId));
  res.json(UpdateChannelRadarConfigResponse.parse(shapeConfig(updated!, territory?.name ?? "")));
});

export default router;
