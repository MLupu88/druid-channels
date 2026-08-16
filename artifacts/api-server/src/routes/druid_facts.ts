import { Router, type IRouter } from "express";
import type { DruidFact } from "@workspace/db";
import {
  ListDruidFactsResponse,
  CreateDruidFactBody,
  CreateDruidFactResponse,
  UpdateDruidFactBody,
  UpdateDruidFactResponse,
  VerifyDruidFactResponse,
  DeactivateDruidFactResponse,
  ReactivateDruidFactResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middleware/auth";
import {
  listDruidFacts,
  createDruidFact,
  updateDruidFact,
  verifyDruidFact,
  deactivateDruidFact,
  reactivateDruidFact,
  DruidFactMissingProvenanceError,
  InvalidDruidFactCategoryError,
} from "../services/druidFacts";

// Phase 11.5C.1: admin-only CRUD for the DRUID Context foundation. Every
// route requires an admin/head_of_channels session -- PAMs never see this
// surface, matching Settings' uniform requireAdmin gate (discovery
// exclusions, connections). No route here reads or writes anything Discovery
// or Channel Radar consume -- that wiring is explicitly out of scope until
// 11.5C.3.
const router: IRouter = Router();

// Drizzle's DruidFact row uses camelCase TS property names (factText,
// sourceType, verifiedByUserId, ...); the OpenAPI/Zod response contract
// uses snake_case (fact_text, source_type, verified_by_user_id, ...). Every
// response must go through this mapper -- passing a raw row straight into
// a *Response.parse() call throws (missing snake_case keys), never silently
// serializes the wrong shape. Same convention as
// routes/discovery_exclusions.ts's shapeExclusion().
function shapeDruidFact(fact: DruidFact) {
  return {
    id: fact.id,
    category: fact.category,
    fact_text: fact.factText,
    source_type: fact.sourceType,
    source_url: fact.sourceUrl,
    source_note: fact.sourceNote,
    verification_status: fact.verificationStatus,
    verified_by_user_id: fact.verifiedByUserId,
    verified_at: fact.verifiedAt ? fact.verifiedAt.toISOString() : null,
    active: fact.active,
    deactivated_by_user_id: fact.deactivatedByUserId,
    deactivated_at: fact.deactivatedAt ? fact.deactivatedAt.toISOString() : null,
    created_by_user_id: fact.createdByUserId,
    created_at: fact.createdAt.toISOString(),
    updated_by_user_id: fact.updatedByUserId,
    updated_at: fact.updatedAt.toISOString(),
  };
}

router.get("/druid-facts", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await listDruidFacts();
  res.json(ListDruidFactsResponse.parse(rows.map(shapeDruidFact)));
});

router.post("/druid-facts", requireAdmin, async (req, res): Promise<void> => {
  const body = CreateDruidFactBody.parse(req.body);
  try {
    const created = await createDruidFact(
      { category: body.category, factText: body.fact_text, sourceUrl: body.source_url ?? null, sourceNote: body.source_note ?? null },
      req.actingUser!.id,
    );
    res.status(201).json(CreateDruidFactResponse.parse(shapeDruidFact(created)));
  } catch (err) {
    if (err instanceof InvalidDruidFactCategoryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.patch("/druid-facts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = UpdateDruidFactBody.parse(req.body);
  try {
    const updated = await updateDruidFact(
      id,
      { category: body.category, factText: body.fact_text, sourceUrl: body.source_url, sourceNote: body.source_note },
      req.actingUser!.id,
    );
    if (!updated) {
      res.status(404).json({ error: "DRUID fact not found" });
      return;
    }
    res.json(UpdateDruidFactResponse.parse(shapeDruidFact(updated)));
  } catch (err) {
    if (err instanceof InvalidDruidFactCategoryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/druid-facts/:id/verify", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const verified = await verifyDruidFact(id, req.actingUser!.id);
    if (!verified) {
      res.status(404).json({ error: "DRUID fact not found" });
      return;
    }
    res.json(VerifyDruidFactResponse.parse(shapeDruidFact(verified)));
  } catch (err) {
    if (err instanceof DruidFactMissingProvenanceError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/druid-facts/:id/deactivate", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const deactivated = await deactivateDruidFact(id, req.actingUser!.id);
  if (!deactivated) {
    res.status(404).json({ error: "DRUID fact not found" });
    return;
  }
  res.json(DeactivateDruidFactResponse.parse(shapeDruidFact(deactivated)));
});

router.post("/druid-facts/:id/reactivate", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const reactivated = await reactivateDruidFact(id, req.actingUser!.id);
  if (!reactivated) {
    res.status(404).json({ error: "DRUID fact not found" });
    return;
  }
  res.json(ReactivateDruidFactResponse.parse(shapeDruidFact(reactivated)));
});

export default router;
