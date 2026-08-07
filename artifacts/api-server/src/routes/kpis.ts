import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { prospectsTable, territoriesTable, kpiSnapshotsTable, campaignsTable } from "@workspace/db";
import { GetHeadOfChannelsKpisResponse } from "@workspace/api-zod";
import { eq, and, isNull, gte, lte } from "drizzle-orm";

const router: IRouter = Router();

const PERIODS: Record<string, { start: string; end: string; label: string }> = {
  q1: { start: "2026-01-01", end: "2026-03-31", label: "Q1 2026" },
  q2: { start: "2026-04-01", end: "2026-06-30", label: "Q2 2026" },
  q3: { start: "2026-07-01", end: "2026-09-30", label: "Q3 2026" },
  q4: { start: "2026-10-01", end: "2026-12-31", label: "Q4 2026" },
  ytd: { start: "2026-01-01", end: "2026-12-31", label: "Year to date" },
};

const NEW_PROSPECT_TARGETS: Record<string, number> = { q1: 8, q2: 11, q3: 15, q4: 18, ytd: 40 };

router.get("/kpis/head-of-channels", async (req, res): Promise<void> => {
  const { territory, period } = req.query as { territory?: string; period?: string };
  const periodKey = period && PERIODS[period] ? period : "q3";
  const periodInfo = PERIODS[periodKey];

  // Resolve territory id when a name/id was passed; null/undefined/"global" => global scope.
  let territoryId: string | null = null;
  let territoryName = "Global";
  const isGlobalRequest = !territory || ["global", "Global", "null", "undefined"].includes(territory);
  if (!isGlobalRequest) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(territory as string);
    const [terr] = await db
      .select()
      .from(territoriesTable)
      .where(isUuid ? eq(territoriesTable.id, territory as string) : eq(territoriesTable.name, territory as string));
    if (terr) {
      territoryId = terr.id;
      territoryName = terr.name;
    }
  }

  // "New Partner Prospects" is computed live from real prospect records (not a canned snapshot) —
  // this is the one row that legitimately reflects "what's happening right now" in the pipeline.
  const allProspects = await db
    .select({ prospect: prospectsTable, terr: territoriesTable })
    .from(prospectsTable)
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id));

  const territoryScoped = territoryId ? allProspects.filter((r) => r.prospect.territoryId === territoryId) : allProspects;
  // Scope "New Partner Prospects" to the selected reporting period using when the prospect
  // was actually discovered (created), so switching Q1/Q2/Q3 changes the count, not just the target.
  const periodStartMs = new Date(periodInfo.start).getTime();
  const periodEndMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();
  const filtered = territoryScoped.filter((r) => {
    const createdMs = new Date(r.prospect.createdAt as unknown as string).getTime();
    return createdMs >= periodStartMs && createdMs <= periodEndMs;
  });

  const newCount = filtered.filter((r) => r.prospect.status === "new").length;
  const acceptedCount = filtered.filter((r) => r.prospect.status === "accepted").length;
  const pushedCount = filtered.filter((r) => r.prospect.status === "pushed_to_hubspot").length;
  const rejectedCount = filtered.filter((r) => r.prospect.status === "rejected").length;
  const totalProspects = newCount + acceptedCount + pushedCount;
  const target = NEW_PROSPECT_TARGETS[periodKey] ?? 15;
  const mostRecentCreatedAt = filtered.reduce<Date | null>((latest, r) => {
    const created = new Date(r.prospect.createdAt as unknown as string);
    return !latest || created > latest ? created : latest;
  }, null);

  const newPartnerProspectsRow = {
    metric: "New Partner Prospects",
    current: totalProspects,
    target,
    status: totalProspects >= target ? ("green" as const) : totalProspects >= target * 0.7 ? ("amber" as const) : ("red" as const),
    what_changed: `${acceptedCount} accepted, ${newCount} awaiting review, ${rejectedCount} rejected`,
    explanation: `${acceptedCount} accepted and ${newCount} awaiting review, out of ${filtered.length} discovered in ${periodInfo.label} for ${territoryName}. ${rejectedCount} were rejected as not a fit.`,
    data_source: "Live: prospects table, scoped to prospects created within the selected period",
    last_updated: (mostRecentCreatedAt ?? new Date()).toISOString(),
  };

  // Remaining partner-development and weekly-commercial metrics come from stored snapshots
  // (representing manual/CRM-exported figures a PAM or ops person entered), scoped by territory
  // and period. Nothing here is derived at request time from unrelated entities.
  const snapshotWhere = territoryId
    ? and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.territoryId, territoryId))
    : and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), isNull(kpiSnapshotsTable.territoryId));

  const snapshots = await db.select().from(kpiSnapshotsTable).where(snapshotWhere);

  const devMetricNames = [
    "Signed Partners",
    "Active Onboarding",
    "Certified Partners",
    "Partner-Sourced Pipeline",
    "Partner-Influenced Pipeline",
    "Closed Revenue",
    "Renewals",
  ];
  const commercialMetricNames = ["Partner-Sourced Pipeline", "Opportunities Created", "Closed Revenue", "Renewals Due", "Renewals Closed"];

  const findSnapshot = (name: string) => snapshots.find((s) => s.metricName === name);

  const partnerDevelopment = [
    newPartnerProspectsRow,
    ...devMetricNames
      .map(findSnapshot)
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => ({
        metric: s.metricName,
        current: Number(s.currentValue),
        target: Number(s.targetValue),
        status: s.status,
        what_changed: s.whatChanged,
        explanation: s.explanation,
        data_source: "Manual entry: quarterly partner-development snapshot",
        last_updated: s.createdAt.toISOString(),
      })),
  ];

  const trend = (current: number, lastWeek: number): "up" | "down" | "flat" =>
    current > lastWeek ? "up" : current < lastWeek ? "down" : "flat";

  const weeklyCommercial = commercialMetricNames
    .map(findSnapshot)
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => {
      const current = Number(s.currentValue);
      const lastWeek = s.lastWeekValue !== null ? Number(s.lastWeekValue) : current;
      return {
        metric: s.metricName,
        current,
        last_week: lastWeek,
        target: Number(s.targetValue),
        trend: trend(current, lastWeek),
        explanation: s.explanation,
        data_source: "Manual entry: weekly commercial snapshot (CRM export)",
        last_updated: s.createdAt.toISOString(),
      };
    });

  // Weekly marketing table: a real calendar week (last 7 days vs the 7 days before that), not
  // the selected quarter/YTD period — "weekly" only means something if the window is actually
  // a week. Counted directly from Activities (joint campaigns/events/webinars), scoped by
  // territory. Real counts/sums for both weeks, with trend computed from the real comparison.
  const now = new Date();
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
  const thisWeekEnd = startOfDay(now);
  const thisWeekStart = new Date(thisWeekEnd);
  thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - 6);
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - 1);
  const lastWeekStart = new Date(lastWeekEnd);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 6);

  const territoryFilter = territoryName !== "Global" ? eq(campaignsTable.territory, territoryName) : undefined;
  const twoWeekFilter = and(gte(campaignsTable.activityDate, toDateStr(lastWeekStart)), lte(campaignsTable.activityDate, toDateStr(thisWeekEnd)));
  const campaignRows = await db
    .select()
    .from(campaignsTable)
    .where(territoryFilter ? and(territoryFilter, twoWeekFilter) : twoWeekFilter);

  const inWindow = (dateStr: string | null, start: Date, end: Date) =>
    dateStr !== null && dateStr >= toDateStr(start) && dateStr <= toDateStr(end);
  const thisWeekRows = campaignRows.filter((c) => inWindow(c.activityDate, thisWeekStart, thisWeekEnd));
  const lastWeekRows = campaignRows.filter((c) => inWindow(c.activityDate, lastWeekStart, lastWeekEnd));

  const countByType = (rows: typeof campaignRows, type: string) => rows.filter((c) => c.type === type).length;
  const sumField = (rows: typeof campaignRows, field: "mqls" | "partnerReferrals") => rows.reduce((sum, c) => sum + c[field], 0);
  const marketingTrend = (thisWeek: number, lastWeek: number): "up" | "down" | "flat" =>
    thisWeek > lastWeek ? "up" : thisWeek < lastWeek ? "down" : "flat";

  const marketingMetricSource = `Live: activities table, calendar week ${toDateStr(thisWeekStart)} to ${toDateStr(thisWeekEnd)} vs prior week`;
  const marketingLastUpdated = now.toISOString();

  const makeMarketingRow = (
    metric: string,
    thisWeekValue: number,
    lastWeekValue: number,
    explanation: string
  ) => ({
    metric,
    this_week: thisWeekValue,
    last_week: lastWeekValue,
    trend: marketingTrend(thisWeekValue, lastWeekValue),
    explanation,
    data_source: marketingMetricSource,
    last_updated: marketingLastUpdated,
  });

  const weeklyMarketing = [
    makeMarketingRow(
      "Joint Campaigns",
      countByType(thisWeekRows, "joint_campaign"),
      countByType(lastWeekRows, "joint_campaign"),
      `${countByType(thisWeekRows, "joint_campaign")} joint campaign(s) this week for ${territoryName}, vs ${countByType(lastWeekRows, "joint_campaign")} last week.`
    ),
    makeMarketingRow(
      "Events",
      countByType(thisWeekRows, "event"),
      countByType(lastWeekRows, "event"),
      `${countByType(thisWeekRows, "event")} partner event(s) this week for ${territoryName}, vs ${countByType(lastWeekRows, "event")} last week.`
    ),
    makeMarketingRow(
      "Webinars",
      countByType(thisWeekRows, "webinar"),
      countByType(lastWeekRows, "webinar"),
      `${countByType(thisWeekRows, "webinar")} webinar(s) this week for ${territoryName}, vs ${countByType(lastWeekRows, "webinar")} last week.`
    ),
    makeMarketingRow(
      "Marketing Qualified Leads",
      sumField(thisWeekRows, "mqls"),
      sumField(lastWeekRows, "mqls"),
      `${sumField(thisWeekRows, "mqls")} MQLs logged this week for ${territoryName}, vs ${sumField(lastWeekRows, "mqls")} last week.`
    ),
    makeMarketingRow(
      "Partner Referrals",
      sumField(thisWeekRows, "partnerReferrals"),
      sumField(lastWeekRows, "partnerReferrals"),
      `${sumField(thisWeekRows, "partnerReferrals")} partner referrals logged this week for ${territoryName}, vs ${sumField(lastWeekRows, "partnerReferrals")} last week.`
    ),
  ];

  res.json(GetHeadOfChannelsKpisResponse.parse({
    partner_development: partnerDevelopment,
    weekly_commercial: weeklyCommercial,
    weekly_marketing: weeklyMarketing,
    period: periodInfo.label,
    territory: territoryName,
    updated_at: new Date().toISOString(),
  }));
});

export default router;
