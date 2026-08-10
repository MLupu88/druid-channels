import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { territoriesTable, usersTable } from "@workspace/db";
import { ListTerritoriesResponse, CreateTerritoryBody, CreateTerritoryResponse, UpdateTerritoryBody, UpdateTerritoryResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { assignTerritoryOwner, TerritoryAlreadyOwnedError } from "../services/territoryOwnership";

const router: IRouter = Router();

function shapeTerritory(t: typeof territoriesTable.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    owner_user_id: t.ownerUserId,
    countries: t.countries as string[],
    languages: t.languages as string[],
  };
}

// Any authenticated user can list territories (needed to render names in
// the UI); only head_of_channels/admin can create/reassign ownership below.
router.get("/territories", requireAuth, async (_req, res): Promise<void> => {
  const territories = await db.select().from(territoriesTable).orderBy(territoriesTable.name);
  res.json(ListTerritoriesResponse.parse(territories.map(shapeTerritory)));
});

// A newly created territory is immediately visible everywhere GET
// /territories is read (Discovery/Recruitment/Channel Radar/Portfolio/
// Settings all fetch that same endpoint) -- no separate wiring needed.
router.post("/territories", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateTerritoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const name = data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Territory name is required." });
    return;
  }

  const [existingByName] = await db.select().from(territoriesTable).where(eq(territoriesTable.name, name));
  if (existingByName) {
    res.status(409).json({ error: `A territory named "${name}" already exists.` });
    return;
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [territory] = await tx
        .insert(territoriesTable)
        .values({ name, countries: data.countries ?? [], languages: [] })
        .returning();
      if (data.owner_user_id) {
        await assignTerritoryOwner(tx, territory!.id, data.owner_user_id);
        await tx.update(usersTable).set({ territory: name }).where(eq(usersTable.id, data.owner_user_id));
        const [refreshed] = await tx.select().from(territoriesTable).where(eq(territoriesTable.id, territory!.id));
        return refreshed!;
      }
      return territory!;
    });
    res.json(CreateTerritoryResponse.parse(shapeTerritory(created)));
  } catch (err) {
    if (err instanceof TerritoryAlreadyOwnedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
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

  try {
    const updated = await db.transaction(async (tx) => {
      if (data.owner_user_id !== undefined) {
        if (data.owner_user_id === null) {
          await tx.update(territoriesTable).set({ ownerUserId: null }).where(eq(territoriesTable.id, id));
        } else {
          await assignTerritoryOwner(tx, id, data.owner_user_id);
          const [ownerUser] = await tx.select().from(usersTable).where(eq(usersTable.id, data.owner_user_id));
          if (ownerUser) {
            await tx.update(usersTable).set({ territory: data.name ?? existing.name }).where(eq(usersTable.id, data.owner_user_id));
          }
        }
      }

      const updates: Partial<typeof territoriesTable.$inferInsert> = {};
      if (data.name !== undefined) updates.name = data.name;
      if (data.countries !== undefined) updates.countries = data.countries;
      if (Object.keys(updates).length > 0) {
        await tx.update(territoriesTable).set(updates).where(eq(territoriesTable.id, id));
      }

      const [row] = await tx.select().from(territoriesTable).where(eq(territoriesTable.id, id));
      return row!;
    });

    res.json(UpdateTerritoryResponse.parse(shapeTerritory(updated)));
  } catch (err) {
    if (err instanceof TerritoryAlreadyOwnedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
