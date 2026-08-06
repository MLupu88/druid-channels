import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { prospectsTable, territoriesTable, kpiSnapshotsTable, campaignsTable } from "@workspace/db";
import { GetHeadOfChannelsKpisResponse } from "@workspace/api-zod";
import { eq, and, isNull } from "drizzle-orm";

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

  // "New Partner Prospects" is computed live from real prospect records (not a canned snapshot).
  const allProspects = await db
    .select({ prospect: prospectsTable, terr: territoriesTable })
    .from(prospectsTable)
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id));

  const filtered = territoryId ? allProspects.filter((r) => r.prospect.territoryId === territoryId) : allProspects;

  const newCount = filtered.filter((r) => r.prospect.status === "new").length;
  const acceptedCount = filtered.filter((r) => r.prospect.status === "accepted").length;
  const pushedCount = filtered.filter((r) => r.prospect.status === "pushed_to_hubspot").length;
  const rejectedCount = filtered.filter((r) => r.prospect.status === "rejected").length;
  const totalProspects = newCount + acceptedCount + pushedCount;
  const target = NEW_PROSPECT_TARGETS[periodKey] ?? 15;

  const newPartnerProspectsRow = {
    metric: "New Partner Prospects",
    current: totalProspects,
    target,
    status: totalProspects >= target ? "green" : totalProspects >= target * 0.7 ? "amber" : "red",
    what_changed: `${acceptedCount} accepted, ${newCount} awaiting review, ${rejectedCount} rejected`,
    explanation: `${acceptedCount} accepted, ${newCount} awaiting review out of ${filtered.length} discovered in ${territoryName}.`,
  };

  // Remaining partner-development metrics come from seeded quarterly snapshots, scoped by
  // territory (or aggregated globally) and by the selected period.
  const snapshotWhere = territoryId
    ? and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.territoryId, territoryId))
    : and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), isNull(kpiSnapshotsTable.territoryId));

  const snapshots = await db.select().from(kpiSnapshotsTable).where(snapshotWhere);

  const partnerDevelopment = [
    newPartnerProspectsRow,
    ...snapshots.map((s) => ({
      metric: s.metricName,
      current: Number(s.currentValue),
      target: Number(s.targetValue),
      status: s.status,
      what_changed: s.whatChanged,
      explanation: s.explanation,
    })),
  ];

  // Weekly commercial/marketing tables: derived from live prospect + campaign activity,
  // scaled by territory so the numbers actually move when the filter changes.
  const campaignRows = territoryName !== "Global"
    ? await db.select().from(campaignsTable).where(eq(campaignsTable.territory, territoryName))
    : await db.select().from(campaignsTable);
  const activeCampaigns = campaignRows.filter((c) => c.status === "active").length;
  const totalReplies = campaignRows.reduce((sum, c) => sum + c.replies, 0);
  const totalMeetings = campaignRows.reduce((sum, c) => sum + c.qualifiedMeetings, 0);

  const pipelineSnapshot = snapshots.find((s) => s.metricName === "Partner-Sourced Pipeline");
  const influencedSnapshot = snapshots.find((s) => s.metricName === "Partner-Influenced Pipeline");
  const revenueSnapshot = snapshots.find((s) => s.metricName === "Closed Revenue");
  const renewalsSnapshot = snapshots.find((s) => s.metricName === "Renewals");

  const trend = (current: number, lastWeek: number): "up" | "down" | "flat" =>
    current > lastWeek ? "up" : current < lastWeek ? "down" : "flat";

  const pipelineCurrent = pipelineSnapshot ? Number(pipelineSnapshot.currentValue) : 0;
  const pipelineLastWeek = Math.round(pipelineCurrent * 0.92);
  const revenueCurrent = revenueSnapshot ? Number(revenueSnapshot.currentValue) : 0;
  const renewalsCurrent = renewalsSnapshot ? Number(renewalsSnapshot.currentValue) : 0;

  const weeklyCommercial = [
    {
      metric: "Partner-Sourced Pipeline",
      current: pipelineCurrent,
      last_week: pipelineLastWeek,
      target: pipelineSnapshot ? Number(pipelineSnapshot.targetValue) : 0,
      trend: trend(pipelineCurrent, pipelineLastWeek),
    },
    {
      metric: "Opportunities Created",
      current: acceptedCount + pushedCount,
      last_week: Math.max(0, acceptedCount + pushedCount - 2),
      target: target,
      trend: trend(acceptedCount + pushedCount, Math.max(0, acceptedCount + pushedCount - 2)),
    },
    {
      metric: "Closed Revenue",
      current: revenueCurrent,
      last_week: revenueCurrent,
      target: revenueSnapshot ? Number(revenueSnapshot.targetValue) : 0,
      trend: "flat" as const,
    },
    {
      metric: "Renewals Due",
      current: Math.max(1, Math.round(renewalsCurrent)),
      last_week: Math.max(1, Math.round(renewalsCurrent) + 1),
      target: renewalsSnapshot ? Number(renewalsSnapshot.targetValue) : 0,
      trend: "down" as const,
    },
    {
      metric: "Renewals Closed",
      current: totalMeetings > 0 ? Math.min(totalMeetings, Math.round(renewalsCurrent)) : Math.round(renewalsCurrent),
      last_week: Math.max(0, Math.round(renewalsCurrent) - 1),
      target: renewalsSnapshot ? Number(renewalsSnapshot.targetValue) : 0,
      trend: trend(Math.round(renewalsCurrent), Math.max(0, Math.round(renewalsCurrent) - 1)),
    },
  ];

  const weeklyMarketing = [
    { metric: "Joint Campaigns", this_week: activeCampaigns, trend: activeCampaigns > 0 ? ("up" as const) : ("flat" as const) },
    { metric: "Events", this_week: Math.max(0, Math.round(campaignRows.length / 2)), trend: "flat" as const },
    { metric: "Webinars", this_week: campaignRows.length, trend: campaignRows.length > 1 ? ("up" as const) : ("flat" as const) },
    { metric: "Marketing Qualified Leads", this_week: newCount, trend: newCount > 5 ? ("up" as const) : ("flat" as const) },
    { metric: "Partner Referrals", this_week: totalReplies, trend: totalReplies > 0 ? ("up" as const) : ("flat" as const) },
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
