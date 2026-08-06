import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { prospectsTable, prospectActivityTable } from "@workspace/db";
import { GetIntegrationsStatusResponse } from "@workspace/api-zod";
import { eq, count, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/integrations/status", async (_req, res): Promise<void> => {
  const pushedCountRows = await db
    .select({ count: count() })
    .from(prospectsTable)
    .where(eq(prospectsTable.status, "pushed_to_hubspot"));
  const recordsSynced = Number(pushedCountRows[0]?.count ?? 0);

  const [lastPush] = await db
    .select()
    .from(prospectActivityTable)
    .where(eq(prospectActivityTable.eventType, "hubspot_pushed"))
    .orderBy(desc(prospectActivityTable.timestamp))
    .limit(1);

  res.json(GetIntegrationsStatusResponse.parse({
    integrations: [
      {
        id: "hubspot",
        name: "HubSpot",
        connected: true,
        mode: "mock",
        records_synced: recordsSynced,
        last_sync_at: lastPush?.timestamp?.toISOString() ?? null,
        description: "Phase 0 mock connection. Accepted prospects can be pushed to HubSpot as companies; no live API calls are made yet.",
      },
      {
        id: "ai_scanner",
        name: "AI Partner Scanner",
        connected: true,
        mode: "mock",
        records_synced: 0,
        last_sync_at: null,
        description: "Scan runs generate mock discovery results based on your scan configuration. Live web scanning is not yet connected.",
      },
    ],
  }));
});

export default router;
