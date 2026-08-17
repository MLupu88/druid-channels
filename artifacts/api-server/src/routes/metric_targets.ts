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
  GetAnnualTargetQueryParams,
  GetAnnualTargetResponse,
  UpsertAnnualTargetBody,
  UpsertAnnualTargetResponse,
  GetAnnualCascadeQueryParams,
  GetAnnualCascadeResponse,
} from "@workspace/api-zod";
import { eq, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { resolvePeriodKey, joinPeriodKey, type QuarterKey } from "../services/kpiRegistry";
import { isGlobalUser, getOwnTerritory } from "../services/authz";
import {
  upsertTarget,
  deleteTarget,
  getTeamTargets,
  upsertAnnualTarget,
  getAnnualTarget,
  getAnnualCascade,
  TargetNotTargetableError,
  TargetTerritoryNotFoundError,
  TargetPamNotFoundError,
  TargetPamTerritoryMismatchError,
  type AnnualCascade,
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
    period: joinPeriodKey(r.year, r.period as QuarterKey),
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
  const deleted = await deleteTarget(id, req.actingUser!.id);
  if (!deleted) {
    res.status(404).json({ error: "Target not found" });
    return;
  }
  res.json(DeleteMetricTargetResponse.parse({ id, deleted: true }));
});

// Same batch-name-lookup shape as shapeRows above, but for the single
// company-wide annual row (period="annual", pam_user_id/territory_id both
// null -- there is no PAM/territory name to resolve here).
async function shapeAnnualTarget(row: typeof metricTargetsTable.$inferSelect) {
  const userIds = [row.createdByUserId, row.updatedByUserId].filter((id): id is string => id !== null);
  const users = userIds.length ? await db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const userName = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);

  return {
    id: row.id,
    metric_key: row.metricKey,
    year: row.year,
    target_value: Number(row.targetValue),
    note: row.note,
    created_by_name: userName(row.createdByUserId),
    updated_by_name: userName(row.updatedByUserId),
    updated_at: row.updatedAt.toISOString(),
  };
}

// Phase 5A: the company-wide annual target (Irina/Head-level). Read is open
// to any authenticated user (a PAM needs this figure as context for their
// own allocation), write is Head/Admin only -- same read/write split as
// team-targets vs metric-targets above.
router.get("/metric-targets/annual", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = GetAnnualTargetQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const row = await getAnnualTarget(parsedQuery.data.metric_key, parsedQuery.data.year);
  res.json(GetAnnualTargetResponse.parse(row ? await shapeAnnualTarget(row) : null));
});

router.put("/metric-targets/annual", requireAdmin, async (req, res): Promise<void> => {
  const body = UpsertAnnualTargetBody.parse(req.body);

  let saved;
  try {
    saved = await upsertAnnualTarget({
      metricKey: body.metric_key,
      year: body.year,
      targetValue: body.target_value,
      note: body.note ?? null,
      actingUserId: req.actingUser!.id,
    });
  } catch (err) {
    if (err instanceof TargetNotTargetableError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json(UpsertAnnualTargetResponse.parse(await shapeAnnualTarget(saved)));
});

// getAnnualCascade/computeAnnualCascade (targetService.ts) work entirely in
// the internal camelCase PamAllocation shape (pamUserId, pamName,
// territoryId, territoryName) -- deliberately never touched here, so the
// service/aggregation-math layer stays free of API-contract concerns. Only
// GetAnnualCascadeResponse's allocations[] is snake_case
// (pam_user_id/pam_name/territory_id/territory_name); every OTHER field on
// AnnualCascade (metric_key, year, annual_target, quarterly_totals, ...) is
// already snake_case at the service layer and passes through unshaped. Pure
// and DB-free -- exported so it's directly unit-testable without a live DB,
// same convention as opportunities.ts's isSourceExternalUniqueViolation.
export function shapeAnnualCascade(cascade: AnnualCascade) {
  return {
    ...cascade,
    allocations: cascade.allocations.map((a) => ({
      pam_user_id: a.pamUserId,
      pam_name: a.pamName,
      territory_id: a.territoryId,
      territory_name: a.territoryName,
      q1: a.q1,
      q2: a.q2,
      q3: a.q3,
      q4: a.q4,
    })),
  };
}

// Head/Admin only -- exposes every PAM's individual quarterly allocations,
// not just the caller's own, so this is a management view, not something a
// PAM reads about themselves (a PAM's own allocation is already visible via
// GET /metric-targets, territory-scoped).
router.get("/metric-targets/annual-cascade", requireAdmin, async (req, res): Promise<void> => {
  const parsedQuery = GetAnnualCascadeQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  try {
    const cascade = await getAnnualCascade(parsedQuery.data.metric_key, parsedQuery.data.year);
    res.json(GetAnnualCascadeResponse.parse(shapeAnnualCascade(cascade)));
  } catch (err) {
    if (err instanceof TargetNotTargetableError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
