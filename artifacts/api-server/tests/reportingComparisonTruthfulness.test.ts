// Reporting truthfulness (5A-1 + 5A-2): DB-free tests for the comparison
// semantics fixed in this slice -- ProspectStats.week_over_week, the four
// cumulative Overview KPIs' last_week/trend, and the management report's
// week-over-week comparison (insights + PPTX tile). Importing the services
// still requires DATABASE_URL to be set (see @workspace/db's index.ts),
// even though nothing here ever queries it:
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder \
//     tsx --test tests/reportingComparisonTruthfulness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GetProspectStatsResponse } from "@workspace/api-zod";
import { previousWeekCutoffInActivePeriod, cumulativeWeekComparison } from "../src/services/kpiService";
import { resolvePeriodRange } from "../src/services/kpiRegistry";
import { buildManagementInsights, classifyManagementWeek } from "../src/services/managementReportingService";
import { weekOverWeekRevenueSubtitle } from "../src/services/managementReportPptx";
import { WeeklyReportValidationError, type TeamWeeklyReportEnvelope } from "../src/services/weeklyReportingService";
import { BAD_COLOR, BRAND_GREY, GOOD_COLOR } from "../src/lib/pptxLayout";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- A. ProspectStats.week_over_week ---------------------------------------

test("ProspectStats: the hard-coded week_over_week ratio is gone -- the route returns null", () => {
  const source = readFileSync(path.join(__dirname, "../src/routes/prospects.ts"), "utf-8");
  assert.doesNotMatch(source, /1\.15/);
  assert.match(source, /week_over_week: null,/);
});

test("ProspectStats contract: week_over_week stays required but accepts null", () => {
  const base = { total: 0, by_territory: [], by_status: {}, by_partner_type: {} };
  assert.equal(GetProspectStatsResponse.safeParse({ ...base, week_over_week: null }).success, true);
  assert.equal(GetProspectStatsResponse.safeParse(base).success, false, "field must remain present");
});

// ---- B. Overview cumulative KPI comparisons --------------------------------
// Q3 2026 = 2026-07-01 (Wed) .. 2026-09-30; Q4 2026 = 2026-10-01 (Thu) .. 2026-12-31.

const at = (iso: string) => new Date(iso + "T12:00:00.000Z");

test("Overview KPI: first week of the active quarter has no comparison (null, not 0)", () => {
  // Fri 2026-10-02 -- previous week ended Sun 2026-09-27, before Q4 started.
  assert.equal(previousWeekCutoffInActivePeriod(resolvePeriodRange("2026-q4"), at("2026-10-02")), null);
  // Quarter starting on a Monday: 2029-01-01 is a Monday; that whole week is still week one.
  assert.equal(previousWeekCutoffInActivePeriod(resolvePeriodRange("2029-q1"), at("2029-01-07")), null);
});

test("Overview KPI: mid active period compares against the previous week's Sunday inside the period", () => {
  // Wed 2026-08-12 -> cutoff Sun 2026-08-09.
  assert.equal(previousWeekCutoffInActivePeriod(resolvePeriodRange("2026-q3"), at("2026-08-12")), "2026-08-09");
  // Second (partial) week of Q4 2026: the cutoff 2026-10-04 is inside the period.
  assert.equal(previousWeekCutoffInActivePeriod(resolvePeriodRange("2026-q4"), at("2026-10-06")), "2026-10-04");
});

test("Overview KPI: a past selected period has no comparison", () => {
  assert.equal(previousWeekCutoffInActivePeriod(resolvePeriodRange("2026-q2"), at("2026-08-12")), null);
});

test("Overview KPI: a future selected period has no comparison", () => {
  assert.equal(previousWeekCutoffInActivePeriod(resolvePeriodRange("2026-q4"), at("2026-08-12")), null);
});

test("Overview KPI: an unavailable comparison yields last_week=null and trend=null, never 0/flat", () => {
  assert.deepEqual(cumulativeWeekComparison(0, null), { last_week: null, trend: null });
  assert.deepEqual(cumulativeWeekComparison(12, null), { last_week: null, trend: null });
});

test("Overview KPI: genuinely equal comparable values still produce flat (including a real 0 vs 0)", () => {
  assert.deepEqual(cumulativeWeekComparison(5, 5), { last_week: 5, trend: "flat" });
  assert.deepEqual(cumulativeWeekComparison(0, 0), { last_week: 0, trend: "flat" });
  assert.deepEqual(cumulativeWeekComparison(7, 5), { last_week: 5, trend: "up" });
  assert.deepEqual(cumulativeWeekComparison(3, 5), { last_week: 5, trend: "down" });
});

// ---- C. Management week-over-week ------------------------------------------

const NOW = at("2026-09-30"); // Wednesday; current week starts Mon 2026-09-28

test("Management WoW: a completed historical week is a real comparison", () => {
  assert.equal(classifyManagementWeek("2026-09-21", NOW), "available");
  assert.equal(classifyManagementWeek("2025-01-06", NOW), "available");
});

test("Management WoW: the current week is in progress (comparison unavailable)", () => {
  assert.equal(classifyManagementWeek("2026-09-28", NOW), "week_in_progress");
  // Monday itself and Sunday end of that week are still the same in-progress week.
  assert.equal(classifyManagementWeek("2026-09-28", at("2026-09-28")), "week_in_progress");
  assert.equal(classifyManagementWeek("2026-09-28", at("2026-10-04")), "week_in_progress");
});

test("Management WoW: a future week_start is rejected with the existing validation error, never zero-filled", () => {
  assert.throws(() => classifyManagementWeek("2026-10-05", NOW), WeeklyReportValidationError);
});

function emptyWeeklyTeamReport(): TeamWeeklyReportEnvelope {
  return {
    week_start: "2026-09-28",
    week_end: "2026-10-04",
    generated_at: "2026-09-30T00:00:00.000Z",
    report_state_summary: { submitted_count: 0, draft_count: 0 },
    pams_with_multiple_territories: [],
    team_commercial: {
      open_pipeline_usd: { sourced: 0, influenced: 0, total: 0 },
      won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
      opportunity_count_open: 0,
      opportunities_created_count: 0,
      deals_won_count: 0,
      conflicts: [],
    },
    team_marketing: { activity_count: 0, commercial_impact: { unique_linked_opportunity_count: 0, open_pipeline_usd: 0, won_revenue_usd: 0 }, conflicts: [] },
    pam_reports: [],
    help_requests: [],
    attention_summary: { stalled_recruitment_count: 0, relationships_needing_attention_count: 0, pams_behind_target: 0 },
  };
}

const ctx = { week_start: "2026-09-28", quarter_to_date_period_label: "Q3 2026" };
const insightsFor = (delta: Parameters<typeof buildManagementInsights>[5]) =>
  buildManagementInsights(ctx, emptyWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 }, delta, 0, true, null);

test("Management insights: the commercial WoW sentence is omitted when the comparison is unavailable", () => {
  assert.equal(insightsFor(null).some((i) => i.id === "commercial-wow"), false);
});

test("Management insights: a completed-week real delta still produces the commercial WoW sentence", () => {
  const insight = insightsFor({ won_revenue_usd: { sourced: 0, influenced: 0, total: -4000 }, opportunities_created_count: 0 }).find((i) => i.id === "commercial-wow");
  assert.equal(insight?.text, "Won revenue this week is $4,000 lower than the previous week.");
});

test("Management PPTX: an unavailable comparison renders a neutral message with no green/red direction", () => {
  const sub = weekOverWeekRevenueSubtitle({ comparison_available: false, delta: null });
  assert.equal(sub.text, "Comparison unavailable — week in progress");
  assert.equal(sub.color, BRAND_GREY);
  assert.notEqual(sub.color, GOOD_COLOR);
  assert.notEqual(sub.color, BAD_COLOR);
  assert.doesNotMatch(sub.text, /[+-]\$|vs\. previous week/);
});

test("Management PPTX: a completed-week real delta keeps its sign and direction, including a genuine 0", () => {
  const snap = (total: number) => ({ won_revenue_usd: { sourced: 0, influenced: 0, total }, opportunities_created_count: 0 });
  const down = weekOverWeekRevenueSubtitle({ comparison_available: true, delta: snap(-2500) });
  assert.equal(down.text, "-$2,500 vs. previous week");
  assert.equal(down.color, BAD_COLOR);
  const zero = weekOverWeekRevenueSubtitle({ comparison_available: true, delta: snap(0) });
  assert.equal(zero.text, "+$0 vs. previous week");
  assert.equal(zero.color, GOOD_COLOR);
});
