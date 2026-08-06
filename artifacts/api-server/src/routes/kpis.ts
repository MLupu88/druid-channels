import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { prospectsTable, territoriesTable } from "@workspace/db";
import { GetHeadOfChannelsKpisResponse } from "@workspace/api-zod";
import { eq, and, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/kpis/head-of-channels", async (req, res): Promise<void> => {
  const { territory, period } = req.query as { territory?: string; period?: string };

  // Count prospects by status
  const allProspects = await db
    .select({ prospect: prospectsTable, terr: territoriesTable })
    .from(prospectsTable)
    .leftJoin(territoriesTable, eq(prospectsTable.territoryId, territoriesTable.id));

  const filtered = territory && territory !== "Global"
    ? allProspects.filter((r) => r.terr?.name === territory)
    : allProspects;

  const newCount = filtered.filter((r) => r.prospect.status === "new").length;
  const acceptedCount = filtered.filter((r) => r.prospect.status === "accepted").length;
  const pushedCount = filtered.filter((r) => r.prospect.status === "pushed_to_hubspot").length;
  const totalProspects = newCount + acceptedCount + pushedCount;

  const now = new Date();
  const periodLabel = period ?? "Q3 2026";

  const partnerDevelopment = [
    { metric: "New Partner Prospects", current: totalProspects, target: 15, status: totalProspects >= 15 ? "green" : totalProspects >= 10 ? "amber" : "red", what_changed: `+${Math.max(0, Math.min(4, totalProspects))} this week`, explanation: `${acceptedCount} accepted, ${newCount} awaiting review.` },
    { metric: "Signed Partners", current: 4, target: 5, status: "amber", what_changed: "No change", explanation: "One partner in final contract negotiation." },
    { metric: "Active Onboarding", current: 6, target: 6, status: "on_track", what_changed: "+1", explanation: "New UK&I partner onboarding started." },
    { metric: "Certified Partners", current: 11, target: 12, status: "amber", what_changed: "+2", explanation: "Two partners completed certification this week." },
    { metric: "Partner-Sourced Pipeline", current: 320000, target: 500000, status: "amber", what_changed: "+€28K", explanation: "Three new qualified opportunities registered." },
    { metric: "Partner-Influenced Pipeline", current: 810000, target: 1000000, status: "amber", what_changed: "+€55K", explanation: "Influenced pipeline growing in DACH and US." },
    { metric: "Closed Revenue", current: 145000, target: 250000, status: "red", what_changed: "No new closes", explanation: "Two deals expected to close before end of quarter." },
    { metric: "Renewals", current: 3, target: 4, status: "amber", what_changed: "No change", explanation: "One renewal due at end of month." },
  ];

  const weeklyCommercial = [
    { metric: "Partner-Sourced Pipeline", current: 320000, last_week: 292000, target: 500000, trend: "up" },
    { metric: "Opportunities Created", current: 7, last_week: 5, target: 10, trend: "up" },
    { metric: "Closed Revenue", current: 145000, last_week: 145000, target: 250000, trend: "flat" },
    { metric: "Renewals Due", current: 1, last_week: 2, target: 4, trend: "down" },
    { metric: "Renewals Closed", current: 3, last_week: 2, target: 4, trend: "up" },
  ];

  const weeklyMarketing = [
    { metric: "Joint Campaigns", this_week: 2, trend: "flat" },
    { metric: "Events", this_week: 1, trend: "down" },
    { metric: "Webinars", this_week: 3, trend: "up" },
    { metric: "Marketing Qualified Leads", this_week: 14, trend: "up" },
    { metric: "Partner Referrals", this_week: 4, trend: "up" },
  ];

  res.json(GetHeadOfChannelsKpisResponse.parse({
    partner_development: partnerDevelopment,
    weekly_commercial: weeklyCommercial,
    weekly_marketing: weeklyMarketing,
    period: periodLabel,
    territory: territory ?? "Global",
    updated_at: new Date().toISOString(),
  }));
});

export default router;
