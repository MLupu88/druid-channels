import { Router, type IRouter } from "express";
import { resolvePeriodKey } from "../services/kpiService";
import { requireAdmin } from "../middleware/auth";
import { resolveScopedTerritory, ForbiddenScopeError } from "../services/authz";
import { FxUnavailableError, InvalidCurrencyError, parseCurrencyParam } from "../services/fx";
import { buildQuarterlyReportPptx } from "../services/pptxReport";

const router: IRouter = Router();

// Role-separation hotfix: strategic PowerPoint export is Head-of-Channels/Admin-only.
router.get("/exports/quarterly-pptx", requireAdmin, async (req, res): Promise<void> => {
  const { territory, period, currency } = req.query as { territory?: string; period?: string; currency?: string };
  const periodKey = resolvePeriodKey(period);
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

  let buffer: Buffer;
  try {
    const selectedCurrency = parseCurrencyParam(currency);
    buffer = await buildQuarterlyReportPptx({ periodKey, target, currency: selectedCurrency });
  } catch (err) {
    if (err instanceof InvalidCurrencyError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof FxUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }

  const fileName = `partner-radar-${periodKey}-${target.territoryName.toLowerCase().replace(/\s+/g, "-")}.pptx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buffer);
});

export default router;
