import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { territoriesTable, usersTable } from "@workspace/db";
import { ListTerritoriesResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/territories", async (_req, res): Promise<void> => {
  const territories = await db.select().from(territoriesTable).orderBy(territoriesTable.name);
  res.json(ListTerritoriesResponse.parse(territories.map((t) => ({
    id: t.id,
    name: t.name,
    owner_user_id: t.ownerUserId,
    countries: t.countries as string[],
    languages: t.languages as string[],
  }))));
});

export default router;
