import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { scanConfigsTable, scanRunsTable, territoriesTable } from "@workspace/db";
import { RunScanBody, RunScanResponse, ListScanRunsQueryParams, ListScanRunsResponse } from "@workspace/api-zod";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { assertRecordTerritoryAccess, ForbiddenScopeError, isGlobalUser, getOwnTerritory } from "../services/authz";
import { runDiscoveryForConfig, DiscoveryScanFailedError } from "../services/discoveryEngine";

const router: IRouter = Router();

// Role-separation hotfix: Discovery is a Head-of-Channels/Admin management
// workflow, not PAM self-service prospecting -- running a scan is admin-only.
router.post("/scans/run", requireAdmin, async (req, res): Promise<void> => {
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

  try {
    await assertRecordTerritoryAccess(req.actingUser!, config.territoryId, null);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    const { run, prospectsCreated } = await runDiscoveryForConfig(scan_config_id);
    res.json(RunScanResponse.parse({
      scan_run_id: run.id,
      status: run.status,
      results_found: run.resultsFound,
      results_qualified: run.resultsQualified,
      data_status: run.dataStatus,
      // Phase 11.6.1 P2: "qualified for review" previously described
      // prospectsCreated (genuinely new, already-persisted prospect rows --
      // see persistCandidate), which is a different thing from "passed
      // qualifyChecks" (candidatesQualified). Wording here now matches what
      // resultsFound/prospectsCreated actually are: resultsFound is
      // candidates that cleared qualification AND identity resolution
      // (before territory-suppression/persistence), prospectsCreated is the
      // subset that actually became a new prospect row. Never implies these
      // are pending review -- they already are, or aren't, real rows.
      message:
        run.dataStatus === "connected"
          ? `Scan completed against live sources. ${run.resultsFound} candidate${run.resultsFound === 1 ? "" : "s"} identified, ${prospectsCreated} new prospect${prospectsCreated === 1 ? "" : "s"} created.`
          : `Scan completed using demo data (no live search/reader/AI connection configured). ${run.resultsFound} candidate${run.resultsFound === 1 ? "" : "s"} identified, ${prospectsCreated} new prospect${prospectsCreated === 1 ? "" : "s"} created.`,
    }));
  } catch (err) {
    // runDiscoveryForConfig already classified/sanitized this error before
    // throwing it -- .message is safe to return as-is. Anything else
    // reaching this catch (e.g. a bug before runDiscoveryForConfig is even
    // called) gets the same generic fallback rather than its raw message.
    const message = err instanceof DiscoveryScanFailedError
      ? err.message
      : "Discovery scan could not be completed. Please try again or contact an administrator.";
    res.status(500).json({ error: message });
  }
});

router.get("/scan-runs", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListScanRunsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const { scan_config_id } = parsedQuery.data;

  const rows = await db
    .select({ run: scanRunsTable, config: scanConfigsTable, territory: territoriesTable })
    .from(scanRunsTable)
    .innerJoin(scanConfigsTable, eq(scanRunsTable.scanConfigId, scanConfigsTable.id))
    .leftJoin(territoriesTable, eq(scanConfigsTable.territoryId, territoriesTable.id))
    .orderBy(desc(scanRunsTable.startedAt));

  const actingUser = req.actingUser!;
  let scoped = rows;
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    scoped = scoped.filter((r) => r.config.territoryId === own.territoryId);
  }
  if (scan_config_id) {
    scoped = scoped.filter((r) => r.run.scanConfigId === scan_config_id);
  }

  res.json(ListScanRunsResponse.parse(scoped.map((r) => ({
    id: r.run.id,
    scan_config_id: r.run.scanConfigId,
    territory_name: r.territory?.name ?? null,
    status: r.run.status,
    results_found: r.run.resultsFound,
    results_qualified: r.run.resultsQualified,
    data_status: r.run.dataStatus,
    error_message: r.run.errorMessage,
    started_at: r.run.startedAt.toISOString(),
    completed_at: r.run.completedAt ? r.run.completedAt.toISOString() : null,
    queries_run: r.run.queriesRun,
    unique_companies_seen: r.run.uniqueCompaniesSeen,
    new_companies_count: r.run.newCompaniesCount,
    duplicates_removed: r.run.duplicatesRemoved,
    candidates_sent_to_llm: r.run.candidatesSentToLlm,
    candidates_qualified: r.run.candidatesQualified,
    stopped_reason: r.run.stoppedReason,
  }))));
});

export default router;
