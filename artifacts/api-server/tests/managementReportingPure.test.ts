// Phase 8: DB-free unit tests for managementReportingService.ts's pure
// insight-generation logic. Importing the service still requires
// DATABASE_URL to be set (see @workspace/db's index.ts), even though
// nothing in these tests ever queries it -- same convention as
// tests/weeklyReportingServicePure.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManagementInsights } from "../src/services/managementReportingService";
import type { TeamWeeklyReportEnvelope } from "../src/services/weeklyReportingService";
import type { TeamTargetRow } from "../src/services/targetService";

function baseWeeklyTeamReport(overrides: Partial<TeamWeeklyReportEnvelope> = {}): TeamWeeklyReportEnvelope {
  return {
    week_start: "2026-07-13",
    week_end: "2026-07-19",
    generated_at: "2026-07-15T00:00:00.000Z",
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
    ...overrides,
  };
}

const ctx = { week_start: "2026-07-13", quarter_to_date_period_label: "Q3 2026 (to date)" };
const zeroDelta = { won_revenue_usd: { sourced: 0, influenced: 0, total: 0 }, opportunities_created_count: 0 };

test("buildManagementInsights states target progress factually, without a subjective grade", () => {
  const targets: TeamTargetRow[] = [
    {
      pam_user_id: "u1",
      pam_name: "Anna",
      territory_id: "t1",
      territory_name: "Nordics",
      metric_key: "closed_revenue",
      metric_label: "Closed Revenue",
      target_value: 100000,
      target_id: "target-1",
      actual_value: 68000,
      progress_percent: 68,
      status: "behind",
    },
  ];
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), targets, { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  const targetInsight = insights.find((i) => i.category === "target");
  assert.ok(targetInsight);
  assert.equal(targetInsight!.text, "Anna is at 68% of quarterly target.");
  assert.equal(targetInsight!.severity, "attention");
  assert.equal(targetInsight!.pam_user_id, "u1");
  assert.doesNotMatch(targetInsight!.text, /great|underperform|poor|excellent/i);
});

test("buildManagementInsights marks a target ahead of plan as info severity, not attention", () => {
  const targets: TeamTargetRow[] = [
    {
      pam_user_id: "u2", pam_name: "James", territory_id: "t2", territory_name: "DACH",
      metric_key: "closed_revenue", metric_label: "Closed Revenue",
      target_value: 50000, target_id: "target-2", actual_value: 60000, progress_percent: 120, status: "ahead",
    },
  ];
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), targets, { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  const targetInsight = insights.find((i) => i.category === "target");
  assert.equal(targetInsight!.severity, "info");
});

test("buildManagementInsights ignores target rows with no progress_percent (no_target status)", () => {
  const targets: TeamTargetRow[] = [
    {
      pam_user_id: "u3", pam_name: "Priya", territory_id: "t3", territory_name: "UK",
      metric_key: "closed_revenue", metric_label: "Closed Revenue",
      target_value: null, target_id: null, actual_value: 12000, progress_percent: null, status: "no_target",
    },
  ];
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), targets, { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  assert.equal(insights.some((i) => i.category === "target"), false);
});

test("buildManagementInsights surfaces a help request verbatim, factual and attributed to the requesting PAM", () => {
  const weekly = baseWeeklyTeamReport({ help_requests: [{ pam_user_id: "u4", pam_name: "James", help_needed: "Need support with the Acme negotiation" }] });
  const insights = buildManagementInsights(ctx, weekly, [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  const helpInsight = insights.find((i) => i.category === "help_request");
  assert.ok(helpInsight);
  assert.equal(helpInsight!.text, "James requested support: Need support with the Acme negotiation");
  assert.equal(helpInsight!.pam_user_id, "u4");
  assert.equal(helpInsight!.severity, "attention");
});

test("buildManagementInsights flags outstanding weekly reports with a correctly pluralized count", () => {
  const one = buildManagementInsights(ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 1, true, null);
  assert.equal(one.find((i) => i.category === "submission")!.text, "1 PAM report remains outstanding for the week of 2026-07-13.");

  const two = buildManagementInsights(ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 2, true, null);
  assert.equal(two.find((i) => i.category === "submission")!.text, "2 PAM reports remain outstanding for the week of 2026-07-13.");
});

test("buildManagementInsights omits the outstanding-submissions insight when everyone has reported", () => {
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  assert.equal(insights.some((i) => i.category === "submission"), false);
});

test("buildManagementInsights surfaces stalled recruitment as a current-state count, not a period figure", () => {
  const weekly = baseWeeklyTeamReport({ attention_summary: { stalled_recruitment_count: 3, relationships_needing_attention_count: 0, pams_behind_target: 0 } });
  const insights = buildManagementInsights(ctx, weekly, [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  const stalled = insights.find((i) => i.id === "recruitment-stalled");
  assert.equal(stalled!.text, "3 recruitments have had no stage movement in over 14 days.");
});

test("buildManagementInsights labels quarter-to-date recruitment/marketing figures with the period label, never as a weekly figure", () => {
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), [], { signed_count: 2 }, { won_revenue_usd: 45000 }, zeroDelta, 0, true, null);
  const signed = insights.find((i) => i.id === "recruitment-signed");
  const marketing = insights.find((i) => i.id === "marketing-contribution");
  assert.match(signed!.text, /Q3 2026 \(to date\)/);
  assert.match(marketing!.text, /Q3 2026 \(to date\)/);
  assert.equal(marketing!.text, "Partner-linked marketing activity contributed $45,000 in won revenue during Q3 2026 (to date).");
});

test("buildManagementInsights reports week-over-week commercial movement in both directions correctly", () => {
  const up = buildManagementInsights(
    ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 },
    { won_revenue_usd: { sourced: 1000, influenced: 0, total: 12500 }, opportunities_created_count: 0 }, 0, true, null,
  );
  const upInsight = up.find((i) => i.id === "commercial-wow");
  assert.equal(upInsight!.text, "Won revenue this week is $12,500 higher than the previous week.");
  assert.equal(upInsight!.severity, "info");

  const down = buildManagementInsights(
    ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 },
    { won_revenue_usd: { sourced: -1000, influenced: 0, total: -8000 }, opportunities_created_count: 0 }, 0, true, null,
  );
  const downInsight = down.find((i) => i.id === "commercial-wow");
  assert.equal(downInsight!.text, "Won revenue this week is $8,000 lower than the previous week.");
  assert.equal(downInsight!.severity, "attention");
});

test("buildManagementInsights omits the week-over-week insight when there is genuinely no movement", () => {
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  assert.equal(insights.some((i) => i.id === "commercial-wow"), false);
});

test("buildManagementInsights surfaces a Global-vs-PAM reconciliation mismatch as a risk, never silently forcing equality", () => {
  const note = "Data does not reconcile: territory total (500000) does not match reported total (520000).";
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, false, note);
  const risk = insights.find((i) => i.id === "reconciliation-closed_revenue");
  assert.ok(risk);
  assert.equal(risk!.category, "risk");
  assert.equal(risk!.severity, "risk");
  assert.equal(risk!.text, note);
});

test("buildManagementInsights emits no reconciliation insight when the figures already reconcile", () => {
  const insights = buildManagementInsights(ctx, baseWeeklyTeamReport(), [], { signed_count: 0 }, { won_revenue_usd: 0 }, zeroDelta, 0, true, null);
  assert.equal(insights.some((i) => i.id === "reconciliation-closed_revenue"), false);
});
