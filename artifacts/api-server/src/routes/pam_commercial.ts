import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import {
  GetPamCommercialWorkspaceQueryParams,
  GetPamCommercialWorkspaceResponse,
  GetPamCommercialRelationshipDealsResponse,
  GetPamCommercialRollupResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { ForbiddenScopeError } from "../services/authz";
import {
  resolveCommercialWorkspaceUserId,
  getPamCommercialWorkspace,
  getRelationshipDealsForUser,
  CommercialRelationshipNotFoundError,
  PamSelectionRequiredError,
  RelationshipNotEligibleError,
} from "../services/pamCommercialService";
import { getPamCommercialRollup } from "../services/pamCommercialRollupService";

// PAM Commercial Workspace v1: human-session API (requireAuth), never the
// Channel Chief service token. See services/pamCommercialService.ts.
const router: IRouter = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DB-only. Never reads HubSpot.
router.get("/pam-commercial", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = GetPamCommercialWorkspaceQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const actingUser = req.actingUser!;

  let pamUserId: string;
  try {
    pamUserId = resolveCommercialWorkspaceUserId(actingUser, parsedQuery.data.pam_user_id);
  } catch (err) {
    if (err instanceof PamSelectionRequiredError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  // The workspace always belongs to a real role=pam user (same role check as
  // requirePam / the Channel Chief PAM lookup).
  const [pam] = UUID_PATTERN.test(pamUserId) ? await db.select().from(usersTable).where(eq(usersTable.id, pamUserId)) : [];
  if (!pam || pam.role !== "pam") {
    res.status(404).json({ error: "PAM not found" });
    return;
  }

  res.json(GetPamCommercialWorkspaceResponse.parse(await getPamCommercialWorkspace(pam)));
});

// Slice E: Head/Admin team roll-up. DB-only -- never reads HubSpot. Same
// service as GET /channel-chief/pam-commercial-rollup. Drill-down into a
// PAM reuses GET /pam-commercial?pam_user_id= above.
router.get("/pam-commercial/rollup", requireAdmin, async (_req, res): Promise<void> => {
  res.json(GetPamCommercialRollupResponse.parse(await getPamCommercialRollup()));
});

// Lazy, per-relationship HubSpot read: load -> authorize -> eligibility ->
// HubSpot (GET-only).
router.get("/pam-commercial/relationships/:id/deals", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id || !UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "Partner relationship not found" });
    return;
  }

  try {
    const result = await getRelationshipDealsForUser(id, req.actingUser!);
    res.json(GetPamCommercialRelationshipDealsResponse.parse(result));
  } catch (err) {
    if (err instanceof CommercialRelationshipNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof RelationshipNotEligibleError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
