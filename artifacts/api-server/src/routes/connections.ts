import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import { ListConnectionsResponse, UpdateConnectionBody, UpdateConnectionResponse, TestConnectionResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { toConnectionResponse, testConnectionById } from "../services/connections";
import { requireAdmin } from "../middleware/auth";

const router: IRouter = Router();

router.get("/connections", async (_req, res): Promise<void> => {
  const rows = await db.select().from(connectionsTable);
  res.json(ListConnectionsResponse.parse(rows.map(toConnectionResponse)));
});

router.patch("/connections/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = UpdateConnectionBody.parse(req.body);
  const [existing] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const [updated] = await db
    .update(connectionsTable)
    .set({
      ...(body.provider_name !== undefined ? { providerName: body.provider_name } : {}),
      ...(body.config_json !== undefined ? { configJson: body.config_json } : {}),
      ...(body.credential_env_var !== undefined ? { credentialEnvVar: body.credential_env_var } : {}),
      // Changing the credential env var invalidates the last test result.
      ...(body.credential_env_var !== undefined ? { status: "not_configured" as const, lastError: null, lastTestedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(connectionsTable.id, id))
    .returning();

  res.json(UpdateConnectionResponse.parse(toConnectionResponse(updated!)));
});

router.post("/connections/:id/test", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const updated = await testConnectionById(id);
  if (!updated) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  res.json(TestConnectionResponse.parse(toConnectionResponse(updated)));
});

export default router;
