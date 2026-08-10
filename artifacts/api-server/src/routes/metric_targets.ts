import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { metricTargetsTable, territoriesTable, usersTable } from "@workspace/db";
import {
  ListMetricTargetsResponse,
  UpsertMetricTargetBody,
  UpsertMetricTargetResponse,
  DeleteMetricTargetResponse,
  ListTeamTargetsQueryParams,
  ListTeamTargetsResponse,
} from "@workspace/api-zod";
import { eq, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { resolvePeriodKey } from "../services/kpiRegistry";
import { isGlobalUser, getOwnTerritory } from "../services/authz";
import {
  upsertTarget,
  deleteTarget,
  getTeamTargets,
  TargetNotTargetableError,
  TargetTerritoryNotFoundError,
  TargetPamNotFoundError,
  TargetPamTerritoryMismatchError,
} from "../services/targetService";

const router: IRouter = Router();

// Batch-fetched territory/user name lookups -- same pattern as
// GET /manual-metric-values.
async function shapeRows(rows: (typeof metricTargetsTable.$inferSelect)[]) {
  const territoryIds = [...new Set(rows.map((r) => r.territoryId).filter((id): id is string => id !== null))];
  const userIds = [
    ...new Set([...rows.map((r) => r.pamUserId), ...rows.map((r) => r.createdByUserId), ...rows.map((r) => r.updatedByUserId)].filter(
      (id): id is string => id !== null,
    )),
  ];
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
    pam_user_id: r.pamUserId,
    pam_name: userName(r.pamUserId),
    target_value: Number(r.targetValue),
    note: r.note,
    created_by_name: userName(r.createdByUserId),
    updated_by_name: userName(r.updatedByUserId),
    updated_at: r.updatedAt.toISOString(),
  }));
}

// Stage 6.2 Team/My Targets grid. A PAM is always forced to their own
// (territory, pam) scope -- pam_user_id/territory query params are only
// honored for a global-role caller, exactly the same pattern as every
// other list route in this app (e.g. GET /recruitment). This is also what
// makes checks E/F (a PAM can never read another PAM's targets, even by
// manipulating query params) hold structurally, not just by convention.
router.get("/team-targets", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListTeamTargetsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const actingUser = req.actingUser!;
  const periodKey = resolvePeriodKey(parsedQuery.data.period);

  let scope: { pamUserId?: string | null; territoryId?: string | null } = {
    pamUserId: parsedQuery.data.pam_user_id,
    territoryId: parsedQuery.data.territory,
  };
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    scope = { pamUserId: actingUser.id, territoryId: own.territoryId };
  }

  const rows = await getTeamTargets(periodKey, scope);
  res.json(ListTeamTargetsResponse.parse(rows));
});

// Raw target list -- primarily used to prefill Overview's existing
// edit-target dialog. A PAM sees only their own territory's rows (Global
// legacy rows, if any, are visible to everyone since they belong to no one
// PAM specifically).
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

  const scoped = ownTerritoryId ? rows.filter((r) => r.territoryId === ownTerritoryId || r.territoryId === null) : rows;

  res.json(ListMetricTargetsResponse.parse(await shapeRows(scoped)));
});

// Head/Admin only. pam_user_id is explicit and validated against
// territories.owner_user_id (services/targetService.ts) -- never silently
// derived, never allowed to mismatch.
router.put("/metric-targets", requireAdmin, async (req, res): Promise<void> => {
  const body = UpsertMetricTargetBody.parse(req.body);

  let saved;
  try {
    saved = await upsertTarget({
      metricKey: body.metric_key,
      periodKey: body.period,
      territoryId: body.territory_id,
      pamUserId: body.pam_user_id,
      targetValue: body.target_value,
      note: body.note ?? null,
      actingUserId: req.actingUser!.id,
    });
  } catch (err) {
    if (err instanceof TargetNotTargetableError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof TargetTerritoryNotFoundError || err instanceof TargetPamNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof TargetPamTerritoryMismatchError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json(UpsertMetricTargetResponse.parse((await shapeRows([saved]))[0]));
});

// Admin-only, same as PUT.
router.delete("/metric-targets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const deleted = await deleteTarget(id);
  if (!deleted) {
    res.status(404).json({ error: "Target not found" });
    return;
  }
  res.json(DeleteMetricTargetResponse.parse({ id, deleted: true }));
});

export default router;
