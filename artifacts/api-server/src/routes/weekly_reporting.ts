import { Router, type IRouter, type Response } from "express";
import {
  GetMyWeeklyReportQueryParams,
  GetMyWeeklyReportResponse,
  ListMyWeeklyReportHistoryQueryParams,
  ListMyWeeklyReportHistoryResponse,
  UpsertMyWeeklyCommentaryBody,
  UpsertMyWeeklyCommentaryResponse,
  SubmitMyWeeklyReportBody,
  SubmitMyWeeklyReportResponse,
  GetPamWeeklyReportParams,
  GetPamWeeklyReportQueryParams,
  GetPamWeeklyReportResponse,
  GetWeeklyTeamReportQueryParams,
  GetWeeklyTeamReportResponse,
} from "@workspace/api-zod";
import { requireAdmin, requirePam } from "../middleware/auth";
import { mondayOf } from "../services/kpiService";
import {
  getPamWeeklyReport,
  listPamWeeklyReportHistory,
  upsertPamCommentary,
  submitPamWeeklyReport,
  getTeamWeeklyReport,
  WeeklyReportValidationError,
  WeeklyReportNoTerritoryError,
  WeeklyReportAlreadySubmittedError,
  WeeklyReportNotEligibleError,
} from "../services/weeklyReportingService";

const router: IRouter = Router();

// Central mapping for the weekly-reporting service's typed errors -- same
// "return true once a response is written, false if the caller should
// rethrow" pattern as routes/campaigns.ts's handleCampaignError.
function handleWeeklyReportError(err: unknown, res: Response): boolean {
  if (err instanceof WeeklyReportNotEligibleError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  if (err instanceof WeeklyReportNoTerritoryError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  if (err instanceof WeeklyReportAlreadySubmittedError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof WeeklyReportValidationError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

function resolveWeekStart(raw: string | null | undefined): string {
  return raw ?? mondayOf(new Date());
}

// ---- PAM self-service --------------------------------------------------
//
// requirePam (not requireAuth): these are PAM-only self-service endpoints,
// never generic authenticated-user endpoints -- a Head/Admin has no PAM
// weekly report of their own and must use the /pam/:userId or /team
// endpoints below instead. None of these ever accept another user's id;
// the acting PAM is always req.actingUser.id.

router.get("/reporting/weekly/me", requirePam, async (req, res): Promise<void> => {
  const parsedQuery = GetMyWeeklyReportQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  try {
    const report = await getPamWeeklyReport(req.actingUser!.id, resolveWeekStart(parsedQuery.data.week_start));
    res.json(GetMyWeeklyReportResponse.parse(report));
  } catch (err) {
    if (handleWeeklyReportError(err, res)) return;
    throw err;
  }
});

router.get("/reporting/weekly/me/history", requirePam, async (req, res): Promise<void> => {
  const parsedQuery = ListMyWeeklyReportHistoryQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  const rows = await listPamWeeklyReportHistory(req.actingUser!.id, parsedQuery.data.limit ?? undefined);
  res.json(ListMyWeeklyReportHistoryResponse.parse(rows));
});

router.put("/reporting/weekly/me/commentary", requirePam, async (req, res): Promise<void> => {
  const parsed = UpsertMyWeeklyCommentaryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const report = await upsertPamCommentary(req.actingUser!.id, parsed.data.week_start, {
      winsProgress: parsed.data.wins_progress,
      risksBlockers: parsed.data.risks_blockers,
      prioritiesNextWeek: parsed.data.priorities_next_week,
      helpNeeded: parsed.data.help_needed,
    });
    res.json(UpsertMyWeeklyCommentaryResponse.parse(report));
  } catch (err) {
    if (handleWeeklyReportError(err, res)) return;
    throw err;
  }
});

router.post("/reporting/weekly/me/submit", requirePam, async (req, res): Promise<void> => {
  const parsed = SubmitMyWeeklyReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const report = await submitPamWeeklyReport(req.actingUser!.id, parsed.data.week_start);
    res.json(SubmitMyWeeklyReportResponse.parse(report));
  } catch (err) {
    if (handleWeeklyReportError(err, res)) return;
    throw err;
  }
});

// ---- Head/Admin ------------------------------------------------------------
//
// requireAdmin already means head_of_channels OR admin (see
// middleware/auth.ts's ADMIN_ROLES) -- both roles get both endpoints below.

router.get("/reporting/weekly/pam/:userId", requireAdmin, async (req, res): Promise<void> => {
  const parsedParams = GetPamWeeklyReportParams.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const parsedQuery = GetPamWeeklyReportQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  try {
    const report = await getPamWeeklyReport(parsedParams.data.userId, resolveWeekStart(parsedQuery.data.week_start));
    res.json(GetPamWeeklyReportResponse.parse(report));
  } catch (err) {
    if (handleWeeklyReportError(err, res)) return;
    throw err;
  }
});

router.get("/reporting/weekly/team", requireAdmin, async (req, res): Promise<void> => {
  const parsedQuery = GetWeeklyTeamReportQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  try {
    const report = await getTeamWeeklyReport(resolveWeekStart(parsedQuery.data.week_start));
    res.json(GetWeeklyTeamReportResponse.parse(report));
  } catch (err) {
    if (handleWeeklyReportError(err, res)) return;
    throw err;
  }
});

export default router;
