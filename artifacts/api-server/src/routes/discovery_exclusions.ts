import { Router, type IRouter } from "express";
import { ListDiscoveryExclusionsResponse, RestoreDiscoveryExclusionResponse } from "@workspace/api-zod";
import { requireAdmin } from "../middleware/auth";
import { listActiveDiscoveryExclusions, restoreDiscoveryExclusion, getDiscoveryExclusionById } from "../services/discoveryExclusions";

// Phase 11.5A: Admin-only visibility/restore for PAM-created "don't suggest
// this company again" exclusions. Creation happens via DELETE
// /prospects/:id (see routes/prospects.ts) -- there is no create endpoint
// here, matching the audit's finding that Settings is uniformly
// requireAdmin-gated and PAMs never see this surface at all.
const router: IRouter = Router();

function shapeExclusion(row: NonNullable<Awaited<ReturnType<typeof getDiscoveryExclusionById>>>) {
  return {
    id: row.exclusion.id,
    territory_id: row.exclusion.territoryId,
    territory_name: row.territoryName,
    domain: row.exclusion.domain,
    company_id: row.exclusion.companyId,
    company_name: row.companyName,
    reason: row.exclusion.reason,
    note: row.exclusion.note,
    created_by_user_id: row.exclusion.createdByUserId,
    created_by_name: row.createdByName,
    created_at: row.exclusion.createdAt.toISOString(),
    active: row.exclusion.active,
    restored_at: row.exclusion.restoredAt ? row.exclusion.restoredAt.toISOString() : null,
    restored_by_user_id: row.exclusion.restoredByUserId,
  };
}

router.get("/discovery-exclusions", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await listActiveDiscoveryExclusions();
  res.json(ListDiscoveryExclusionsResponse.parse(rows.map(shapeExclusion)));
});

router.post("/discovery-exclusions/:id/restore", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const restored = await restoreDiscoveryExclusion(id, req.actingUser!.id);
  if (!restored) {
    res.status(404).json({ error: "Exclusion not found, or already restored" });
    return;
  }

  const row = await getDiscoveryExclusionById(restored.id);
  res.json(RestoreDiscoveryExclusionResponse.parse(shapeExclusion(row!)));
});

export default router;
