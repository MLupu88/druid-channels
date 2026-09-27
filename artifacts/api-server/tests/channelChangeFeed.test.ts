// Phase 11.6.1: Aniri / Channel Chief evidence infrastructure -- DB-backed
// (needs real users/territories/companies/prospects/recruitments/
// relationships/targets/opportunities rows), so this runs against a live
// disposable Postgres, same pattern as tests/annualCascadeAllocation.test.ts.
//
//   DATABASE_URL=... tsx --test tests/channelChangeFeed.test.ts
// or `pnpm run test:channel-change-feed` from artifacts/api-server with
// DATABASE_URL exported.
//
// Covers, end to end against real tables:
//   - target update captures before/after + actor
//   - target no-op produces no material event
//   - opportunity update captures only fields that actually changed + actor
//   - opportunity no-op produces no material event
//   - recruitment history normalizes correctly into the merged feed
//   - partner relationship history normalizes correctly into the merged feed
//   - since filtering and deterministic ordering
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, or, inArray } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  territoriesTable,
  companiesTable,
  prospectsTable,
  partnerRecruitmentsTable,
  partnerRecruitmentHistoryTable,
  partnerRelationshipsTable,
  partnerRelationshipHistoryTable,
  partnerOpportunitiesTable,
  channelChangeEventsTable,
  type User,
  type Territory,
  type Company,
} from "@workspace/db";
import { upsertTarget, deleteTarget } from "../src/services/targetService";
import { applyOpportunityCreate, applyOpportunityUpdate } from "../src/routes/opportunities";
import { getChannelChangeFeed } from "../src/services/channelChangeFeedService";

const TEST_METRIC_KEY = "new_partner_prospects";
const TEST_YEAR = 2032; // distinct from other target test files' TEST_YEAR to avoid any cross-file collision on a shared disposable DB

const createdUserIds: string[] = [];
const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdProspectIds: string[] = [];
const createdRecruitmentIds: string[] = [];
const createdRelationshipIds: string[] = [];
const createdOpportunityIds: string[] = [];
// channel_change_events rows inserted directly by a test (not via a service
// with a tracked actor/entity) -- see test I.
const createdChangeEventIds: string[] = [];

async function makeUser(namePrefix: string): Promise<User> {
  const [user] = await db
    .insert(usersTable)
    .values({ name: `${namePrefix} ${Date.now()}`, email: `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.example`, role: "pam" })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

async function makeTerritory(namePrefix: string, ownerUserId: string | null): Promise<Territory> {
  const [territory] = await db
    .insert(territoriesTable)
    .values({ name: `${namePrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ownerUserId })
    .returning();
  createdTerritoryIds.push(territory!.id);
  return territory!;
}

async function makeCompany(namePrefix: string): Promise<Company> {
  const [company] = await db
    .insert(companiesTable)
    .values({ name: `${namePrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, country: "Romania" })
    .returning();
  createdCompanyIds.push(company!.id);
  return company!;
}

after(async () => {
  // FK-safe reverse-ish order -- disposable DB, but still cleans up after itself.
  for (const id of createdOpportunityIds) await db.delete(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  // Only this file's events, never the whole table (other suites may share
  // the disposable DB). Every event this file writes is attributable by at
  // least one of: actor_user_id (every upsertTarget/deleteTarget/
  // applyOpportunity* call here passes a user this file created), entity_id
  // (this file's opportunities), or id (rows test I inserts directly with a
  // null actor and a random entity_id). Must run before users are deleted:
  // actor_user_id is ON DELETE no action; entity_id has no FK.
  const changeEventScopes = [
    createdUserIds.length > 0 ? inArray(channelChangeEventsTable.actorUserId, createdUserIds) : undefined,
    createdOpportunityIds.length > 0 ? inArray(channelChangeEventsTable.entityId, createdOpportunityIds) : undefined,
    createdChangeEventIds.length > 0 ? inArray(channelChangeEventsTable.id, createdChangeEventIds) : undefined,
  ].filter((c) => c !== undefined);
  if (changeEventScopes.length > 0) await db.delete(channelChangeEventsTable).where(or(...changeEventScopes));
  for (const id of createdRelationshipIds) {
    await db.delete(partnerRelationshipHistoryTable).where(eq(partnerRelationshipHistoryTable.relationshipId, id));
    await db.delete(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, id));
  }
  // applyOpportunityCreate now also reconciles a needs_review Portfolio
  // relationship for each opportunity's (company, territory) -- those rows
  // aren't in createdRelationshipIds, so sweep anything still referencing
  // this file's own territories/companies. partner_relationships.territory_id/
  // company_id/origin_recruitment_id are ON DELETE no action, so this must run
  // before recruitments/territories/companies are deleted below; history and
  // activity rows cascade from the relationship.
  if (createdTerritoryIds.length > 0 || createdCompanyIds.length > 0) {
    await db
      .delete(partnerRelationshipsTable)
      .where(
        or(
          createdTerritoryIds.length > 0 ? inArray(partnerRelationshipsTable.territoryId, createdTerritoryIds) : undefined,
          createdCompanyIds.length > 0 ? inArray(partnerRelationshipsTable.companyId, createdCompanyIds) : undefined,
        ),
      );
  }
  for (const id of createdRecruitmentIds) {
    await db.delete(partnerRecruitmentHistoryTable).where(eq(partnerRecruitmentHistoryTable.recruitmentId, id));
    await db.delete(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.id, id));
  }
  for (const id of createdProspectIds) await db.delete(prospectsTable).where(eq(prospectsTable.id, id));
  for (const id of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, id));
  }
  for (const id of createdCompanyIds) await db.delete(companiesTable).where(eq(companiesTable.id, id));
  for (const id of createdUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  await pool.end();
});

// ---- A/B: targets ----------------------------------------------------------

test("A: a target update records old/new target_value+note and the acting user, atomically with the write", async () => {
  const pam = await makeUser("Feed-Test-A-Pam");
  const territory = await makeTerritory("Feed-Test-A-Territory", pam.id);
  const actor1 = await makeUser("Feed-Test-A-Actor1");
  const actor2 = await makeUser("Feed-Test-A-Actor2");

  const created = await upsertTarget({
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q1`,
    territoryId: territory.id,
    pamUserId: pam.id,
    targetValue: 100,
    note: "initial",
    actingUserId: actor1.id,
  });

  const updated = await upsertTarget({
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q1`,
    territoryId: territory.id,
    pamUserId: pam.id,
    targetValue: 150,
    note: "revised after 1:1",
    actingUserId: actor2.id,
  });
  assert.equal(created.id, updated.id, "same upsert target row");

  const events = await db.select().from(channelChangeEventsTable).where(eq(channelChangeEventsTable.entityId, updated.id));
  assert.equal(events.length, 2, "expected one 'created' event and one 'updated' event");

  const updateEvent = events.find((e) => e.eventType === "updated");
  assert.ok(updateEvent, "expected an 'updated' event");
  assert.equal(updateEvent!.actorUserId, actor2.id);
  assert.deepEqual(updateEvent!.oldValues, { target_value: 100, note: "initial" });
  assert.deepEqual(updateEvent!.newValues, { target_value: 150, note: "revised after 1:1" });
});

test("B: re-saving a target with the exact same target_value and note produces no additional material event", async () => {
  const pam = await makeUser("Feed-Test-B-Pam");
  const territory = await makeTerritory("Feed-Test-B-Territory", pam.id);
  const actor = await makeUser("Feed-Test-B-Actor");

  const input = {
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q2`,
    territoryId: territory.id,
    pamUserId: pam.id,
    targetValue: 200,
    note: "steady",
    actingUserId: actor.id,
  };
  const first = await upsertTarget(input);
  await upsertTarget(input); // identical no-op re-save
  await upsertTarget(input); // and again

  const events = await db.select().from(channelChangeEventsTable).where(eq(channelChangeEventsTable.entityId, first.id));
  assert.equal(events.length, 1, "only the original 'created' event should exist -- no-op re-saves must never add events");
  assert.equal(events[0]!.eventType, "created");
});

test("target deletion records old_values (the deleted target/note) and the acting user, new_values null", async () => {
  const pam = await makeUser("Feed-Test-Del-Pam");
  const territory = await makeTerritory("Feed-Test-Del-Territory", pam.id);
  const actor = await makeUser("Feed-Test-Del-Actor");

  const created = await upsertTarget({
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q3`,
    territoryId: territory.id,
    pamUserId: pam.id,
    targetValue: 42,
    note: null,
    actingUserId: actor.id,
  });
  await deleteTarget(created.id, actor.id);

  const events = await db.select().from(channelChangeEventsTable).where(eq(channelChangeEventsTable.entityId, created.id));
  const deleteEvent = events.find((e) => e.eventType === "deleted");
  assert.ok(deleteEvent);
  assert.equal(deleteEvent!.actorUserId, actor.id);
  assert.deepEqual(deleteEvent!.oldValues, { target_value: 42, note: null });
  assert.equal(deleteEvent!.newValues, null);
});

test("upsertTarget: concurrent upserts to a brand-new target key never both record 'created' -- old_values on the 'updated' event is truthful, never null", async () => {
  const pam = await makeUser("Feed-Test-Race-Pam");
  const territory = await makeTerritory("Feed-Test-Race-Territory", pam.id);
  const actor = await makeUser("Feed-Test-Race-Actor");

  const input = {
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q1`,
    territoryId: territory.id,
    pamUserId: pam.id,
    note: null as string | null,
    actingUserId: actor.id,
  };
  // Two concurrent upserts racing to create the SAME (metric/year/period/
  // pam/territory) row -- without the advisory lock guarding the
  // pre-image SELECT, one of these could see "no existing row" even
  // though the other already committed one, and would falsely record a
  // second 'created' event with old_values null instead of a truthful
  // 'updated' event.
  const [a, b] = await Promise.all([upsertTarget({ ...input, targetValue: 10 }), upsertTarget({ ...input, targetValue: 20 })]);
  assert.equal(a.id, b.id, "both calls must resolve to the same underlying row");

  const events = await db.select().from(channelChangeEventsTable).where(eq(channelChangeEventsTable.entityId, a.id));
  const createdEvents = events.filter((e) => e.eventType === "created");
  const updatedEvents = events.filter((e) => e.eventType === "updated");
  assert.equal(createdEvents.length, 1, "exactly one 'created' event, even when two upserts race for the same new key");
  assert.equal(updatedEvents.length, 1, "exactly one 'updated' event -- the second racer must never be misrecorded as a second 'created'");
  assert.notEqual(updatedEvents[0]!.oldValues, null, "the 'updated' event's old_values must reflect the winner's real prior state, never null");
});

test("deleteTarget: a second concurrent delete of the same id never reports false success or duplicates the 'deleted' event", async () => {
  const pam = await makeUser("Feed-Test-DelRace-Pam");
  const territory = await makeTerritory("Feed-Test-DelRace-Territory", pam.id);
  const actor = await makeUser("Feed-Test-DelRace-Actor");

  const created = await upsertTarget({
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q2`,
    territoryId: territory.id,
    pamUserId: pam.id,
    targetValue: 7,
    note: null,
    actingUserId: actor.id,
  });

  const [first, second] = await Promise.all([deleteTarget(created.id, actor.id), deleteTarget(created.id, actor.id)]);
  const successes = [first, second].filter((r) => r !== null);
  assert.equal(successes.length, 1, "exactly one of the two racing deletes should report success -- the loser must return null, not a stale/false success");

  const events = await db.select().from(channelChangeEventsTable).where(eq(channelChangeEventsTable.entityId, created.id));
  const deleteEvents = events.filter((e) => e.eventType === "deleted");
  assert.equal(deleteEvents.length, 1, "exactly one 'deleted' event -- the loser must never record a duplicate");
});

// ---- C/D: opportunities ----------------------------------------------------

test("C: an opportunity update captures only the fields that actually changed, plus the acting user", async () => {
  const company = await makeCompany("Feed-Test-C-Company");
  const pam = await makeUser("Feed-Test-C-Pam");
  const territory = await makeTerritory("Feed-Test-C-Territory", pam.id);
  const actor = await makeUser("Feed-Test-C-Actor");

  const created = await db.transaction((tx) =>
    applyOpportunityCreate(tx, {
      name: "Feed Test C Deal",
      companyId: company.id,
      territoryId: territory.id,
      assignedUserId: pam.id,
      attributionType: "partner_sourced",
      status: "open",
      dealValue: "10000",
      currency: "USD",
      opportunityDate: "2032-01-01",
      note: "original note",
      createdByUserId: actor.id,
    }),
  );
  createdOpportunityIds.push(created.id);

  const updated = await db.transaction((tx) =>
    applyOpportunityUpdate(tx, created, { dealValue: "25000", note: "updated note, no material change here" }, actor.id),
  );
  assert.equal(Number(updated.dealValue), 25000);

  const events = await db.select().from(channelChangeEventsTable).where(eq(channelChangeEventsTable.entityId, created.id));
  const updateEvent = events.find((e) => e.eventType === "updated");
  assert.ok(updateEvent, "expected an 'updated' event for the material deal_value change");
  assert.equal(updateEvent!.actorUserId, actor.id);
  assert.deepEqual(updateEvent!.oldValues, { deal_value: 10000 });
  assert.deepEqual(updateEvent!.newValues, { deal_value: 25000 });
  // The note change is real and saved (asserted above via `updated`), but
  // must NEVER appear in the material diff.
  assert.ok(!("note" in updateEvent!.oldValues!));
});

test("C2: an opportunity update that doesn't touch company_id/territory_id still resolves company_name/territory_name in the feed's context", async () => {
  const company = await makeCompany("Feed-Test-C2-Company");
  const pam = await makeUser("Feed-Test-C2-Pam");
  const territory = await makeTerritory("Feed-Test-C2-Territory", pam.id);
  const actor = await makeUser("Feed-Test-C2-Actor");

  const created = await db.transaction((tx) =>
    applyOpportunityCreate(tx, {
      name: "Feed Test C2 Deal",
      companyId: company.id,
      territoryId: territory.id,
      assignedUserId: pam.id,
      attributionType: "partner_sourced",
      status: "open",
      dealValue: "10000",
      currency: "USD",
      opportunityDate: "2032-01-01",
      note: "original note",
      createdByUserId: actor.id,
    }),
  );
  createdOpportunityIds.push(created.id);

  // Only status changes here -- company_id/territory_id are untouched, so
  // they never appear in the event's old_values/new_values diff. The feed
  // must still resolve context from metadata (see applyOpportunityUpdate).
  await db.transaction((tx) => applyOpportunityUpdate(tx, created, { status: "won", closedAt: new Date("2032-02-01") }, actor.id));

  const feed = await getChannelChangeFeed({ limit: 200 });
  const item = feed.find((f) => f.entity_type === "opportunity" && f.entity_id === created.id && f.event_type === "updated");
  assert.ok(item, "expected an 'updated' feed item for this opportunity");
  assert.ok(!("company_id" in (item!.old_values ?? {})) && !("company_id" in (item!.new_values ?? {})), "company_id must not be in the diff -- it never changed");
  assert.equal(item!.context?.company_name, company.name);
  assert.equal(item!.context?.territory_name, territory.name);
});

test("D: an opportunity PATCH that only touches non-material fields (note) produces no material event", async () => {
  const company = await makeCompany("Feed-Test-D-Company");
  const pam = await makeUser("Feed-Test-D-Pam");
  const territory = await makeTerritory("Feed-Test-D-Territory", pam.id);
  const actor = await makeUser("Feed-Test-D-Actor");

  const created = await db.transaction((tx) =>
    applyOpportunityCreate(tx, {
      name: "Feed Test D Deal",
      companyId: company.id,
      territoryId: territory.id,
      assignedUserId: pam.id,
      attributionType: "partner_sourced",
      status: "open",
      dealValue: "5000",
      currency: "USD",
      opportunityDate: "2032-01-01",
      note: "v1",
      createdByUserId: actor.id,
    }),
  );
  createdOpportunityIds.push(created.id);

  await db.transaction((tx) => applyOpportunityUpdate(tx, created, { note: "v2" }, actor.id));
  await db.transaction((tx) => applyOpportunityUpdate(tx, created, { name: "Renamed Deal" }, actor.id));

  const events = await db.select().from(channelChangeEventsTable).where(eq(channelChangeEventsTable.entityId, created.id));
  assert.equal(events.length, 1, "only the original 'created' event should exist -- note/name-only PATCHes are real writes but never material events");
  assert.equal(events[0]!.eventType, "created");
});

// ---- E/F: recruitment + partner relationship history normalize into the feed ----

async function makeRecruitmentWithHistory(company: Company, territory: Territory, pam: User) {
  const [prospect] = await db
    .insert(prospectsTable)
    .values({
      companyId: company.id,
      territoryId: territory.id,
      partnerType: "reseller",
      priority: "A",
      whyItFits: "test fixture",
      whyNow: "test fixture",
    })
    .returning();
  createdProspectIds.push(prospect!.id);

  const [recruitment] = await db
    .insert(partnerRecruitmentsTable)
    .values({ prospectId: prospect!.id, companyId: company.id, territoryId: territory.id, assignedUserId: pam.id, stage: "accepted" })
    .returning();
  createdRecruitmentIds.push(recruitment!.id);

  const [history] = await db
    .insert(partnerRecruitmentHistoryTable)
    .values({ recruitmentId: recruitment!.id, fromStage: null, toStage: "accepted", changedByUserId: pam.id })
    .returning();

  return { recruitment: recruitment!, history: history! };
}

test("E: recruitment history normalizes into the feed as entity_type 'recruitment', event_type 'recruitment_created' for the initial (from_stage null) row, with company/territory display context", async () => {
  const company = await makeCompany("Feed-Test-E-Company");
  const pam = await makeUser("Feed-Test-E-Pam");
  const territory = await makeTerritory("Feed-Test-E-Territory", pam.id);
  const { recruitment, history } = await makeRecruitmentWithHistory(company, territory, pam);

  const feed = await getChannelChangeFeed({ limit: 200 });
  const item = feed.find((f) => f.id === history.id);
  assert.ok(item, "expected the recruitment history row to appear in the normalized feed");
  assert.equal(item!.entity_type, "recruitment");
  assert.equal(item!.entity_id, recruitment.id);
  assert.equal(item!.event_type, "recruitment_created");
  assert.equal(item!.actor_user_id, pam.id);
  assert.equal(item!.actor_name, pam.name);
  assert.equal(item!.old_values, null);
  assert.deepEqual(item!.new_values, { stage: "accepted" });
  assert.equal(item!.context?.company_name, company.name);
  assert.equal(item!.context?.territory_name, territory.name);
});

test("E2: a subsequent recruitment stage change normalizes as event_type 'stage_changed', with old_values.stage/new_values.stage", async () => {
  const company = await makeCompany("Feed-Test-E2-Company");
  const pam = await makeUser("Feed-Test-E2-Pam");
  const territory = await makeTerritory("Feed-Test-E2-Territory", pam.id);
  const { recruitment } = await makeRecruitmentWithHistory(company, territory, pam);

  const [stageChange] = await db
    .insert(partnerRecruitmentHistoryTable)
    .values({ recruitmentId: recruitment.id, fromStage: "accepted", toStage: "contacting", changedByUserId: pam.id })
    .returning();

  const feed = await getChannelChangeFeed({ limit: 200 });
  const item = feed.find((f) => f.id === stageChange!.id);
  assert.ok(item);
  assert.equal(item!.event_type, "stage_changed");
  assert.deepEqual(item!.old_values, { stage: "accepted" });
  assert.deepEqual(item!.new_values, { stage: "contacting" });
});

test("F: partner relationship history normalizes into the feed with entity_type 'partner_relationship', occurred_at from occurred_at (not created_at), and company/territory display context", async () => {
  const company = await makeCompany("Feed-Test-F-Company");
  const pam = await makeUser("Feed-Test-F-Pam");
  const territory = await makeTerritory("Feed-Test-F-Territory", pam.id);

  const [relationship] = await db
    .insert(partnerRelationshipsTable)
    .values({ companyId: company.id, territoryId: territory.id, assignedUserId: pam.id, status: "active", originType: "manual" })
    .returning();
  createdRelationshipIds.push(relationship!.id);

  // Deliberately backdated occurred_at, distinct from createdAt -- proves
  // the feed uses occurred_at, never created_at, for this source.
  const backdated = new Date("2031-05-01T00:00:00.000Z");
  const [history] = await db
    .insert(partnerRelationshipHistoryTable)
    .values({
      relationshipId: relationship!.id,
      eventType: "status_changed",
      fromStatus: "active",
      toStatus: "dormant",
      occurredAt: backdated,
      changedByUserId: pam.id,
    })
    .returning();

  const feed = await getChannelChangeFeed({ limit: 200 });
  const item = feed.find((f) => f.id === history!.id);
  assert.ok(item, "expected the relationship history row to appear in the normalized feed");
  assert.equal(item!.entity_type, "partner_relationship");
  assert.equal(item!.entity_id, relationship!.id);
  assert.equal(item!.event_type, "status_changed");
  assert.equal(item!.occurred_at, backdated.toISOString());
  assert.deepEqual(item!.old_values, { status: "active" });
  assert.deepEqual(item!.new_values, { status: "dormant" });
  assert.equal(item!.context?.company_name, company.name);
  assert.equal(item!.context?.territory_name, territory.name);
});

// ---- G/H: since filtering + deterministic ordering -------------------------

test("G: since filtering excludes events at or before the given timestamp", async () => {
  const pam = await makeUser("Feed-Test-G-Pam");
  const territory = await makeTerritory("Feed-Test-G-Territory", pam.id);
  const actor = await makeUser("Feed-Test-G-Actor");

  const beforeCutoff = await upsertTarget({
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q4`,
    territoryId: territory.id,
    pamUserId: pam.id,
    targetValue: 10,
    note: null,
    actingUserId: actor.id,
  });

  const cutoff = new Date();
  await new Promise((r) => setTimeout(r, 20)); // ensure a real timestamp gap

  const territory2 = await makeTerritory("Feed-Test-G-Territory2", null);
  await db.update(territoriesTable).set({ ownerUserId: pam.id }).where(eq(territoriesTable.id, territory2.id));
  const afterCutoff = await upsertTarget({
    metricKey: TEST_METRIC_KEY,
    periodKey: `${TEST_YEAR}-q1`, // same period as the "beforeCutoff" target above -- the distinct territory still keeps this a separate row
    territoryId: territory2.id,
    pamUserId: pam.id,
    targetValue: 20,
    note: null,
    actingUserId: actor.id,
  });

  const feed = await getChannelChangeFeed({ since: cutoff, limit: 200 });
  const ids = feed.map((f) => f.entity_id);
  assert.ok(!ids.includes(beforeCutoff.id), "the pre-cutoff target event must be excluded");
  assert.ok(ids.includes(afterCutoff.id), "the post-cutoff target event must be included");
});

test("H: feed ordering is deterministic -- most recent occurred_at first, stable across repeated calls", async () => {
  const feedFirst = await getChannelChangeFeed({ limit: 50 });
  const feedSecond = await getChannelChangeFeed({ limit: 50 });
  assert.deepEqual(
    feedFirst.map((f) => f.id),
    feedSecond.map((f) => f.id),
    "identical requests must return rows in the exact same order",
  );
  for (let i = 1; i < feedFirst.length; i++) {
    assert.ok(
      feedFirst[i - 1]!.occurred_at >= feedFirst[i]!.occurred_at,
      `expected descending occurred_at order at index ${i}: ${feedFirst[i - 1]!.occurred_at} >= ${feedFirst[i]!.occurred_at}`,
    );
  }
});

test("I: a page boundary never splits two events that share the exact same occurred_at across different source tables -- both are returned even when limit is 1", async () => {
  const company = await makeCompany("Feed-Test-I-Company");
  const pam = await makeUser("Feed-Test-I-Pam");
  const territory = await makeTerritory("Feed-Test-I-Territory", pam.id);

  const [prospect] = await db
    .insert(prospectsTable)
    .values({ companyId: company.id, territoryId: territory.id, partnerType: "reseller", priority: "A", whyItFits: "test fixture", whyNow: "test fixture" })
    .returning();
  createdProspectIds.push(prospect!.id);

  const [recruitment] = await db
    .insert(partnerRecruitmentsTable)
    .values({ prospectId: prospect!.id, companyId: company.id, territoryId: territory.id, assignedUserId: pam.id, stage: "accepted" })
    .returning();
  createdRecruitmentIds.push(recruitment!.id);

  // Deliberately identical, far-future timestamp on two rows from TWO
  // DIFFERENT source tables -- isolates this pair as the unambiguous top
  // of the merged feed (so neither source's own per-source SQL LIMIT
  // truncates it -- each source only has ONE contender for the top spot),
  // and proves the fix works at the merge boundary across sources. (A
  // same-source tie exactly at that source's own per-source LIMIT is a
  // separate, documented residual case -- see getChannelChangeFeed's own
  // comment in channelChangeFeedService.ts.) Ten years out, not one --
  // must clear even test F's deliberately backdated-to-the-future
  // 2031-05-01 relationship fixture above, which would otherwise outrank
  // a nearer tie and swallow the limit:1 slot before this pair is reached.
  const tiedAt = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const [recruitmentHistory] = await db
    .insert(partnerRecruitmentHistoryTable)
    .values({ recruitmentId: recruitment!.id, fromStage: null, toStage: "accepted", changedByUserId: pam.id, createdAt: tiedAt })
    .returning();
  const [changeEvent] = await db
    .insert(channelChangeEventsTable)
    .values({ entityType: "opportunity", entityId: randomUUID(), eventType: "created", actorUserId: null, occurredAt: tiedAt, oldValues: null, newValues: null })
    .returning();
  createdChangeEventIds.push(changeEvent!.id);

  // limit: 1 would, without the tie-safe boundary extension, arbitrarily
  // keep only one of these two -- and since both share the exact same
  // occurred_at, a client polling with `since` = that value could never
  // construct a cursor that selects the dropped sibling: it is not
  // strictly greater than itself, so it would be skipped forever.
  const feed = await getChannelChangeFeed({ limit: 1 });
  const ids = feed.map((f) => f.id);
  assert.ok(ids.includes(recruitmentHistory!.id) && ids.includes(changeEvent!.id), "both tied rows (from different sources) must be present in the same page, even though limit was 1");
});
