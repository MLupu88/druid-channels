import { Router, type IRouter } from "express";
import { GetManagementReportSummaryResponse } from "@workspace/api-zod";
import { requireAdmin } from "../middleware/auth";
import { resolveScopedTerritory, ForbiddenScopeError } from "../services/authz";
import { getManagementReportSummary } from "../services/managementReportingService";
import { WeeklyReportValidationError } from "../services/weeklyReportingService";
import { InvalidCurrencyError, FxUnavailableError } from "../services/fx";

const router: IRouter = Router();

// Phase 8 -- Head/Admin management reporting. requireAdmin mirrors
// routes/weekly_reporting.ts's team/drilldown routes and routes/exports.ts's
// quarterly-pptx route exactly -- no new authorization pattern introduced.
router.get("/reporting/management/summary", requireAdmin, async (req, res): Promise<void> => {
  const { week_start, territory, currency } = req.query as { week_start?: string; territory?: string; currency?: string };

  let target;
  try {
    target = await resolveScopedTerritory(req.actingUser!, territory);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    const summary = await getManagementReportSummary(req.actingUser!, { weekStart: week_start ?? null, target, currency });
    res.json(GetManagementReportSummaryResponse.parse(summary));
  } catch (err) {
    if (err instanceof WeeklyReportValidationError || err instanceof InvalidCurrencyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof FxUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
