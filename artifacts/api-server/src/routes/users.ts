import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { ListUsersResponse } from "@workspace/api-zod";

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

export default router;
