// Phase 7: DB-free unit tests for weeklyReportingService.ts's pure
// functions -- week identity, marketing dedup, and team-level commercial/
// marketing aggregation (including the reassignment-conflict handling).
// Importing the service still requires DATABASE_URL to be set (see
// @workspace/db's index.ts), even though nothing here ever queries it --
// same convention as tests/weeklyReportingRangeMath.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCanonicalMonday,
  weekEndExclusive,
  periodKeyForWeek,
  unionLinkedOpportunityIds,
  aggregateTeamCommercial,
  aggregateTeamMarketing,
  type PamReportForAggregation,
} from "../src/services/weeklyReportingService";
import type { WeeklyMetricsSnapshot } from "@workspace/db";

// ---- Week identity --------------------------------------------------------

test("isCanonicalMonday accepts a real Monday", () => {
  assert.equal(isCanonicalMonday("2026-07-13"), true); // 2026-07-13 is a Monday
});

test("isCanonicalMonday rejects a non-Monday date", () => {
  assert.equal(isCanonicalMonday("2026-07-14"), false); // Tuesday
  assert.equal(isCanonicalMonday("2026-07-12"), false); // Sunday
});

test("weekEndExclusive is exactly 7 days after week_start (the following Monday)", () => {
  assert.equal(weekEndExclusive("2026-07-13"), "2026-07-20");
});

test("weekEndExclusive rolls over a year boundary correctly", () => {
  assert.equal(weekEndExclusive("2026-12-28"), "2027-01-04");
});

// ---- periodKeyForWeek (quarter boundary correctness) -----------------------

test("periodKeyForWeek resolves a mid-quarter week to that quarter", () => {
  assert.equal(periodKeyForWeek("2026-02-02"), "2026-q1");
  assert.equal(periodKeyForWeek("2026-07-13"), "2026-q3");
});

test("periodKeyForWeek resolves the exact first week of each quarter correctly", () => {
  assert.equal(periodKeyForWeek("2026-01-05"), "2026-q1");
  assert.equal(periodKeyForWeek("2026-03-30"), "2026-q1"); // still March
  assert.equal(periodKeyForWeek("2026-04-06"), "2026-q2");
  assert.equal(periodKeyForWeek("2026-06-29"), "2026-q2"); // still June
  assert.equal(periodKeyForWeek("2026-07-06"), "2026-q3");
  assert.equal(periodKeyForWeek("2026-09-28"), "2026-q3"); // still September
  assert.equal(periodKeyForWeek("2026-10-05"), "2026-q4");
});

test("periodKeyForWeek is based on the reporting week's own date, never today's date -- proves historical weeks resolve to their own quarter", () => {
  assert.equal(periodKeyForWeek("2024-01-01"), "2024-q1");
  assert.equal(periodKeyForWeek("2024-12-30"), "2024-q4");
});

// ---- unionLinkedOpportunityIds ---------------------------------------------

test("unionLinkedOpportunityIds dedupes an opportunity linked from two different campaigns", () => {
  const impactByCampaign = new Map([
    ["campaign-a", { linkedOpportunityIds: ["opp-1", "opp-2"], linkedOpportunityCount: 2, linkedOpenPipeline: null, linkedClosedRevenue: null }],
    ["campaign-b", { linkedOpportunityIds: ["opp-2", "opp-3"], linkedOpportunityCount: 2, linkedOpenPipeline: null, linkedClosedRevenue: null }],
  ]);
  const result = unionLinkedOpportunityIds(impactByCampaign);
  assert.deepEqual([...result].sort(), ["opp-1", "opp-2", "opp-3"]);
});

// ---- Team aggregation: commercial ------------------------------------------

function fixtureMetrics(overrides: Partial<WeeklyMetricsSnapshot>): WeeklyMetricsSnapshot {
  return {
    snapshot_version: 1,
    week_start: "2026-07-13",
    week_end: "2026-07-19",
    territory_ids: ["t1"],
    territory_names: ["Territory 1"],
    pam_user_id: "pam-a",
    generated_at: "2026-07-15T00:00:00.000Z",
    commercial: {
      open_pipeline_usd: { sourced: 0, influenced: 0, total: 0 },
      won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
      opportunity_count_open: 0,
      opportunities_created_count: 0,
      deals_won_count: 0,
      targets: [],
      contributing_open_pipeline: [],
      contributing_won_revenue: [],
      contributing_opportunities_created: [],
    },
    recruitment: { new_candidates_count: 0, stage_transitions_count: 0, signed_this_week_count: 0, stalled_items: [], needing_attention_relationships: [] },
    marketing: { activities: [], activity_count: 0, commercial_impact: { unique_linked_opportunity_count: 0, open_pipeline_usd: 0, won_revenue_usd: 0, contributing_opportunities: [] } },
    attention: [],
    ...overrides,
  } as WeeklyMetricsSnapshot;
}

test("aggregateTeamCommercial sums non-overlapping PAMs' pipeline/revenue/counts directly", () => {
  const pamA: PamReportForAggregation = {
    pam_user_id: "pam-a",
    status: "draft",
    snapshot_generated_at: null,
    metrics: fixtureMetrics({
      generated_at: "2026-07-15T10:00:00.000Z",
      commercial: {
        open_pipeline_usd: { sourced: 100, influenced: 0, total: 100 },
        won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
        opportunity_count_open: 1,
        opportunities_created_count: 1,
        deals_won_count: 0,
        targets: [],
        contributing_open_pipeline: [{ opportunity_id: "opp-a", attribution_type: "partner_sourced", usd_value: 100 }],
        contributing_won_revenue: [],
        contributing_opportunities_created: [{ opportunity_id: "opp-a", opportunity_date: "2026-07-14" }],
      },
    }),
  };
  const pamB: PamReportForAggregation = {
    pam_user_id: "pam-b",
    status: "draft",
    snapshot_generated_at: null,
    metrics: fixtureMetrics({
      pam_user_id: "pam-b",
      generated_at: "2026-07-15T10:00:00.000Z",
      commercial: {
        open_pipeline_usd: { sourced: 0, influenced: 50, total: 50 },
        won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
        opportunity_count_open: 1,
        opportunities_created_count: 0,
        deals_won_count: 0,
        targets: [],
        contributing_open_pipeline: [{ opportunity_id: "opp-b", attribution_type: "partner_influenced", usd_value: 50 }],
        contributing_won_revenue: [],
        contributing_opportunities_created: [],
      },
    }),
  };

  const result = aggregateTeamCommercial([pamA, pamB]);
  assert.deepEqual(result.open_pipeline_usd, { sourced: 100, influenced: 50, total: 150 });
  assert.equal(result.opportunity_count_open, 2);
  assert.equal(result.opportunities_created_count, 1);
  assert.equal(result.conflicts.length, 0);
});

test("aggregateTeamCommercial dedupes the SAME opportunity appearing in two PAMs' pipeline (reassignment race), never double-counting", () => {
  const sharedOpp = { opportunity_id: "opp-shared", attribution_type: "partner_sourced" as const, usd_value: 200 };
  const pamA: PamReportForAggregation = {
    pam_user_id: "pam-a",
    status: "submitted",
    snapshot_generated_at: "2026-07-15T09:00:00.000Z", // frozen earlier
    metrics: fixtureMetrics({
      generated_at: "2026-07-15T09:00:00.000Z",
      commercial: {
        open_pipeline_usd: { sourced: 200, influenced: 0, total: 200 },
        won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
        opportunity_count_open: 1,
        opportunities_created_count: 0,
        deals_won_count: 0,
        targets: [],
        contributing_open_pipeline: [sharedOpp],
        contributing_won_revenue: [],
        contributing_opportunities_created: [],
      },
    }),
  };
  const pamB: PamReportForAggregation = {
    pam_user_id: "pam-b",
    status: "draft",
    snapshot_generated_at: null,
    metrics: fixtureMetrics({
      pam_user_id: "pam-b",
      generated_at: "2026-07-15T11:00:00.000Z", // live, later than pamA's frozen time -- reassigned since
      commercial: {
        open_pipeline_usd: { sourced: 200, influenced: 0, total: 200 },
        won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
        opportunity_count_open: 1,
        opportunities_created_count: 0,
        deals_won_count: 0,
        targets: [],
        contributing_open_pipeline: [sharedOpp], // same opportunity, same value -- no conflict, just a dup to dedupe
        contributing_won_revenue: [],
        contributing_opportunities_created: [],
      },
    }),
  };

  const result = aggregateTeamCommercial([pamA, pamB]);
  assert.equal(result.open_pipeline_usd.total, 200, "the shared opportunity must be counted exactly once, not summed across both PAMs");
  assert.equal(result.opportunity_count_open, 1);
  assert.equal(result.conflicts.length, 0, "identical sightings are not a conflict");
});

test("aggregateTeamCommercial surfaces a conflict when the same opportunity has DIFFERENT values across PAMs, and picks the most recent sighting for the totals", () => {
  const pamA: PamReportForAggregation = {
    pam_user_id: "pam-a",
    status: "submitted",
    snapshot_generated_at: "2026-07-15T09:00:00.000Z",
    metrics: fixtureMetrics({
      generated_at: "2026-07-15T09:00:00.000Z",
      commercial: {
        open_pipeline_usd: { sourced: 200, influenced: 0, total: 200 },
        won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
        opportunity_count_open: 1,
        opportunities_created_count: 0,
        deals_won_count: 0,
        targets: [],
        contributing_open_pipeline: [{ opportunity_id: "opp-shared", attribution_type: "partner_sourced", usd_value: 200 }],
        contributing_won_revenue: [],
        contributing_opportunities_created: [],
      },
    }),
  };
  const pamB: PamReportForAggregation = {
    pam_user_id: "pam-b",
    status: "draft",
    snapshot_generated_at: null,
    metrics: fixtureMetrics({
      pam_user_id: "pam-b",
      generated_at: "2026-07-15T11:00:00.000Z", // more recent
      commercial: {
        open_pipeline_usd: { sourced: 0, influenced: 350, total: 350 },
        won_revenue_usd: { sourced: 0, influenced: 0, total: 0 },
        opportunity_count_open: 1,
        opportunities_created_count: 0,
        deals_won_count: 0,
        targets: [],
        contributing_open_pipeline: [{ opportunity_id: "opp-shared", attribution_type: "partner_influenced", usd_value: 350 }], // deal_value edited + attribution changed since PAM A's freeze
        contributing_won_revenue: [],
        contributing_opportunities_created: [],
      },
    }),
  };

  const result = aggregateTeamCommercial([pamA, pamB]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].opportunity_id, "opp-shared");
  assert.equal(result.conflicts[0].entries.length, 2);
  assert.equal(result.open_pipeline_usd.influenced, 350, "the most recent sighting (PAM B, live, later timestamp) must win the money total");
  assert.equal(result.open_pipeline_usd.sourced, 0);
  assert.equal(result.opportunity_count_open, 1, "still counted once despite the conflict");
});

// ---- Team aggregation: marketing --------------------------------------

test("aggregateTeamMarketing sums activity counts and dedupes contributing opportunities, respecting canonical status semantics (open/won/lost)", () => {
  const pamA: PamReportForAggregation = {
    pam_user_id: "pam-a",
    status: "draft",
    snapshot_generated_at: null,
    metrics: fixtureMetrics({
      generated_at: "2026-07-15T10:00:00.000Z",
      marketing: {
        activities: [],
        activity_count: 2,
        commercial_impact: {
          unique_linked_opportunity_count: 2,
          open_pipeline_usd: 100,
          won_revenue_usd: 0,
          contributing_opportunities: [
            { opportunity_id: "opp-1", status: "open", usd_value: 100 },
            { opportunity_id: "opp-lost", status: "lost", usd_value: 500 },
          ],
        },
      },
    }),
  };
  const pamB: PamReportForAggregation = {
    pam_user_id: "pam-b",
    status: "draft",
    snapshot_generated_at: null,
    metrics: fixtureMetrics({
      pam_user_id: "pam-b",
      generated_at: "2026-07-15T10:00:00.000Z",
      marketing: {
        activities: [],
        activity_count: 1,
        commercial_impact: {
          unique_linked_opportunity_count: 1,
          open_pipeline_usd: 0,
          won_revenue_usd: 250,
          contributing_opportunities: [{ opportunity_id: "opp-2", status: "won", usd_value: 250 }],
        },
      },
    }),
  };

  const result = aggregateTeamMarketing([pamA, pamB]);
  assert.equal(result.activity_count, 3);
  assert.equal(result.commercial_impact.unique_linked_opportunity_count, 3, "a lost opportunity still counts toward uniqueness");
  assert.equal(result.commercial_impact.open_pipeline_usd, 100);
  assert.equal(result.commercial_impact.won_revenue_usd, 250);
  assert.equal(result.conflicts.length, 0);
});
