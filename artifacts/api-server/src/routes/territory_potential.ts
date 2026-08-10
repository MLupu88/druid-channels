import { Router, type IRouter } from "express";
// Runtime validators are named after the operationId (getTerritoryPotential
// -> GetTerritoryPotential{QueryParams,Response}), not the component schema
// refs in openapi.yaml -- the component schema names only produce TS types.
// Same convention fixed in 6.4 for pam_copilot.ts (see that route's own
// comment for the full explanation).
import { GetTerritoryPotentialQueryParams, GetTerritoryPotentialResponse } from "@workspace/api-zod";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory } from "../services/authz";
import { resolveTerritory } from "../services/kpiService";
import { getTerritoryPotential, getTerritoryPotentialForAll } from "../services/territoryPotentialService";

const router: IRouter = Router();

// Stage 6.5 Territory Potential. Always returns an array, even for a
// single-territory result, so Head/Admin (multiple summaries, or one when
// ?territory= is given) and PAM (always exactly their own) share one
// response shape. A PAM's own scope is always forced server-side --
// ?territory= is never even read for a non-global caller, so it cannot be
// manipulated to reveal another territory's potential (see the 6.5 spec's
// authz section).
router.get("/territory-potential", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = GetTerritoryPotentialQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { territory } = parsedQuery.data;
  const actingUser = req.actingUser!;

  if (isGlobalUser(actingUser)) {
    if (territory) {
      const resolved = await resolveTerritory(territory);
      if (!resolved.territoryId) {
        res.status(404).json({ error: "Territory not found." });
        return;
      }
      const summary = await getTerritoryPotential(resolved.territoryId, resolved.territoryName);
      res.json(GetTerritoryPotentialResponse.parse([summary]));
      return;
    }
    const summaries = await getTerritoryPotentialForAll();
    res.json(GetTerritoryPotentialResponse.parse(summaries));
    return;
  }

  const own = await getOwnTerritory(actingUser.id);
  if (!own) {
    res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
    return;
  }
  const summary = await getTerritoryPotential(own.territoryId!, own.territoryName);
  res.json(GetTerritoryPotentialResponse.parse([summary]));
});

export default router;
