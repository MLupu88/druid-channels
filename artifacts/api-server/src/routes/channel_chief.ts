import { Router, type IRouter } from "express";
// Per lib/api-spec's orval codegen convention (see
// .agents/memory/orval-codegen-flow.md): the runtime zod schema is named
// after the operationId (getChannelChiefSnapshot -> GetChannelChiefSnapshotResponse),
// not the OpenAPI component schema name (ChannelChiefSnapshot).
import { GetChannelChiefSnapshotResponse, GetChannelChiefChangesQueryParams, GetChannelChiefChangesResponse, GetPamOverviewQueryParams, GetPamOverviewResponse, GetPamDirectoryResponse } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireChannelChiefToken } from "../middleware/channelChiefAuth";
import { splitPeriodKey, resolvePeriodKey } from "../services/kpiRegistry";
import { getChannelChiefSnapshot } from "../services/channelChiefContextService";
import { getChannelChangeFeed } from "../services/channelChangeFeedService";
import { getPamOverview } from "../services/pamOverviewService";
import { getPamDirectory } from "../services/pamDirectoryService";
import { resolvePamByName } from "../services/pamResolution";
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

// Phase 12: narrow, read-only PAM-level view for Aniri's Chief-of-Staff
// use case (e.g. "how is Denny performing?") -- get_channel_snapshot only
// ever has Global/company-wide scope, which cannot answer that. Same
// requireChannelChiefToken machine-to-machine auth as the other two routes
// above; never normal UI session auth, never req.actingUser. Name
// resolution and every fact returned come from canonical DRUID data via
// pamResolution.ts/pamOverviewService.ts -- this route itself contains no
// business logic beyond auth, query validation, and status-code mapping.
router.get("/channel-chief/pam-overview", requireChannelChiefToken, async (req, res): Promise<void> => {
  // Checked before the generated schema, not instead of it: orval emits
  // pam_name as zod.coerce.string() (required, no .nullish()), and
  // z.coerce.string() runs String(input) unconditionally -- String(undefined)
  // is the non-empty string "undefined", so a genuinely missing pam_name
  // would otherwise sail through .safeParse() as if the caller had literally
  // typed the word "undefined", and this endpoint would then answer with a
  // misleading 404 "no PAM matches" instead of a 400 telling the caller the
  // argument is missing. Query-string values are always string | string[] |
  // undefined at the Express layer, so this only ever narrows, never widens,
  // what the generated schema would otherwise accept.
  if (typeof req.query.pam_name !== "string" || req.query.pam_name.trim() === "") {
    res.status(400).json({ error: "pam_name is required." });
    return;
  }

  const parsedQuery = GetPamOverviewQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  if (parsedQuery.data.period !== undefined && parsedQuery.data.period !== null && !splitPeriodKey(parsedQuery.data.period)) {
    res.status(400).json({ error: `Invalid period: "${parsedQuery.data.period}". Expected "<year>-<q1|q2|q3|q4|ytd>", e.g. "2026-q3".` });
    return;
  }

  // role="pam" only -- this endpoint is explicitly PAM-level (see the Phase
  // 12 brief); a head_of_channels/admin account is never a valid match here
  // even if their name happens to collide with the query.
  const pams = await db.select().from(usersTable).where(eq(usersTable.role, "pam"));
  const resolution = resolvePamByName(parsedQuery.data.pam_name, pams);

  if (resolution.status === "not_found") {
    res.status(404).json({ error: `No PAM matches "${parsedQuery.data.pam_name}".` });
    return;
  }
  if (resolution.status === "ambiguous") {
    res.status(409).json({ error: `Multiple PAMs match "${parsedQuery.data.pam_name}".`, candidates: resolution.candidates });
    return;
  }

  const periodKey = resolvePeriodKey(parsedQuery.data.period);

  let overview;
  try {
    overview = await getPamOverview(resolution.user, periodKey);
  } catch (err) {
    // Same FX-unavailable contract as routes/kpis.ts and the snapshot route
    // above -- never a different error shape for the same underlying
    // failure.
    if (err instanceof FxUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json(GetPamOverviewResponse.parse(overview));
});

// Phase 12: canonical, read-only PAM roster -- who the PAMs are and which
// territory each owns, sourced only from users/territories (role="pam",
// active=true only; no hardcoded names, no computation). Same
// requireChannelChiefToken machine-to-machine auth as every other
// channel-chief route above; never normal UI session auth, never
// req.actingUser. No query params -- the roster is small and unbounded
// by design, matching GET /users and GET /territories' own "return
// everything, ordered" convention for reference data this size.
router.get("/channel-chief/pam-directory", requireChannelChiefToken, async (_req, res): Promise<void> => {
  const directory = await getPamDirectory();
  res.json(GetPamDirectoryResponse.parse(directory));
});

export default router;
