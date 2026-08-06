import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { ListUsersResponse, UpdateUserBody, UpdateUserResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/users", async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.name);
  res.json(ListUsersResponse.parse(users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    territory: u.territory,
    active: u.active,
  }))));
});

router.patch("/users/:id", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const data = parsed.data;
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (data.role !== undefined) updates.role = data.role;
  if (data.territory !== undefined) updates.territory = data.territory;
  if (data.active !== undefined) updates.active = data.active;

  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();

  res.json(UpdateUserResponse.parse({
    id: updated.id,
    name: updated.name,
    email: updated.email,
    role: updated.role,
    territory: updated.territory,
    active: updated.active,
  }));
});

export default router;
