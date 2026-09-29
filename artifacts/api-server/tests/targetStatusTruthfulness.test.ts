// 5B.2: DB-free tests for how every backend consumer of the target model
// treats status "unavailable" (a valid target exists but the actual value is
// unavailable -- never interpreted as zero). Importing these services still
// requires DATABASE_URL to be set (see @workspace/db's index.ts), even though
// nothing here ever queries it -- same convention as
// tests/weeklyReportingServicePure.test.ts:
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder \
//     pnpm exec tsx --test tests/targetStatusTruthfulness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WeeklyRecruitmentSnapshot, WeeklyTargetProgress } from "@workspace/db";
import { buildManagementInsights } from "../src/services/managementReportingService";
import { targetStatusCell } from "../src/services/managementReportPptx";
import { buildAttentionItems, type TeamWeeklyReportEnvelope } from "../src/services/weeklyReportingService";
import { buildAvailabilityNotes } from "../src/services/pamOverviewService";
import { buildDataQualityNotes } from "../src/services/copilotContextService";
import type { TeamTargetRow } from "../src/services/targetService";

// ---- Management insights ----------------------------------------------------

const emptyWeeklyTeamReport = {
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
} as TeamWeeklyReportEnvelope;

test("buildManagementInsights emits no target insight for an unavailable closed_revenue target", () => {
  const targets: TeamTargetRow[] = [
    {
      pam_user_id: "u1", pam_name: "Anna", territory_id: "t1", territory_name: "Nordics",
      metric_key: "closed_revenue", metric_label: "Closed Revenue",
      target_value: 100000, target_id: "target-1", actual_value: null, progress_percent: null, status: "unavailable",
    },
  ];
  const insights = buildManagementInsights(
    { week_start: "2026-07-13", quarter_to_date_period_label: "Q3 2026 (to date)" },
    emptyWeeklyTeamReport,
    targets,
    { signed_count: 0 },
    { won_revenue_usd: 0 },
    null,
    0,
    true,
    null,
  );
  assert.equal(insights.some((i) => i.category === "target"), false);
  assert.equal(insights.some((i) => /behind|0%/.test(i.text)), false);
});

// ---- Weekly attention -------------------------------------------------------

const noRecruitment: WeeklyRecruitmentSnapshot = {
  new_candidates_count: 0,
  stage_transitions_count: 0,
  signed_this_week_count: 0,
  stalled_items: [],
  needing_attention_relationships: [],
};

function weeklyTarget(overrides: Partial<WeeklyTargetProgress>): WeeklyTargetProgress {
  return {
    territory_id: "t1",
    territory_name: "Nordics",
    metric_key: "closed_revenue",
    period_key: "2026-q3",
    target_value: 100000,
    period_actual_usd: 40000,
    progress_percent: 40,
    status: "behind",
    ...overrides,
  };
}

test("buildAttentionItems: unavailable, ahead, and no_target targets never create a target_gap item", () => {
  const items = buildAttentionItems(noRecruitment, [
    weeklyTarget({ territory_id: "t-unavail", period_actual_usd: null, progress_percent: null, status: "unavailable" }),
    weeklyTarget({ territory_id: "t-ahead", period_actual_usd: 120000, progress_percent: 120, status: "ahead" }),
    weeklyTarget({ territory_id: "t-none", target_value: null, progress_percent: null, status: "no_target" }),
  ]);
  assert.deepEqual(items.filter((i) => i.kind === "target_gap"), []);
});

test("buildAttentionItems: unavailable does not add a separate data-unavailable attention item either", () => {
  const items = buildAttentionItems(noRecruitment, [weeklyTarget({ period_actual_usd: null, progress_percent: null, status: "unavailable" })]);
  assert.deepEqual(items, []);
});

test("buildAttentionItems: a genuinely behind target states its known actual, target and progress factually", () => {
  const items = buildAttentionItems(noRecruitment, [weeklyTarget({ period_actual_usd: 40000.4, progress_percent: 40 })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "target_gap");
  assert.equal(items[0].label, "Nordics: closed revenue behind target");
  assert.equal(items[0].detail, "40000 of 100000 (40%)");
  assert.equal(items[0].ref_id, "t1");
});

test("buildAttentionItems: a real 0 actual behind a positive target is stated as a real 0 / 0%", () => {
  const items = buildAttentionItems(noRecruitment, [weeklyTarget({ period_actual_usd: 0, progress_percent: 0 })]);
  assert.equal(items[0].detail, "0 of 100000 (0%)");
});

test("buildAttentionItems: behind never fabricates null actual -> 0 or null progress -> 0%", () => {
  const items = buildAttentionItems(noRecruitment, [weeklyTarget({ period_actual_usd: null, progress_percent: null })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].detail, "Target 100000");
  assert.doesNotMatch(items[0].detail, /\b0 of\b|0%/);
});

// ---- Management PPTX target table --------------------------------------------

test("targetStatusCell: unavailable renders 'Unavailable', neutral, not bold and uncoloured", () => {
  assert.deepEqual(targetStatusCell("unavailable"), { text: "Unavailable", color: undefined, bold: false });
});

test("targetStatusCell: no_target stays neutral; ahead/behind keep their existing bold rendering", () => {
  assert.deepEqual(targetStatusCell("no_target"), { text: "No Target", color: undefined, bold: false });
  assert.equal(targetStatusCell("behind").text, "Behind");
  assert.equal(targetStatusCell("behind").bold, true);
  assert.equal(targetStatusCell("ahead").text, "Ahead");
  assert.equal(targetStatusCell("ahead").bold, true);
});

// ---- PAM overview / Copilot availability notes ---------------------------------

const UNAVAILABLE_NOTE = "Actual Signed Partners is unavailable for this period, so target status cannot be determined.";

function performanceRow(status: TeamTargetRow["status"], overrides: Record<string, unknown> = {}) {
  return {
    metric_key: "signed_partners",
    metric_label: "Signed Partners",
    target: status === "no_target" ? null : 5,
    actual: status === "unavailable" ? null : 3,
    progress_percent: status === "unavailable" || status === "no_target" ? null : 60,
    status,
    ...overrides,
  };
}

test("buildAvailabilityNotes: an unavailable performance row adds one factual, territory-labelled note, deduplicated", () => {
  const overview = {
    identity: { territories: [{ territory_id: "t1", territory_name: "Nordics" }] },
    performance: [
      performanceRow("unavailable", { territory_id: "t1", territory_name: "Nordics" }),
      performanceRow("unavailable", { territory_id: "t1", territory_name: "Nordics" }),
      performanceRow("behind", { territory_id: "t1", territory_name: "Nordics", metric_key: "closed_revenue", metric_label: "Closed Revenue" }),
    ],
    portfolio: { assigned_partner_count: 1, needs_review_count: 0, recent_activity: [{}] },
    recruitment: { active_count: 1 },
  } as unknown as Parameters<typeof buildAvailabilityNotes>[0];
  const notes = buildAvailabilityNotes(overview);
  const expected = "Actual Signed Partners for Nordics is unavailable for this period, so target status cannot be determined.";
  assert.equal(notes.filter((n) => n === expected).length, 1);
  assert.equal(notes.some((n) => /Closed Revenue/.test(n)), false);
});

test("buildDataQualityNotes (Copilot context): an unavailable performance row adds the factual note, deduplicated", () => {
  const summary = {
    performance: [performanceRow("unavailable"), performanceRow("unavailable"), performanceRow("ahead", { metric_label: "Closed Revenue" })],
    portfolio: { active_partner_count: 1 },
    recruitment: { active_count: 1 },
    activity: { recent: [{}] },
    territory_potential: { potential_band: "moderate" },
  } as unknown as Parameters<typeof buildDataQualityNotes>[0];
  const notes = buildDataQualityNotes(summary);
  assert.equal(notes.filter((n) => n === UNAVAILABLE_NOTE).length, 1);
  assert.equal(notes.some((n) => /Closed Revenue/.test(n)), false);
});
