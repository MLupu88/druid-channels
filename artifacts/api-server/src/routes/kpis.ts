import { Router, type IRouter } from "express";
import { GetHeadOfChannelsKpisResponse, GetKpiDetailsResponse } from "@workspace/api-zod";
import { METRIC_BY_KEY } from "../services/kpiRegistry";
import { resolvePeriodKey, resolvePeriodRange, buildHeadOfChannelsData, buildKpiDetail } from "../services/kpiService";
import { requireAuth } from "../middleware/auth";
import { resolveScopedTerritory, ForbiddenScopeError } from "../services/authz";
import { FxUnavailableError, InvalidCurrencyError, parseCurrencyParam } from "../services/fx";

const router: IRouter = Router();

router.get("/kpis/head-of-channels", requireAuth, async (req, res): Promise<void> => {
  const { territory, period, currency } = req.query as { territory?: string; period?: string; currency?: string };
  const periodKey = resolvePeriodKey(period);
  const periodInfo = resolvePeriodRange(periodKey);
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

  let data;
  try {
    const selectedCurrency = parseCurrencyParam(currency);
    data = await buildHeadOfChannelsData(periodKey, target, selectedCurrency);
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

  res.json(GetHeadOfChannelsKpisResponse.parse({
    partner_development: data.partnerDevelopment,
    weekly_commercial: data.weeklyCommercial,
    weekly_marketing: data.weeklyMarketing,
    period: periodInfo.label,
    territory: target.territoryName,
    updated_at: new Date().toISOString(),
    fx: data.fx,
  }));
});

router.get("/kpis/details", requireAuth, async (req, res): Promise<void> => {
  const { metric_key, territory, period, currency } = req.query as { metric_key?: string; territory?: string; period?: string; currency?: string };
  const def = metric_key ? METRIC_BY_KEY.get(metric_key) : undefined;
  if (!def) {
    res.status(404).json({ error: `Unknown metric_key: ${metric_key}` });
    return;
  }

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

  let detail;
  try {
    const selectedCurrency = parseCurrencyParam(currency);
    detail = await buildKpiDetail(def.key, periodKey, target, selectedCurrency);
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

  res.json(GetKpiDetailsResponse.parse(detail));
});

export default router;
