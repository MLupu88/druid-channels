import { Router, type IRouter } from "express";
import { GetAiChannelBriefResponse, RegenerateAiChannelBriefBody, RegenerateAiChannelBriefResponse } from "@workspace/api-zod";
import { resolvePeriodKey } from "../services/kpiService";
import { requireAdmin } from "../middleware/auth";
import { resolveScopedTerritory, ForbiddenScopeError } from "../services/authz";
import { FxUnavailableError, InvalidCurrencyError, parseCurrencyParam } from "../services/fx";
import { getBriefState, regenerateBrief, type BriefStateResult } from "../services/aiChannelBriefService";

const router: IRouter = Router();

function toResponseShape(result: BriefStateResult) {
  return {
    state: result.state,
    provider_status: result.providerStatus,
    can_regenerate: result.canRegenerate,
    period: result.periodLabel,
    territory_name: result.territoryName,
    currency: result.currency,
    content: result.content,
    data_as_of: result.dataAsOf,
    generated_at: result.generatedAt,
  };
}

// Role-separation hotfix: AI Channel Brief is Head-of-Channels/Admin-only.
router.get("/ai-channel-brief", requireAdmin, async (req, res): Promise<void> => {
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

  let result;
  try {
    const selectedCurrency = parseCurrencyParam(currency);
    result = await getBriefState(periodKey, target, selectedCurrency);
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

  res.json(GetAiChannelBriefResponse.parse(toResponseShape(result)));
});

router.post("/ai-channel-brief/regenerate", requireAdmin, async (req, res): Promise<void> => {
  const body = RegenerateAiChannelBriefBody.parse(req.body);
  const periodKey = resolvePeriodKey(body.period);
  let target;
  try {
    target = await resolveScopedTerritory(req.actingUser!, body.territory);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  let outcome;
  try {
    const selectedCurrency = parseCurrencyParam(body.currency);
    outcome = await regenerateBrief(periodKey, target, selectedCurrency, req.actingUser!.id);
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

  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }

  res.json(RegenerateAiChannelBriefResponse.parse(toResponseShape(outcome.result)));
});

export default router;
