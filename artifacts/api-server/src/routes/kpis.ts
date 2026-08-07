import { Router, type IRouter } from "express";
import { GetHeadOfChannelsKpisResponse, GetKpiDetailsResponse } from "@workspace/api-zod";
import { METRIC_BY_KEY } from "../services/kpiRegistry";
import { computeMetric, reconcile, resolvePeriodKey, PERIODS, buildHeadOfChannelsData } from "../services/kpiService";
import { requireAuth } from "../middleware/auth";
import { resolveScopedTerritory, ForbiddenScopeError } from "../services/authz";

const router: IRouter = Router();

router.get("/kpis/head-of-channels", requireAuth, async (req, res): Promise<void> => {
  const { territory, period } = req.query as { territory?: string; period?: string };
  const periodKey = resolvePeriodKey(period);
  const periodInfo = PERIODS[periodKey];
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

  const { partnerDevelopment, weeklyCommercial, weeklyMarketing } = await buildHeadOfChannelsData(periodKey, target);

  res.json(GetHeadOfChannelsKpisResponse.parse({
    partner_development: partnerDevelopment,
    weekly_commercial: weeklyCommercial,
    weekly_marketing: weeklyMarketing,
    period: periodInfo.label,
    territory: target.territoryName,
    updated_at: new Date().toISOString(),
  }));
});

router.get("/kpis/details", requireAuth, async (req, res): Promise<void> => {
  const { metric_key, territory, period } = req.query as { metric_key?: string; territory?: string; period?: string };
  const def = metric_key ? METRIC_BY_KEY.get(metric_key) : undefined;
  if (!def) {
    res.status(404).json({ error: `Unknown metric_key: ${metric_key}` });
    return;
  }

  const periodKey = resolvePeriodKey(period);
  const periodInfo = PERIODS[periodKey];
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
  const c = await computeMetric(def.key, periodKey, target);
  const { reconciles, note } = reconcile(c.current, c.by_territory);

  res.json(GetKpiDetailsResponse.parse({
    metric_key: def.key,
    metric: def.label,
    period: periodInfo.label,
    territory: target.territoryName,
    current: c.current,
    target: c.target,
    last_week: c.last_week,
    trend: c.trend,
    status: c.status,
    data_status: c.data_status,
    data_source: c.data_source,
    last_updated: c.last_updated,
    what_changed: c.what_changed,
    explanation: c.explanation,
    by_territory: c.by_territory,
    records: c.records,
    reconciles,
    reconciliation_note: note,
  }));
});

export default router;
