import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { metricTargetsTable, territoriesTable, usersTable } from "@workspace/db";
import {
  ListMetricTargetsResponse,
  UpsertMetricTargetBody,
  UpsertMetricTargetResponse,
  DeleteMetricTargetResponse,
} from "@workspace/api-zod";
import { eq, inArray, sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { METRIC_BY_KEY } from "../services/kpiRegistry";
import { isGlobalUser, getOwnTerritory } from "../services/authz";

const router: IRouter = Router();

// Batch-fetched territory/user name lookups -- same pattern as
// GET /manual-metric-values (one query each, not per-row).
async function shapeRows(rows: (typeof metricTargetsTable.$inferSelect)[]) {
  const territoryIds = [...new Set(rows.map((r) => r.territoryId).filter((id): id is string => id !== null))];
  const userIds = [...new Set(rows.map((r) => r.updatedByUserId).filter((id): id is string => id !== null))];
  const territories = territoryIds.length ? await db.select().from(territoriesTable).where(inArray(territoriesTable.id, territoryIds)) : [];
  const users = userIds.length ? await db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const territoryName = (id: string | null) => (id ? territories.find((t) => t.id === id)?.name ?? "Unknown" : "Global");
  const userName = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);

  return rows.map((r) => ({
    id: r.id,
    metric_key: r.metricKey,
    period: r.period,
    territory_id: r.territoryId,
    territory_name: territoryName(r.territoryId),
    target_value: Number(r.targetValue),
    note: r.note,
    updated_by_name: userName(r.updatedByUserId),
    updated_at: r.updatedAt.toISOString(),
  }));
}

// Same territory authorization model as every other list route (e.g.
// GET /scan-configs): a PAM is hard-scoped to their own territory, but
// also sees Global (territory_id = null) targets, which legitimately
// apply to them too. Never widened by an omitted/manipulated query param.
router.get("/metric-targets", requireAuth, async (req, res): Promise<void> => {
  const actingUser = req.actingUser!;
  const { metric_key } = req.query as { metric_key?: string };

  let ownTerritoryId: string | null = null;
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    ownTerritoryId = own.territoryId;
  }

  const rows = metric_key
    ? await db.select().from(metricTargetsTable).where(eq(metricTargetsTable.metricKey, metric_key))
    : await db.select().from(metricTargetsTable);

  const scoped = ownTerritoryId
    ? rows.filter((r) => r.territoryId === ownTerritoryId || r.territoryId === null)
    : rows;

  res.json(ListMetricTargetsResponse.parse(await shapeRows(scoped)));
});

// Admins are trusted to configure any territory's target (or Global) --
// same "global roles aren't territory-scoped" convention already used by
// PUT /metric-mappings and PUT /manual-metric-values. requireAdmin's
// ADMIN_ROLES set includes head_of_channels and excludes pam.
router.put("/metric-targets", requireAdmin, async (req, res): Promise<void> => {
  const body = UpsertMetricTargetBody.parse(req.body);
  if (!METRIC_BY_KEY.has(body.metric_key)) {
    res.status(404).json({ error: `Unknown metric_key: ${body.metric_key}` });
    return;
  }
  if (body.territory_id) {
    const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, body.territory_id));
    if (!territory) {
      res.status(404).json({ error: `Unknown territory_id: ${body.territory_id}` });
      return;
    }
  }

  const now = new Date();
  const values = {
    metricKey: body.metric_key,
    period: body.period,
    territoryId: body.territory_id ?? null,
    targetValue: String(body.target_value),
    note: body.note ?? null,
    updatedByUserId: req.actingUser!.id,
    updatedAt: now,
  };
  const updateSet = {
    targetValue: values.targetValue,
    note: values.note,
    updatedByUserId: values.updatedByUserId,
    updatedAt: values.updatedAt,
  };

  // A single atomic INSERT .. ON CONFLICT .. DO UPDATE -- no select-then-write
  // race window, no transaction, no swallowed DB error. The two unique
  // indexes are disjoint (a non-null territory_id can only ever violate the
  // plain composite index; a null one only the partial "global" index), so
  // which conflict target to use is decided by which case this write is.
  const [saved] = body.territory_id
    ? await db
        .insert(metricTargetsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [metricTargetsTable.metricKey, metricTargetsTable.period, metricTargetsTable.territoryId],
          set: updateSet,
        })
        .returning()
    : await db
        .insert(metricTargetsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [metricTargetsTable.metricKey, metricTargetsTable.period],
          targetWhere: sql`${metricTargetsTable.territoryId} is null`,
          set: updateSet,
        })
        .returning();

  res.json(UpsertMetricTargetResponse.parse((await shapeRows([saved]))[0]));
});

// Admin-only, same as PUT -- admins aren't territory-scoped anywhere else
// in this app (metric-mappings, manual-metric-values), so no additional
// per-territory check beyond requireAdmin.
router.delete("/metric-targets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [existing] = await db.select().from(metricTargetsTable).where(eq(metricTargetsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Target not found" });
    return;
  }
  await db.delete(metricTargetsTable).where(eq(metricTargetsTable.id, id));
  res.json(DeleteMetricTargetResponse.parse({ id, deleted: true }));
});

export default router;
