// Phase 5A: DB-backed tests for the partner_opportunities ledger -- direct
// @workspace/db + service-layer calls against a disposable Postgres, no
// HTTP server (route-level authz is covered separately in
// tests/opportunitiesAuthz.test.ts). Proves both the DB constraints
// (uniqueness, positivity) and the KPI/target-cascade computations,
// including the historical-cutover / credit-override model.
//
//   DATABASE_URL=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... tsx --test tests/partnerOpportunities.test.ts
//
// No Tavily/DeepSeek/HubSpot/live-FX calls: every fixture uses currency
// "USD" only, which resolveFx() resolves at rate=1 without ever touching
// the network (see services/fx.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and, inArray } from "drizzle-orm";
import { db, pool, companiesTable, territoriesTable, usersTable, partnerOpportunitiesTable, metricTargetsTable, channelChangeEventsTable } from "@workspace/db";
import { computeMetric } from "../src/services/kpiService";
import { getAnnualCascade, upsertAnnualTarget, getAnnualTarget } from "../src/services/targetService";

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  return cause?.code === "23505" && !!cause.message?.includes(constraintName);
}

function isCheckViolation(err: unknown, constraintName: string): boolean {
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  return cause?.code === "23514" && !!cause.message?.includes(constraintName);
}

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `Phase5A-${label}-${Date.now()}-${counter}`;
}

const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdUserIds: string[] = [];
const createdOpportunityIds: string[] = [];
const createdAnnualTargetKeys: { metricKey: string; year: number }[] = [];

async function makeScope() {
  const [territory] = await db.insert(territoriesTable).values({ name: uniq("Territory") }).returning();
  const [user] = await db
    .insert(usersTable)
    .values({ name: uniq("PAM"), email: `${uniq("pam")}@example.test`, passwordHash: "test-fixture-hash", role: "pam" })
    .returning();
  const [company] = await db.insert(companiesTable).values({ name: uniq("Company"), country: "Unknown" }).returning();
  createdTerritoryIds.push(territory!.id);
  createdUserIds.push(user!.id);
  createdCompanyIds.push(company!.id);
  return { territory: territory!, user: user!, company: company! };
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

after(async () => {
  for (const id of createdOpportunityIds) {
    await db.delete(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  }
  for (const { metricKey, year } of createdAnnualTargetKeys) {
    await db
      .delete(metricTargetsTable)
      .where(and(eq(metricTargetsTable.metricKey, metricKey), eq(metricTargetsTable.year, year), eq(metricTargetsTable.period, "annual")));
  }
  for (const id of createdCompanyIds) await db.delete(companiesTable).where(eq(companiesTable.id, id));
  if (createdUserIds.length > 0) {
    // upsertAnnualTarget records a channel_change_events row with actor_user_id
    // set to the fixture user; that FK blocks deleting the user below unless
    // this test's own audit rows are cleared first.
    await db.delete(channelChangeEventsTable).where(inArray(channelChangeEventsTable.actorUserId, createdUserIds));
  }
  for (const id of createdUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  for (const id of createdTerritoryIds) await db.delete(territoriesTable).where(eq(territoriesTable.id, id));
  await pool.end();
});

// ---- DB constraints ---------------------------------------------------------

test("partner_opportunities_deal_value_positive: a non-positive deal_value is rejected", async () => {
  const { territory, user, company } = await makeScope();
  await assert.rejects(
    () => db.insert(partnerOpportunitiesTable).values(baseOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, dealValue: "0" })),
    (err: unknown) => isCheckViolation(err, "partner_opportunities_deal_value_positive"),
  );
});

test("partner_opportunities_credit_value_positive: a non-positive credit_value is rejected, but null is allowed", async () => {
  const { territory, user, company } = await makeScope();
  await assert.rejects(
    () =>
      db
        .insert(partnerOpportunitiesTable)
        .values(baseOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, creditValue: "-5" })),
    (err: unknown) => isCheckViolation(err, "partner_opportunities_credit_value_positive"),
  );

  const ok = await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, creditValue: null });
  assert.equal(ok.creditValue, null, "credit_value must remain nullable when absent");
});

test("manual opportunity may have null external_id, and multiple manual rows may all have null external_id", async () => {
  const { territory, user, company } = await makeScope();
  const a = await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, sourceSystem: "manual", externalId: null });
  const b = await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, sourceSystem: "manual", externalId: null });
  assert.equal(a.externalId, null);
  assert.equal(b.externalId, null);
  assert.notEqual(a.id, b.id);
});

test("partner_opportunities_source_external_unique: duplicate source_system + external_id is rejected", async () => {
  const { territory, user, company } = await makeScope();
  const externalId = uniq("ext");
  await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, sourceSystem: "import", externalId });

  await assert.rejects(
    () =>
      db
        .insert(partnerOpportunitiesTable)
        .values(baseOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, sourceSystem: "import", externalId })),
    (err: unknown) => isUniqueViolation(err, "partner_opportunities_source_external_unique"),
  );
});

test("partner_opportunities_source_external_unique: different source_system values may reuse the same external_id without collision", async () => {
  const { territory, user, company } = await makeScope();
  const externalId = uniq("ext");
  const a = await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, sourceSystem: "import", externalId });
  const b = await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, sourceSystem: "hubspot", externalId });
  assert.equal(a.externalId, externalId);
  assert.equal(b.externalId, externalId);
  assert.notEqual(a.sourceSystem, b.sourceSystem);
});

test("metric_targets_global_annual_unique: a second raw annual row for the same metric_key+year is rejected", async () => {
  const year = 2900 + Math.floor(Math.random() * 90); // sandbox year, never collides with real target data
  createdAnnualTargetKeys.push({ metricKey: "closed_revenue", year });
  await db.insert(metricTargetsTable).values({
    metricKey: "closed_revenue",
    year,
    period: "annual",
    territoryId: null,
    pamUserId: null,
    targetValue: "1000",
  });

  await assert.rejects(
    () =>
      db.insert(metricTargetsTable).values({
        metricKey: "closed_revenue",
        year,
        period: "annual",
        territoryId: null,
        pamUserId: null,
        targetValue: "2000",
      }),
    (err: unknown) => isUniqueViolation(err, "metric_targets_global_annual_unique"),
  );
});

test("upsertAnnualTarget: calling twice for the same metric/year updates the same row in place rather than duplicating", async () => {
  const year = 2900 + Math.floor(Math.random() * 90) + 100;
  createdAnnualTargetKeys.push({ metricKey: "closed_revenue", year });

  const first = await upsertAnnualTarget({ metricKey: "closed_revenue", year, targetValue: 1000, note: null, actingUserId: createdUserIds[0]! });
  const second = await upsertAnnualTarget({ metricKey: "closed_revenue", year, targetValue: 5000, note: "revised", actingUserId: createdUserIds[0]! });

  assert.equal(first.id, second.id, "the annual row must be updated in place, not duplicated");
  const final = await getAnnualTarget("closed_revenue", year);
  assert.equal(Number(final!.targetValue), 5000);
  assert.equal(final!.note, "revised");
});

// ---- Pipeline (current-state) attribution isolation -------------------------

test("an open partner_sourced opportunity contributes only to sourced pipeline, never influenced", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, attributionType: "partner_sourced", dealValue: "1500" });

  const target = { territoryId: territory.id, territoryName: territory.name };
  const sourced = await computeMetric("partner_sourced_pipeline", "2026-q3", target);
  const influenced = await computeMetric("partner_influenced_pipeline", "2026-q3", target);
  assert.equal(sourced.current, 1500);
  assert.equal(influenced.current, 0);
});

test("an open partner_influenced opportunity contributes only to influenced pipeline, never sourced", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, attributionType: "partner_influenced", dealValue: "750" });

  const target = { territoryId: territory.id, territoryName: territory.name };
  const sourced = await computeMetric("partner_sourced_pipeline", "2026-q3", target);
  const influenced = await computeMetric("partner_influenced_pipeline", "2026-q3", target);
  assert.equal(sourced.current, 0);
  assert.equal(influenced.current, 750);
});

test("a won opportunity leaves pipeline and instead contributes to closed revenue", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    attributionType: "partner_sourced",
    status: "won",
    dealValue: "2200",
    closedAt: new Date("2026-08-05T00:00:00.000Z"),
  });

  const target = { territoryId: territory.id, territoryName: territory.name };
  const pipeline = await computeMetric("partner_sourced_pipeline", "2026-q3", target);
  const closedRevenue = await computeMetric("closed_revenue", "2026-q3", target);
  assert.equal(pipeline.current, 0, "a won opportunity must never contribute to pipeline");
  assert.equal(closedRevenue.current, 2200);
});

test("a lost opportunity contributes to neither pipeline nor closed revenue", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    attributionType: "partner_sourced",
    status: "lost",
    dealValue: "999",
    closedAt: new Date("2026-08-05T00:00:00.000Z"),
  });

  const target = { territoryId: territory.id, territoryName: territory.name };
  const pipeline = await computeMetric("partner_sourced_pipeline", "2026-q3", target);
  const closedRevenue = await computeMetric("closed_revenue", "2026-q3", target);
  assert.equal(pipeline.current, 0);
  assert.equal(closedRevenue.current, 0);
});

// ---- Period-flow filters (closed_revenue / opportunities_created) -----------

test("closed_revenue respects closed_at's reporting period -- a Q2 close does not appear in a Q3 query and vice versa", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    status: "won",
    dealValue: "300",
    closedAt: new Date("2026-05-15T00:00:00.000Z"), // Q2
  });
  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    status: "won",
    dealValue: "700",
    closedAt: new Date("2026-08-05T00:00:00.000Z"), // Q3
  });

  const target = { territoryId: territory.id, territoryName: territory.name };
  const q2 = await computeMetric("closed_revenue", "2026-q2", target);
  const q3 = await computeMetric("closed_revenue", "2026-q3", target);
  assert.equal(q2.current, 300);
  assert.equal(q3.current, 700);
});

test("opportunities_created respects opportunity_date's reporting period, regardless of status", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, status: "open", opportunityDate: "2026-07-10" });
  await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, status: "won", opportunityDate: "2026-07-20", closedAt: new Date("2026-08-01") });
  await insertOpp({ territoryId: territory.id, assignedUserId: user.id, companyId: company.id, status: "lost", opportunityDate: "2026-04-01" }); // Q2, excluded from Q3 query

  const target = { territoryId: territory.id, territoryName: territory.name };
  const q3 = await computeMetric("opportunities_created", "2026-q3", target);
  assert.equal(q3.current, 2, "both the open and won opportunities opened in Q3 must count, regardless of current status");
});

// ---- Historical cutover -------------------------------------------------------

test("historical cutover: an open opportunity dated well before app go-live still appears in current pipeline (pipeline is current-state, never opportunity_date-filtered)", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    attributionType: "partner_sourced",
    status: "open",
    dealValue: "4400",
    opportunityDate: "2023-01-01", // years before go-live
  });

  const target = { territoryId: territory.id, territoryName: territory.name };
  const pipeline = await computeMetric("partner_sourced_pipeline", "2026-q3", target);
  assert.equal(pipeline.current, 4400);
});

test("historical cutover: a won deal from earlier in 2026 contributes to 2026 closed revenue reporting", async () => {
  const { territory, user, company } = await makeScope();
  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    status: "won",
    dealValue: "1800",
    opportunityDate: "2026-01-05",
    closedAt: new Date("2026-02-10T00:00:00.000Z"),
  });

  const target = { territoryId: territory.id, territoryName: territory.name };
  const q1 = await computeMetric("closed_revenue", "2026-q1", target);
  assert.equal(q1.current, 1800);
});

// ---- Credit-aware target attainment (getAnnualCascade), isolated via a --------
// ---- sandbox year no other fixture/test in this suite ever touches. ----------

// Deliberately in the PAST (not the future): computeClosedRevenue's
// reporting path clamps its upper date bound to "today" via
// effectiveAsOfDateStr (a report can never show data "as of" a date beyond
// today), so a future sandbox year would always read back 0 regardless of
// fixture dates. getAnnualCascade's credit-aware actual has no such
// clamping, but the reporting-side assertions below need a year whose
// range is already fully in the past relative to whenever this suite runs.
const SANDBOX_YEAR = 1990;

test("historical closed_at is preserved verbatim when credit_date differs -- it is never edited to match the target period", async () => {
  const { territory, user, company } = await makeScope();
  const row = await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    status: "won",
    dealValue: "5000",
    closedAt: new Date(`${SANDBOX_YEAR - 1}-11-15T00:00:00.000Z`),
    creditValue: "6000",
    creditDate: `${SANDBOX_YEAR}-01-01`,
  });

  assert.equal(row.closedAt?.toISOString().slice(0, 10), `${SANDBOX_YEAR - 1}-11-15`, "closed_at must stay the true historical date");
  assert.equal(row.creditDate, `${SANDBOX_YEAR}-01-01`);
});

test("a historical contract with a valid later credit_date contributes to that year's target attainment without appearing as that year's closed revenue", async () => {
  const { territory, user, company } = await makeScope();
  const before = await getAnnualCascade("closed_revenue", SANDBOX_YEAR);

  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    status: "won",
    dealValue: "1000",
    closedAt: new Date(`${SANDBOX_YEAR - 1}-11-15T00:00:00.000Z`),
    creditValue: "5000",
    creditDate: `${SANDBOX_YEAR}-01-01`,
  });

  const after = await getAnnualCascade("closed_revenue", SANDBOX_YEAR);
  assert.equal((after.actual ?? 0) - (before.actual ?? 0), 5000, "credit_value/credit_date must drive target attainment for the credited year");

  // Reporting closed_revenue for the sandbox year must NOT include this
  // opportunity at all -- its true closed_at is the prior year.
  const reportingThisYear = await computeMetric("closed_revenue", `${SANDBOX_YEAR}-ytd`, { territoryId: territory.id, territoryName: territory.name });
  assert.equal(reportingThisYear.current, 0, "closed_revenue reporting must use the true closed_at, never credit_date");

  // Reporting closed_revenue for the PRIOR year (the true closed_at year)
  // must show the true deal_value, never the credited override.
  const reportingPriorYear = await computeMetric("closed_revenue", `${SANDBOX_YEAR - 1}-ytd`, { territoryId: territory.id, territoryName: territory.name });
  assert.equal(reportingPriorYear.current, 1000, "closed_revenue reporting must use deal_value, never credit_value");
});

test("credit_value overrides deal_value only for target attainment, never for closed_revenue reporting", async () => {
  // Covered jointly by the two assertions above (5000 credited vs 1000
  // reported) -- this test asserts the same invariant from the opposite
  // direction: a fresh fixture whose credit_date falls in the SAME year as
  // closed_at still uses creditValue (not dealValue) for attainment.
  const { territory, user, company } = await makeScope();
  const before = await getAnnualCascade("closed_revenue", SANDBOX_YEAR);

  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    status: "won",
    dealValue: "100",
    closedAt: new Date(`${SANDBOX_YEAR}-03-01T00:00:00.000Z`),
    creditValue: "999",
    creditDate: `${SANDBOX_YEAR}-03-01`,
  });

  const after = await getAnnualCascade("closed_revenue", SANDBOX_YEAR);
  assert.equal((after.actual ?? 0) - (before.actual ?? 0), 999);
});

test("a normal manual won opportunity with no credit override falls back to deal_value + closed_at for target attainment", async () => {
  const { territory, user, company } = await makeScope();
  const before = await getAnnualCascade("closed_revenue", SANDBOX_YEAR);

  await insertOpp({
    territoryId: territory.id,
    assignedUserId: user.id,
    companyId: company.id,
    status: "won",
    dealValue: "2500",
    closedAt: new Date(`${SANDBOX_YEAR}-06-01T00:00:00.000Z`),
    creditValue: null,
    creditDate: null,
  });

  const after = await getAnnualCascade("closed_revenue", SANDBOX_YEAR);
  assert.equal((after.actual ?? 0) - (before.actual ?? 0), 2500, "with no credit override, attainment must fall back to deal_value/closed_at");
});
