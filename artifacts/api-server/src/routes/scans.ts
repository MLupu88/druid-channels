import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { scanRunsTable, scanConfigsTable } from "@workspace/db";
import { RunScanBody, RunScanResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.post("/scans/run", async (req, res): Promise<void> => {
  const parsed = RunScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { scan_config_id } = parsed.data;

  const [config] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, scan_config_id));
  if (!config) {
    res.status(404).json({ error: "Scan config not found" });
    return;
  }

  // In mock mode, simulate a completed scan
  const resultsFound = Math.floor(15 + Math.random() * 20);
  const resultsQualified = Math.floor(resultsFound * 0.35);

  const [run] = await db
    .insert(scanRunsTable)
    .values({
      scanConfigId: scan_config_id,
      status: "completed",
      completedAt: new Date(),
      resultsFound,
      resultsQualified,
    })
    .returning();

  res.json(RunScanResponse.parse({
    scan_run_id: run.id,
    status: "completed",
    results_found: resultsFound,
    results_qualified: resultsQualified,
    message: `Mock scan completed. Found ${resultsFound} candidates, ${resultsQualified} qualified for review.`,
  }));
});

export default router;
