import { Router, type IRouter } from "express";
// Per lib/api-spec's orval codegen convention (see
// .agents/memory/orval-codegen-flow.md): the runtime zod schema is named
// after the operationId (getChannelChiefSnapshot -> GetChannelChiefSnapshotResponse),
// not the OpenAPI component schema name (ChannelChiefSnapshot).
import { GetChannelChiefSnapshotResponse, GetChannelChiefChangesQueryParams, GetChannelChiefChangesResponse } from "@workspace/api-zod";
import { requireChannelChiefToken } from "../middleware/channelChiefAuth";
import { splitPeriodKey, resolvePeriodKey } from "../services/kpiRegistry";
import { getChannelChiefSnapshot } from "../services/channelChiefContextService";
import { getChannelChangeFeed } from "../services/channelChangeFeedService";
import { FxUnavailableError } from "../services/fx";

const router: IRouter = Router();

// Aniri / Channel Chief: machine-to-machine, read-only. requireChannelChiefToken
// is a dedicated service-token auth path (Authorization: Bearer
// CHANNEL_CHIEF_API_TOKEN) -- entirely separate from requireAuth's human
// session tokens, and never populates req.actingUser. This route never calls
// DeepSeek or any LLM and never generates prose: the AI-side interpretation
// happens entirely on Aniri's side, outside this codebase.
router.get("/channel-chief/snapshot", requireChannelChiefToken, async (req, res): Promise<void> => {
  const { period } = req.query as { period?: string };
  if (period !== undefined && !splitPeriodKey(period)) {
    res.status(400).json({ error: `Invalid period: "${period}". Expected "<year>-<q1|q2|q3|q4|ytd>", e.g. "2026-q3".` });
    return;
  }

  const periodKey = resolvePeriodKey(period);

  let snapshot;
  try {
    snapshot = await getChannelChiefSnapshot(periodKey);
  } catch (err) {
    // Same FX-unavailable contract as routes/kpis.ts -- never a different
    // error shape for the same underlying failure.
    if (err instanceof FxUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json(GetChannelChiefSnapshotResponse.parse(snapshot));
});

// Phase 11.6.1: evidence infrastructure only -- read-only, normalized feed
// of material business changes (see channelChangeFeedService.ts's own
// header comment for the full source list and timestamp semantics). Same
// requireChannelChiefToken machine-to-machine auth as the snapshot route
// above; never normal UI session auth, never req.actingUser. Deliberately
// does NOT send notifications, call an LLM, or touch Telegram/OpenClaw/
// scheduling -- Aniri reads this feed and decides what to do with it
// entirely outside this codebase, wired up in a separate change once this
// contract is stable.
router.get("/channel-chief/changes", requireChannelChiefToken, async (req, res): Promise<void> => {
  const parsedQuery = GetChannelChiefChangesQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  let since: Date | undefined;
  if (parsedQuery.data.since) {
    const parsedSince = new Date(parsedQuery.data.since);
    if (Number.isNaN(parsedSince.getTime())) {
      res.status(400).json({ error: `Invalid since timestamp: "${parsedQuery.data.since}". Expected an ISO 8601 timestamp.` });
      return;
    }
    since = parsedSince;
  }

  const feed = await getChannelChangeFeed({ since, limit: parsedQuery.data.limit });
  res.json(GetChannelChiefChangesResponse.parse(feed));
});

export default router;
