// Phase 12 Aniri PAM-level intelligence: DB-backed tests for
// getPamOverview -- direct @workspace/db + service-layer calls against a
// disposable Postgres, no HTTP server (route-level auth/resolution is
// covered separately in tests/pamOverviewRoute.test.ts, which needs a live
// seeded server). Same pattern as tests/partnerOpportunities.test.ts.
//
//   DATABASE_URL=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... tsx --test tests/pamOverviewService.test.ts
//
// No Tavily/DeepSeek/HubSpot/live-FX calls: every fixture uses currency
// "USD" only, which resolveFx() resolves at rate=1 without ever touching
// the network (see services/fx.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  territoriesTable,
  usersTable,
  partnerOpportunitiesTable,
  partnerRelationshipsTable,
  partnerActivitiesTable,
  partnerRecruitmentsTable,
  prospectsTable,
  channelChangeEventsTable,
} from "@workspace/db";
import { getPamOverview } from "../src/services/pamOverviewService";

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `Phase12Overview-${label}-${Date.now()}-${counter}`;
}

const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdUserIds: string[] = [];
const createdOpportunityIds: string[] = [];
const createdProspectIds: string[] = [];

after(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(channelChangeEventsTable).where(inArray(channelChangeEventsTable.actorUserId, createdUserIds));
  }
  for (const id of createdOpportunityIds) await db.delete(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  if (createdCompanyIds.length > 0) {
    await db.delete(partnerRecruitmentsTable).where(inArray(partnerRecruitmentsTable.companyId, createdCompanyIds));
    await db.delete(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.companyId, createdCompanyIds));
  }
  for (const id of createdProspectIds) await db.delete(prospectsTable).where(eq(prospectsTable.id, id));
  for (const id of createdCompanyIds) await db.delete(companiesTable).where(eq(companiesTable.id, id));
  for (const id of createdUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  for (const id of createdTerritoryIds) await db.delete(territoriesTable).where(eq(territoriesTable.id, id));
  await pool.end();
});

async function makeCompany() {
  const [company] = await db.insert(companiesTable).values({ name: uniq("Company"), country: "Unknown" }).returning();
  createdCompanyIds.push(company!.id);
  return company!;
}

async function makePam() {
  const [pam] = await db
    .insert(usersTable)
    .values({ name: uniq("PAM"), email: `${uniq("pam")}@example.test`, passwordHash: "test-fixture-hash", role: "pam", active: true })
    .returning();
  createdUserIds.push(pam!.id);
  return pam!;
}

async function makeTerritoryOwnedBy(pamId: string | null) {
  const [territory] = await db.insert(territoriesTable).values({ name: uniq("Territory"), ownerUserId: pamId }).returning();
  createdTerritoryIds.push(territory!.id);
  return territory!;
}

function baseOpp(overrides: Partial<typeof partnerOpportunitiesTable.$inferInsert> & { territoryId: string; assignedUserId: string; companyId: string }) {
  return {
    name: uniq("Deal"),
    attributionType: "partner_sourced" as const,
    status: "open" as const,
    dealValue: "1000",
    currency: "USD" as const,
    opportunityDate: "2026-07-01",
    sourceSystem: "manual" as const,
    ...overrides,
  };
}

async function insertOpp(values: Parameters<typeof baseOpp>[0]) {
  const [row] = await db.insert(partnerOpportunitiesTable).values(baseOpp(values)).returning();
  createdOpportunityIds.push(row!.id);
  return row!;
}

async function insertRelationship(values: {
  companyId: string;
  territoryId: string;
  assignedUserId: string | null;
  status: "active" | "dormant" | "closed" | "needs_review";
  nextAction?: string;
}) {
  const [row] = await db
    .insert(partnerRelationshipsTable)
    .values({ originType: values.status === "needs_review" ? "opportunity_import" : "manual", ...values })
    .returning();
  return row!;
}

async function insertRecruitment(values: {
  companyId: string;
  territoryId: string;
  assignedUserId: string | null;
  stage?: "accepted" | "contacting";
  stageEnteredAt?: Date;
}) {
  const [prospect] = await db
    .insert(prospectsTable)
    .values({
      companyId: values.companyId,
      territoryId: values.territoryId,
      status: "accepted",
      priority: "A",
      assignedUserId: values.assignedUserId,
      partnerType: "Reseller",
      whyItFits: "test fixture",
      whyNow: "test fixture",
    })
    .returning();
  createdProspectIds.push(prospect!.id);
  const [row] = await db
    .insert(partnerRecruitmentsTable)
    .values({ prospectId: prospect!.id, stage: "contacting", ...values })
    .returning();
  return row!;
}

const SANDBOX_PERIOD = "2999-q1"; // far-future, never collides with any other fixture/test

// ---- No territory: honest "unavailable", never fabricated -----------------

test("a PAM with no canonical territory gets an empty portfolio/recruitment and an explicit availability note -- never fabricated data", async () => {
  const pam = await makePam();
  const overview = await getPamOverview(pam, SANDBOX_PERIOD);

  assert.deepEqual(overview.identity.territories, []);
  assert.equal(overview.portfolio.assigned_partner_count, 0);
  assert.deepEqual(overview.portfolio.assigned_partners, []);
  assert.equal(overview.recruitment.active_count, 0);
  assert.deepEqual(overview.performance, []);
  assert.ok(
    overview.availability.some((n) => n.toLowerCase().includes("no territory")),
    "must explicitly say why portfolio/recruitment are empty, never leave it unexplained",
  );
});

// ---- Performance: no invented targets --------------------------------------

test("no metric_targets configured for the period -> every performance row is status=no_target, never a fabricated attainment figure", async () => {
  const pam = await makePam();
  await makeTerritoryOwnedBy(pam.id);
  const overview = await getPamOverview(pam, SANDBOX_PERIOD);

  assert.ok(overview.performance.length > 0, "expected at least one targetable metric row for this PAM's owned territory");
  for (const row of overview.performance) {
    assert.equal(row.status, "no_target");
    assert.equal(row.target, null);
    assert.equal(row.progress_percent, null);
  }
});

// ---- Portfolio aggregation --------------------------------------------------

test("portfolio counts only confirmed partners assigned to the PAM; needs_review is review context and closed is historical", async () => {
  const pam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);

  const activeCo = await makeCompany();
  const dormantCo = await makeCompany();
  const closedCo = await makeCompany();
  const needsReviewCo = await makeCompany();

  await insertRelationship({ companyId: activeCo.id, territoryId: territory.id, assignedUserId: pam.id, status: "active", nextAction: "Follow up" });
  await insertRelationship({ companyId: dormantCo.id, territoryId: territory.id, assignedUserId: pam.id, status: "dormant" });
  await insertRelationship({ companyId: closedCo.id, territoryId: territory.id, assignedUserId: pam.id, status: "closed" });
  await insertRelationship({ companyId: needsReviewCo.id, territoryId: territory.id, assignedUserId: pam.id, status: "needs_review" });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  const partnerNames = overview.portfolio.assigned_partners.map((p) => p.company_name);

  assert.equal(overview.portfolio.assigned_partner_count, 2, "only active + dormant are confirmed current partners");
  assert.equal(overview.portfolio.active_partner_count, 1);
  assert.deepEqual(overview.portfolio.counts_by_status, { active: 1, dormant: 1, closed: 1 });
  assert.equal("needs_review" in overview.portfolio.counts_by_status, false);
  assert.equal(overview.portfolio.needs_review_count, 1);
  assert.ok(partnerNames.includes(activeCo.name));
  assert.ok(partnerNames.includes(dormantCo.name));
  assert.ok(!partnerNames.includes(closedCo.name), "closed is historical, never a current assigned partner");
  assert.ok(!partnerNames.includes(needsReviewCo.name), "needs_review is not a confirmed partner");

  // needs_review surfaces only as review/attention context.
  assert.equal(overview.portfolio.needs_attention_count, 1, "only the needs_review relationship needs attention (active one has a next_action set)");
  assert.ok(overview.portfolio.needs_attention.some((r) => r.company_name === needsReviewCo.name && r.status === "needs_review"));
  assert.ok(overview.availability.some((n) => n.includes("needs_review") && n.includes("not confirmed partnerships")));
});

test("a relationship in the PAM's territory but assigned to someone else, or unassigned, is NOT theirs", async () => {
  const pam = await makePam();
  const otherPam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);

  const reassignedCo = await makeCompany();
  const unassignedActiveCo = await makeCompany();
  const unassignedReviewCo = await makeCompany();
  await insertRelationship({ companyId: reassignedCo.id, territoryId: territory.id, assignedUserId: otherPam.id, status: "active" });
  await insertRelationship({ companyId: unassignedActiveCo.id, territoryId: territory.id, assignedUserId: null, status: "active" });
  await insertRelationship({ companyId: unassignedReviewCo.id, territoryId: territory.id, assignedUserId: null, status: "needs_review" });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  const surfaced = [
    ...overview.portfolio.assigned_partners.map((p) => p.company_name),
    ...overview.portfolio.needs_attention.map((p) => p.company_name),
  ];

  assert.equal(overview.portfolio.assigned_partner_count, 0);
  assert.equal(overview.portfolio.needs_review_count, 0, "an unassigned needs_review relationship is not this PAM's");
  assert.equal(overview.portfolio.needs_attention_count, 0);
  for (const company of [reassignedCo, unassignedActiveCo, unassignedReviewCo]) {
    assert.ok(!surfaced.includes(company.name), `${company.name} must not be attributed to the territory owner`);
  }
});

test("a relationship assigned to the PAM is included even outside any territory they own", async () => {
  const pam = await makePam();
  const otherPam = await makePam();
  await makeTerritoryOwnedBy(pam.id);
  const foreignTerritory = await makeTerritoryOwnedBy(otherPam.id);
  const company = await makeCompany();
  await insertRelationship({ companyId: company.id, territoryId: foreignTerritory.id, assignedUserId: pam.id, status: "active", nextAction: "Plan QBR" });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  assert.equal(overview.portfolio.assigned_partner_count, 1);
  assert.ok(overview.portfolio.assigned_partners.some((p) => p.company_name === company.name));

  // Also true for a PAM who owns no territory at all.
  const territorylessPam = await makePam();
  const company2 = await makeCompany();
  await insertRelationship({ companyId: company2.id, territoryId: foreignTerritory.id, assignedUserId: territorylessPam.id, status: "dormant" });
  const overview2 = await getPamOverview(territorylessPam, SANDBOX_PERIOD);
  assert.deepEqual(overview2.identity.territories, []);
  assert.equal(overview2.portfolio.assigned_partner_count, 1);
});

test("recent_activity surfaces partner_activities logged against relationships assigned to this PAM, most recent first", async () => {
  const pam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);
  const company = await makeCompany();
  const relationship = await insertRelationship({ companyId: company.id, territoryId: territory.id, assignedUserId: pam.id, status: "active" });

  await db.insert(partnerActivitiesTable).values({ relationshipId: relationship.id, activityType: "call", note: "Older call", occurredAt: new Date("2026-01-01T00:00:00.000Z") });
  await db.insert(partnerActivitiesTable).values({ relationshipId: relationship.id, activityType: "meeting", note: "Newer meeting", occurredAt: new Date("2026-02-01T00:00:00.000Z") });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  assert.ok(overview.activity.recent.length >= 2);
  assert.equal(overview.activity.recent[0]!.note, "Newer meeting", "most recent activity must come first");
});

// ---- Multiple territories ------------------------------------------------------

test("a PAM owning two territories keeps both -- identity and per-territory performance", async () => {
  const pam = await makePam();
  const territoryA = await makeTerritoryOwnedBy(pam.id);
  const territoryB = await makeTerritoryOwnedBy(pam.id);

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);

  assert.deepEqual(
    overview.identity.territories.map((t) => t.territory_id).sort(),
    [territoryA.id, territoryB.id].sort(),
  );
  const performanceTerritories = new Set(overview.performance.map((row) => row.territory_id));
  assert.ok(performanceTerritories.has(territoryA.id) && performanceTerritories.has(territoryB.id), "performance rows must exist for both territories");
});

// ---- DRUID-recorded opportunities ----------------------------------------------

test("druid_recorded_opportunities is labelled as DRUID-recorded data, never the complete HubSpot pipeline", async () => {
  const pam = await makePam();
  const overview = await getPamOverview(pam, SANDBOX_PERIOD);

  assert.equal("pipeline" in overview, false, "no field may claim to be the PAM's pipeline");
  assert.equal(overview.druid_recorded_opportunities.source, "druid_partner_opportunities");
  assert.equal(overview.druid_recorded_opportunities.hubspot_pipeline, "not_included");
  assert.ok(
    overview.availability.some((n) => n.includes("not the complete HubSpot pipeline") && n.includes("not zero")),
    "must state that the HubSpot pipeline is unknown here, not zero",
  );
});

test("druid_recorded_opportunities aggregates open/won/lost counts and USD values, splits sourced vs influenced, and never invents a stalled score", async () => {
  const pam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);
  const company = await makeCompany();

  await insertOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, attributionType: "partner_sourced", status: "open", dealValue: "1000" });
  await insertOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, attributionType: "partner_influenced", status: "open", dealValue: "500" });
  await insertOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, status: "won", dealValue: "2000", closedAt: new Date("2026-03-01") });
  await insertOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, status: "lost", dealValue: "300", closedAt: new Date("2026-03-01") });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);

  assert.equal(overview.druid_recorded_opportunities.open_count, 2);
  assert.equal(overview.druid_recorded_opportunities.open_value_usd, 1500);
  assert.equal(overview.druid_recorded_opportunities.sourced_open_value_usd, 1000);
  assert.equal(overview.druid_recorded_opportunities.influenced_open_value_usd, 500);
  assert.equal(overview.druid_recorded_opportunities.won_count, 1);
  assert.equal(overview.druid_recorded_opportunities.won_value_usd, 2000);
  assert.equal(overview.druid_recorded_opportunities.lost_count, 1);
  assert.equal(overview.druid_recorded_opportunities.lost_value_usd, 300);
  assert.ok(overview.availability.some((n) => n.includes("stalled")), "must disclose there is no canonical stalled-opportunity rule rather than silently fabricating one");
});

test("past_due_open only lists OPEN opportunities whose expected_close_date has passed -- a plain date fact, not an invented verdict", async () => {
  const pam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);
  const company = await makeCompany();

  const pastDate = "2000-01-01"; // always in the past
  await insertOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, status: "open", dealValue: "100", expectedCloseDate: pastDate });
  await insertOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, status: "won", dealValue: "9999", expectedCloseDate: pastDate, closedAt: new Date("2026-01-01") });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  assert.equal(overview.druid_recorded_opportunities.past_due_open.length, 1);
  assert.equal(overview.druid_recorded_opportunities.past_due_open[0]!.deal_value_usd, 100, "a won opportunity must never appear in past_due_open even if its expected_close_date also passed");
});

test("largest_open is bounded and sorted by USD value, largest first", async () => {
  const pam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);
  const company = await makeCompany();

  for (const value of [100, 900, 500, 700, 300, 200, 800]) {
    await insertOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, status: "open", dealValue: String(value) });
  }

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  assert.ok(overview.druid_recorded_opportunities.largest_open.length <= 5, "largest_open must be bounded, never a full-table dump");
  const values = overview.druid_recorded_opportunities.largest_open.map((o) => o.deal_value_usd);
  assert.deepEqual(values, [...values].sort((a, b) => b - a), "must be sorted largest-first");
  assert.equal(values[0], 900);
});

// ---- Recruitment aggregation --------------------------------------------------

test("recruitment active/stalled counts and priority list reflect recruitments assigned to this PAM", async () => {
  const pam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);
  const company = await makeCompany();
  await insertRecruitment({
    companyId: company.id,
    territoryId: territory.id,
    assignedUserId: pam.id,
    stage: "contacting",
    stageEnteredAt: new Date("2000-01-01T00:00:00.000Z"), // far in the past -> definitely stalled
  });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  assert.equal(overview.recruitment.active_count, 1);
  assert.equal(overview.recruitment.stalled_count, 1);
  assert.ok(overview.recruitment.priority_recruitments.some((r) => r.company_name === company.name));
});

test("recruitment is selected by assignment: others' and unassigned recruitments in the PAM's territory are not theirs", async () => {
  const pam = await makePam();
  const otherPam = await makePam();
  const territory = await makeTerritoryOwnedBy(pam.id);
  const otherCo = await makeCompany();
  const unassignedCo = await makeCompany();
  await insertRecruitment({ companyId: otherCo.id, territoryId: territory.id, assignedUserId: otherPam.id });
  await insertRecruitment({ companyId: unassignedCo.id, territoryId: territory.id, assignedUserId: null });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  const names = overview.recruitment.priority_recruitments.map((r) => r.company_name);
  assert.equal(overview.recruitment.active_count, 0);
  assert.equal(overview.recruitment.stalled_count, 0);
  assert.ok(!names.includes(otherCo.name), "a recruitment assigned to another PAM must not appear");
  assert.ok(!names.includes(unassignedCo.name), "an unassigned recruitment must not silently become the territory owner's");
});

test("a recruitment assigned to the PAM stays theirs outside any territory they own, even with no territory at all", async () => {
  const pam = await makePam();
  const otherPam = await makePam();
  const foreignTerritory = await makeTerritoryOwnedBy(otherPam.id);
  const company = await makeCompany();
  await insertRecruitment({ companyId: company.id, territoryId: foreignTerritory.id, assignedUserId: pam.id });

  const overview = await getPamOverview(pam, SANDBOX_PERIOD);
  assert.deepEqual(overview.identity.territories, []);
  assert.equal(overview.recruitment.active_count, 1);
  assert.ok(overview.recruitment.priority_recruitments.some((r) => r.company_name === company.name));
});
