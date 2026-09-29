// Reporting truthfulness (5B.1): DB-free tests for "unknown/unavailable is
// not 0" in the management report's signed_count, and for the marketing
// activity KPIs' rolling-window wording (last 7 days vs previous 7 days --
// never a calendar week). Importing the services still requires
// DATABASE_URL to be set (see @workspace/db's index.ts), even though
// nothing here ever queries it:
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder \
//     tsx --test tests/reportingUnknownsTruthfulness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GetManagementReportSummaryResponse } from "@workspace/api-zod";
import { describeActivityWindows } from "../src/services/kpiService";
import { buildManagementInsights } from "../src/services/managementReportingService";
import type { TeamWeeklyReportEnvelope } from "../src/services/weeklyReportingService";
import { formatCount } from "../src/lib/pptxLayout";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf-8");

// ---- A. Management signed_count --------------------------------------------

test("Management signed_count: the unavailable signed_partners value is passed through, never coalesced to 0", () => {
  const source = read("../src/services/managementReportingService.ts");
  assert.doesNotMatch(source, /signedMetric\.current\s*\?\?/);
  assert.match(source, /signed_count: signedMetric\.current \}/);
});

test("Management signed_count contract: stays required, accepts null (unavailable) and a real 0", () => {
  const signedCount = GetManagementReportSummaryResponse.shape.quarter_to_date.shape.recruitment.shape.period_transitions.shape.signed_count;
  assert.equal(signedCount.safeParse(null).success, true);
  assert.equal(signedCount.safeParse(0).success, true);
  assert.equal(signedCount.safeParse(3).success, true);
  assert.equal(signedCount.safeParse(undefined).success, false, "field must remain present");
});

test("Management PPTX: an unavailable signed_count renders as --, a real 0 still renders as 0", () => {
  assert.equal(formatCount(null), "--");
  assert.equal(formatCount(0), "0");
});

function emptyWeeklyTeamReport(): TeamWeeklyReportEnvelope {
  return {
    week_start: "2026-09-21",
    week_end: "2026-09-27",
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

const ctx = { week_start: "2026-09-21", quarter_to_date_period_label: "Q3 2026" };
const insightsFor = (signedCount: number | null) =>
  buildManagementInsights(ctx, emptyWeeklyTeamReport(), [], { signed_count: signedCount }, { won_revenue_usd: 0 }, null, 0, true, null);

test("Management insights: an unavailable signed_count produces no signed-partners sentence and no zero claim", () => {
  const insights = insightsFor(null);
  assert.equal(insights.some((i) => i.id === "recruitment-signed"), false);
  assert.equal(insights.some((i) => /signed/i.test(i.text)), false);
});

test("Management insights: a real signed_count of 0 produces no sentence; a real positive count still does", () => {
  assert.equal(insightsFor(0).some((i) => i.id === "recruitment-signed"), false);
  const signed = insightsFor(2).find((i) => i.id === "recruitment-signed");
  assert.equal(signed?.text, "2 partners signed during Q3 2026.");
});

// ---- B. Marketing activity rolling windows ---------------------------------

// Wednesday: a rolling 7-day window straddles two calendar weeks here, so
// calendar-week wording would be visibly wrong.
const NOW = new Date("2026-09-30T12:00:00.000Z");

test("Marketing activity wording: states last 7 days (T-6..T) vs previous 7 days (T-13..T-7), UTC -- windows unchanged", () => {
  const copy = describeActivityWindows(NOW, "Webinars", "Nordics", 4, 0);
  assert.equal(copy.data_source, "Live: activities table, last 7 days (2026-09-24 to 2026-09-30, UTC) vs previous 7 days (2026-09-17 to 2026-09-23)");
  assert.equal(copy.explanation, "4 webinars in the last 7 days for Nordics, vs 0 in the previous 7 days.");
});

test("Marketing activity wording: never calls the rolling window a calendar week / this week / last week", () => {
  const copy = describeActivityWindows(NOW, "Events", "Global", 1, 2);
  for (const text of [copy.data_source, copy.explanation]) {
    assert.doesNotMatch(text, /calendar week|this week|last week|prior week/i);
  }
  const source = read("../src/services/kpiService.ts");
  const activities = source.slice(source.indexOf("async function computeActivities"), source.indexOf("async function computeDemo"));
  assert.doesNotMatch(activities, /calendar week|this week|last week|prior week/i);
});

test("Quarterly PPTX: the mixed-source channel marketing column has a neutral header -- not This week, not Last 7 days", () => {
  const source = read("../src/services/pptxReport.ts");
  assert.match(source, /header: "Current", cell: \(r\) => \(\{ text: formatCount\(r\.this_week\) \}\)/);
  assert.doesNotMatch(source, /header: "This week"|header: "Last 7 days"/);
});
