import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { territoriesTable, usersTable } from "@workspace/db";
import { ListTerritoriesResponse, UpdateTerritoryBody, UpdateTerritoryResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router: IRouter = Router();

// Any authenticated user can list territories (needed to render names in
// the UI); only head_of_channels/admin can reassign ownership below.
router.get("/territories", requireAuth, async (_req, res): Promise<void> => {
  const territories = await db.select().from(territoriesTable).orderBy(territoriesTable.name);
  res.json(ListTerritoriesResponse.parse(territories.map((t) => ({
    id: t.id,
    name: t.name,
    owner_user_id: t.ownerUserId,
    countries: t.countries as string[],
    languages: t.languages as string[],
  }))));
});

router.patch("/territories/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateTerritoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Territory not found" });
    return;
  }

  const data = parsed.data;
  const updates: Partial<typeof territoriesTable.$inferInsert> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.owner_user_id !== undefined) updates.ownerUserId = data.owner_user_id;

  const [updated] = await db.update(territoriesTable).set(updates).where(eq(territoriesTable.id, id)).returning();

  res.json(UpdateTerritoryResponse.parse({
    id: updated.id,
    name: updated.name,
    owner_user_id: updated.ownerUserId,
    countries: updated.countries as string[],
    languages: updated.languages as string[],
  }));
});

export default router;
