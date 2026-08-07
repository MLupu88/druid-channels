import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { scanConfigsTable, territoriesTable } from "@workspace/db";
import {
  ListScanConfigsResponse,
  GetScanConfigResponse,
  UpdateScanConfigBody,
  UpdateScanConfigResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, ForbiddenScopeError } from "../services/authz";

const router: IRouter = Router();

function shapeConfig(c: typeof scanConfigsTable.$inferSelect, territoryName: string) {
  return {
    id: c.id,
    territory_id: c.territoryId,
    territory_name: territoryName,
    name: c.name,
    search_queries: c.searchQueries as string[],
    partner_types: c.partnerTypes as string[],
    industries: c.industries as string[],
    technologies: c.technologies as string[],
    excluded_domains: c.excludedDomains as string[],
    target_signals: c.targetSignals as string[],
    max_results: c.maxResults,
    min_checks_required: c.minChecksRequired,
    recency_window_days: c.recencyWindowDays,
    active: c.active,
  };
}

router.get("/scan-configs", requireAuth, async (req, res): Promise<void> => {
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
    .select({ config: scanConfigsTable, territory: territoriesTable })
    .from(scanConfigsTable)
    .leftJoin(territoriesTable, eq(scanConfigsTable.territoryId, territoriesTable.id))
    .orderBy(territoriesTable.name);

  const scoped = ownTerritoryId ? rows.filter((r) => r.config.territoryId === ownTerritoryId) : rows;

  res.json(ListScanConfigsResponse.parse(scoped.map((r) => shapeConfig(r.config, r.territory?.name ?? ""))));
});

router.get("/scan-configs/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({ config: scanConfigsTable, territory: territoriesTable })
    .from(scanConfigsTable)
    .leftJoin(territoriesTable, eq(scanConfigsTable.territoryId, territoriesTable.id))
    .where(eq(scanConfigsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Scan config not found" });
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

  res.json(GetScanConfigResponse.parse(shapeConfig(row.config, row.territory?.name ?? "")));
});

router.put("/scan-configs/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateScanConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existingForAuth] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, id));
  if (!existingForAuth) {
    res.status(404).json({ error: "Scan config not found" });
    return;
  }
  try {
    await assertRecordTerritoryAccess(req.actingUser!, existingForAuth.territoryId, null);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const data = parsed.data;
  const updates: Partial<typeof scanConfigsTable.$inferInsert> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.partner_types !== undefined) updates.partnerTypes = data.partner_types;
  if (data.industries !== undefined) updates.industries = data.industries;
  if (data.technologies !== undefined) updates.technologies = data.technologies;
  if (data.excluded_domains !== undefined) updates.excludedDomains = data.excluded_domains;
  if (data.target_signals !== undefined) updates.targetSignals = data.target_signals;
  if (data.max_results !== undefined) updates.maxResults = data.max_results;
  if (data.min_checks_required !== undefined) updates.minChecksRequired = data.min_checks_required;
  if (data.recency_window_days !== undefined) updates.recencyWindowDays = data.recency_window_days;
  if (data.active !== undefined) updates.active = data.active;

  const [updated] = await db.update(scanConfigsTable).set(updates).where(eq(scanConfigsTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Scan config not found" });
    return;
  }

  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, updated.territoryId));
  res.json(UpdateScanConfigResponse.parse(shapeConfig(updated, territory?.name ?? "")));
});

export default router;
