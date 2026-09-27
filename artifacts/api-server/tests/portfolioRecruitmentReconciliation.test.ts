// Canonical Portfolio Truth: DB-backed tests for signed recruitment ->
// Portfolio reconciliation (reconcilePortfolioRelationshipForSignedRecruitment,
// its wiring into transitionRecruitmentStage), territory-scoped Portfolio
// detail context, and the signed-recruitment backfill. Direct @workspace/db +
// service-layer calls against a disposable Postgres, no HTTP server -- same
// pattern as tests/portfolioOpportunityReconciliation.test.ts.
//
//   DATABASE_URL=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... tsx --test tests/portfolioRecruitmentReconciliation.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  pool,
  companiesTable,
  territoriesTable,
  usersTable,
  prospectsTable,
  partnerRecruitmentsTable,
  partnerRelationshipsTable,
  partnerRelationshipHistoryTable,
  channelRadarSignalsTable,
  type PartnerRecruitment,
} from "@workspace/db";
import { acceptForRecruitment, transitionRecruitmentStage } from "../src/services/partnerRecruitmentService";
import {
  reconcilePortfolioRelationshipForSignedRecruitment,
  reconcilePortfolioRelationshipForOpportunity,
  resolveRelationshipAssigneeForRecruitment,
  findRelationshipByCompanyAndTerritory,
  getRelationshipScopedContext,
  createRelationshipIfMissing,
  RecruitmentNotSignedError,
} from "../src/services/partnerRelationshipService";
import { runSignedRecruitmentBackfill, groupSignedRecruitmentsByCompanyTerritory } from "../src/scripts/backfillPortfolioFromSignedRecruitments";

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `CPT-${label}-${Date.now()}-${counter}`;
}

const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdUserIds: string[] = [];

async function makeUser(overrides: Partial<typeof usersTable.$inferInsert> = {}) {
  const [user] = await db
    .insert(usersTable)
    .values({ name: uniq("User"), email: `${uniq("user")}@example.test`, passwordHash: "test-fixture-hash", role: "pam", active: true, ...overrides })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

async function makeTerritory(ownerUserId: string | null = null) {
  const [territory] = await db.insert(territoriesTable).values({ name: uniq("Territory"), ownerUserId }).returning();
  createdTerritoryIds.push(territory!.id);
  return territory!;
}

async function makeCompany() {
  const [company] = await db.insert(companiesTable).values({ name: uniq("Company"), country: "Unknown" }).returning();
  createdCompanyIds.push(company!.id);
  return company!;
}

// A PAM who owns their own territory -- the v1 one-PAM-one-territory model.
async function makeOwnedTerritory() {
  const pam = await makeUser();
  const territory = await makeTerritory(pam.id);
  return { pam, territory };
}

async function makeProspect(companyId: string, territoryId: string, assignedUserId: string | null, status: "new" | "accepted" | "rejected" = "accepted") {
  const [prospect] = await db
    .insert(prospectsTable)
    .values({ companyId, territoryId, assignedUserId, status, partnerType: "System Integrator", priority: "A", whyItFits: "fixture", whyNow: "fixture" })
    .returning();
  return prospect!;
}

// Historical data shape: a recruitment row written directly at a given
// stage (as legacy/loaded data would be), bypassing the live transitions.
async function insertRecruitment(
  companyId: string,
  territoryId: string,
  assignedUserId: string | null,
  stage: PartnerRecruitment["stage"],
  opts: { signedAt?: Date | null; prospectStatus?: "new" | "accepted" | "rejected" } = {},
) {
  const prospect = await makeProspect(companyId, territoryId, assignedUserId, opts.prospectStatus ?? "accepted");
  const [recruitment] = await db
    .insert(partnerRecruitmentsTable)
    .values({
      prospectId: prospect.id,
      companyId,
      territoryId,
      assignedUserId,
      stage,
      signedAt: stage === "signed" ? (opts.signedAt === undefined ? new Date("2026-03-15T10:00:00Z") : opts.signedAt) : null,
    })
    .returning();
  return recruitment!;
}

async function walkToSigned(recruitmentId: string, actingUserId: string) {
  for (const stage of ["contacting", "engaged", "agreement", "signed"] as const) {
    await transitionRecruitmentStage(recruitmentId, stage, actingUserId);
  }
}

async function relationshipsFor(companyId: string) {
  return db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.companyId, companyId));
}

async function historyFor(relationshipId: string) {
  return db.select().from(partnerRelationshipHistoryTable).where(eq(partnerRelationshipHistoryTable.relationshipId, relationshipId));
}

after(async () => {
  if (createdCompanyIds.length > 0) {
    // Relationships first (history cascades), since origin_recruitment_id and
    // history.source_recruitment_id reference recruitments; then companies
    // cascade prospects -> recruitments -> recruitment history.
    await db.delete(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.companyId, createdCompanyIds));
    await db.delete(channelRadarSignalsTable).where(inArray(channelRadarSignalsTable.companyId, createdCompanyIds));
    await db.delete(partnerRecruitmentsTable).where(inArray(partnerRecruitmentsTable.companyId, createdCompanyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, createdCompanyIds));
  }
  if (createdTerritoryIds.length > 0) await db.delete(territoriesTable).where(inArray(territoriesTable.id, createdTerritoryIds));
  if (createdUserIds.length > 0) await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  await pool.end();
});

// ---- live Signed transition ------------------------------------------------

test("signed recruitment (live transition) creates an Active relationship with recruitment provenance and the territory's PAM", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  const prospect = await makeProspect(company.id, territory.id, pam.id);
  const { recruitment } = await acceptForRecruitment({ id: prospect.id, companyId: company.id, territoryId: territory.id, assignedUserId: pam.id }, pam.id);

  await walkToSigned(recruitment.id, pam.id);

  const rels = await relationshipsFor(company.id);
  assert.equal(rels.length, 1);
  const rel = rels[0]!;
  assert.equal(rel.territoryId, territory.id);
  assert.equal(rel.status, "active");
  assert.equal(rel.originType, "recruitment");
  assert.equal(rel.originRecruitmentId, recruitment.id);
  assert.equal(rel.assignedUserId, pam.id);
  assert.equal(rel.startedAtPrecision, "exact_date");
  assert.ok(rel.relationshipStartedAt);

  const history = await historyFor(rel.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.eventType, "created");
  assert.equal(history[0]!.sourceRecruitmentId, recruitment.id);
});

test("accepted/contacting/engaged/agreement never create a Portfolio relationship -- recruitment pipeline is not partnership", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  const prospect = await makeProspect(company.id, territory.id, pam.id);
  const { recruitment } = await acceptForRecruitment({ id: prospect.id, companyId: company.id, territoryId: territory.id, assignedUserId: pam.id }, pam.id);
  assert.equal((await relationshipsFor(company.id)).length, 0, "accepted");

  for (const stage of ["contacting", "engaged", "agreement"] as const) {
    await transitionRecruitmentStage(recruitment.id, stage, pam.id);
    assert.equal((await relationshipsFor(company.id)).length, 0, stage);
  }
  for (const stage of ["on_hold", "agreement"] as const) {
    await transitionRecruitmentStage(recruitment.id, stage, pam.id);
    assert.equal((await relationshipsFor(company.id)).length, 0, `${stage} (hold/resume)`);
  }
});

test("reconcile refuses a recruitment that is not currently signed", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  for (const stage of ["accepted", "contacting", "engaged", "agreement", "on_hold", "not_pursuing"] as const) {
    const r = await insertRecruitment(company.id, territory.id, pam.id, stage, { prospectStatus: stage === "accepted" ? "accepted" : "rejected" });
    await assert.rejects(reconcilePortfolioRelationshipForSignedRecruitment(r, null), RecruitmentNotSignedError, stage);
  }
  assert.equal((await relationshipsFor(company.id)).length, 0);
});

test("legacy prospect status=accepted + current recruitment contacting (Ashling shape) creates nothing, live or via backfill", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  const r = await insertRecruitment(company.id, territory.id, pam.id, "contacting", { prospectStatus: "accepted" });
  const [prospect] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, r.prospectId));
  assert.equal(prospect!.status, "accepted");

  const counts = await runSignedRecruitmentBackfill({ apply: true, onlyCompanyIds: [company.id] });
  assert.equal(counts.recruitments_scanned, 1);
  assert.equal(counts.ignored_not_signed, 1);
  assert.equal(counts.candidates, 0);
  assert.equal((await relationshipsFor(company.id)).length, 0);
});

// ---- idempotency and existing relationships --------------------------------

test("repeated signed reconciliation is idempotent -- one relationship, no extra history", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  const r = await insertRecruitment(company.id, territory.id, pam.id, "signed");

  const first = await reconcilePortfolioRelationshipForSignedRecruitment(r, null);
  const second = await reconcilePortfolioRelationshipForSignedRecruitment(r, null);
  const third = await reconcilePortfolioRelationshipForSignedRecruitment(r, null);

  assert.equal(first.action, "created");
  assert.equal(second.action, "reused");
  assert.equal(third.action, "reused");
  assert.equal(second.signedEventRecorded, false, "its own origin recruitment never needs a separate recruitment_signed event");
  assert.equal(first.relationship.id, third.relationship.id);
  assert.equal((await relationshipsFor(company.id)).length, 1);
  assert.equal((await historyFor(first.relationship.id)).length, 1);
  assert.equal(first.relationship.relationshipStartedAt, "2026-03-15", "started_at comes from the recruitment's signed_at, not 'now'");
});

test("existing manually managed relationship is reused: status and manual fields untouched, one recruitment_signed event", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const otherPam = await makeUser();
  const company = await makeCompany();
  const { relationship: manual } = await createRelationshipIfMissing(
    {
      companyId: company.id,
      territoryId: territory.id,
      assignedUserId: otherPam.id,
      status: "dormant",
      partnerType: "Reseller",
      strategicImportance: "high",
      relationshipSummary: "Managed by hand",
      nextAction: "Quarterly check-in",
      originType: "manual",
    },
    pam.id,
  );
  const r = await insertRecruitment(company.id, territory.id, pam.id, "signed");

  const run1 = await reconcilePortfolioRelationshipForSignedRecruitment(r, null);
  const run2 = await reconcilePortfolioRelationshipForSignedRecruitment(r, null);

  assert.equal(run1.action, "reused");
  assert.equal(run1.signedEventRecorded, true);
  assert.equal(run2.signedEventRecorded, false);
  const [reused] = await relationshipsFor(company.id);
  assert.equal(reused!.id, manual.id);
  assert.equal(reused!.status, "dormant");
  assert.equal(reused!.assignedUserId, otherPam.id);
  assert.equal(reused!.partnerType, "Reseller");
  assert.equal(reused!.strategicImportance, "high");
  assert.equal(reused!.relationshipSummary, "Managed by hand");
  assert.equal(reused!.nextAction, "Quarterly check-in");
  assert.equal(reused!.originType, "manual");
  assert.equal(reused!.originRecruitmentId, null);

  const signedEvents = (await historyFor(manual.id)).filter((h) => h.eventType === "recruitment_signed");
  assert.equal(signedEvents.length, 1);
  assert.equal(signedEvents[0]!.sourceRecruitmentId, r.id);
});

// ---- opportunity evidence vs. signed confirmation --------------------------

test("opportunity-only evidence still produces needs_review, never active", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  const result = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);
  assert.equal(result.relationship.status, "needs_review");
  assert.equal(result.relationship.originType, "opportunity_import");
});

test("signed recruitment promotes an opportunity-derived needs_review relationship to active, preserving provenance and manual fields", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  const { relationship: inferred } = await reconcilePortfolioRelationshipForOpportunity(
    { companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id },
    null,
  );
  await db.update(partnerRelationshipsTable).set({ nextAction: "Confirm partnership", relationshipSummary: "Seen via HubSpot deal" }).where(eq(partnerRelationshipsTable.id, inferred.id));

  const r = await insertRecruitment(company.id, territory.id, pam.id, "signed", { signedAt: new Date("2026-05-02T09:00:00Z") });
  const run1 = await reconcilePortfolioRelationshipForSignedRecruitment(r, pam.id);
  const run2 = await reconcilePortfolioRelationshipForSignedRecruitment(r, pam.id);

  assert.equal(run1.action, "promoted");
  assert.equal(run2.action, "reused");
  const rels = await relationshipsFor(company.id);
  assert.equal(rels.length, 1);
  const rel = rels[0]!;
  assert.equal(rel.id, inferred.id);
  assert.equal(rel.status, "active");
  assert.equal(rel.originType, "opportunity_import", "original provenance is never rewritten");
  assert.equal(rel.originRecruitmentId, null, "origin_recruitment_id is not back-filled to fake a recruitment origin");
  assert.equal(rel.nextAction, "Confirm partnership");
  assert.equal(rel.relationshipSummary, "Seen via HubSpot deal");
  assert.equal(rel.assignedUserId, pam.id);
  assert.equal(rel.relationshipStartedAt, "2026-05-02");
  assert.equal(rel.startedAtPrecision, "exact_date");

  const history = await historyFor(rel.id);
  const promotion = history.filter((h) => h.eventType === "status_changed");
  assert.equal(promotion.length, 1);
  assert.equal(promotion[0]!.fromStatus, "needs_review");
  assert.equal(promotion[0]!.toStatus, "active");
  assert.equal(promotion[0]!.sourceRecruitmentId, r.id);
  assert.equal(history.filter((h) => h.eventType === "recruitment_signed").length, 1);
  assert.equal(history.filter((h) => h.eventType === "created").length, 1, "the original opportunity 'created' event is retained");
});

test("live Signed transition also promotes an existing needs_review relationship", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  const company = await makeCompany();
  await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);
  const prospect = await makeProspect(company.id, territory.id, pam.id);
  const { recruitment } = await acceptForRecruitment({ id: prospect.id, companyId: company.id, territoryId: territory.id, assignedUserId: pam.id }, pam.id);

  await walkToSigned(recruitment.id, pam.id);

  const [rel] = await relationshipsFor(company.id);
  assert.equal(rel!.status, "active");
  assert.equal(rel!.originType, "opportunity_import");
});

// ---- PAM assignment --------------------------------------------------------

test("unresolved PAM assignment is represented as null, never invented", async () => {
  const company = await makeCompany();

  const unowned = await makeTerritory(null);
  const pam = await makeUser();
  assert.equal(await resolveRelationshipAssigneeForRecruitment({ territoryId: unowned.id, assignedUserId: pam.id }), null, "territory has no owner");

  const { territory: owned } = await makeOwnedTerritory();
  const outsider = await makeUser();
  assert.equal(await resolveRelationshipAssigneeForRecruitment({ territoryId: owned.id, assignedUserId: outsider.id }), null, "assignee doesn't own the territory");

  const inactivePam = await makeUser({ active: false });
  const inactiveTerritory = await makeTerritory(inactivePam.id);
  assert.equal(await resolveRelationshipAssigneeForRecruitment({ territoryId: inactiveTerritory.id, assignedUserId: null }), null, "owner is inactive");

  const r = await insertRecruitment(company.id, unowned.id, pam.id, "signed");
  const result = await reconcilePortfolioRelationshipForSignedRecruitment(r, null);
  assert.equal(result.action, "created");
  assert.equal(result.relationship.assignedUserId, null);
  assert.equal(result.resolvedAssignedUserId, null);
});

test("an unassigned signed recruitment falls back to the territory's active PAM owner", async () => {
  const { pam, territory } = await makeOwnedTerritory();
  assert.equal(await resolveRelationshipAssigneeForRecruitment({ territoryId: territory.id, assignedUserId: null }), pam.id);
});

// ---- territory-scoped Portfolio detail -------------------------------------

test("Portfolio detail context is scoped to the relationship's territory -- another territory's recruitment/radar never leaks", async () => {
  const { pam: pamA, territory: tA } = await makeOwnedTerritory();
  const { pam: pamB, territory: tB } = await makeOwnedTerritory();
  const company = await makeCompany();

  const recruitmentA = await insertRecruitment(company.id, tA.id, pamA.id, "signed");
  const recruitmentB = await insertRecruitment(company.id, tB.id, pamB.id, "contacting");
  // Touch B last so a company-only "latest recruitment" would pick B.
  await db.update(partnerRecruitmentsTable).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(partnerRecruitmentsTable.id, recruitmentB.id));

  const signal = (territoryId: string, headline: string) => ({
    territoryId,
    companyId: company.id,
    entityName: company.name,
    entityType: "partner" as const,
    signalType: "partnership" as const,
    headline,
    summary: "fixture",
    whyItMatters: "fixture",
    implication: "watch" as const,
    impact: "low" as const,
    recommendedAction: "fixture",
    confidence: "low" as const,
    sourceTitle: "fixture",
    sourceUrl: "https://example.test/signal",
    dedupeKey: uniq("dedupe"),
  });
  await db.insert(channelRadarSignalsTable).values([signal(tA.id, "Signal in A"), signal(tB.id, "Signal in B")]);

  const { relationship } = await reconcilePortfolioRelationshipForSignedRecruitment(recruitmentA, null);
  const context = await getRelationshipScopedContext(relationship);

  assert.equal(context.latestRecruitment?.id, recruitmentA.id);
  assert.deepEqual(context.radarSignals.map((s) => s.headline), ["Signal in A"]);
  assert.ok(context.radarSignals.every((s) => s.territoryId === tA.id));
  assert.equal(await findRelationshipByCompanyAndTerritory(company.id, tB.id), null, "B's contacting recruitment created nothing");
});

// ---- signed-recruitment backfill -------------------------------------------

test("groupSignedRecruitmentsByCompanyTerritory: one canonical (earliest signed) per pair, the rest are duplicates", () => {
  const base = { assignedUserId: null, stage: "signed" as const, createdAt: new Date("2026-01-01T00:00:00Z") };
  const groups = groupSignedRecruitmentsByCompanyTerritory([
    { ...base, id: "r-late", companyId: "c1", territoryId: "t1", signedAt: new Date("2026-04-01T00:00:00Z") },
    { ...base, id: "r-missing", companyId: "c1", territoryId: "t1", signedAt: null },
    { ...base, id: "r-early", companyId: "c1", territoryId: "t1", signedAt: new Date("2026-02-01T00:00:00Z") },
    { ...base, id: "r-other-territory", companyId: "c1", territoryId: "t2", signedAt: new Date("2026-03-01T00:00:00Z") },
  ]);
  assert.equal(groups.length, 2);
  const c1t1 = groups.find((g) => g.territoryId === "t1")!;
  assert.equal(c1t1.canonical.id, "r-early");
  assert.deepEqual(c1t1.duplicates.map((d) => d.id), ["r-late", "r-missing"]);
});

async function snapshot(companyIds: string[]) {
  const rels = await db.select().from(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.companyId, companyIds));
  const history = rels.length
    ? await db.select().from(partnerRelationshipHistoryTable).where(inArray(partnerRelationshipHistoryTable.relationshipId, rels.map((r) => r.id)))
    : [];
  return { rels: rels.map((r) => `${r.id}:${r.status}:${r.updatedAt.toISOString()}`).sort(), historyCount: history.length };
}

async function seedBackfillScenario() {
  const { pam, territory } = await makeOwnedTerritory();
  const unowned = await makeTerritory(null);
  const fresh = await makeCompany(); // signed, no relationship -> create
  const inferred = await makeCompany(); // signed + needs_review -> promote
  const unassigned = await makeCompany(); // signed in an unowned territory -> create, unresolved
  const pipeline = await makeCompany(); // accepted only -> ignored

  await insertRecruitment(fresh.id, territory.id, pam.id, "signed");
  // A second (older-prospect, rejected) signed recruitment for the same pair.
  await insertRecruitment(fresh.id, territory.id, pam.id, "signed", { signedAt: new Date("2026-06-01T00:00:00Z"), prospectStatus: "rejected" });
  await reconcilePortfolioRelationshipForOpportunity({ companyId: inferred.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);
  await insertRecruitment(inferred.id, territory.id, pam.id, "signed");
  await insertRecruitment(unassigned.id, unowned.id, null, "signed", { signedAt: null });
  await insertRecruitment(pipeline.id, territory.id, pam.id, "accepted");

  return { companyIds: [fresh.id, inferred.id, unassigned.id, pipeline.id], fresh, inferred, unassigned, pipeline, territory, unowned };
}

test("signed backfill dry run performs zero writes and reports the plan", async () => {
  const s = await seedBackfillScenario();
  const before = await snapshot(s.companyIds);

  const counts = await runSignedRecruitmentBackfill({ apply: false, onlyCompanyIds: s.companyIds });

  assert.deepEqual(await snapshot(s.companyIds), before, "dry run must not write anything");
  assert.equal(counts.recruitments_scanned, 5);
  assert.equal(counts.ignored_not_signed, 1);
  assert.equal(counts.signed_recruitments, 4);
  assert.equal(counts.candidates, 3);
  assert.equal(counts.duplicate_signed_skipped, 1);
  assert.equal(counts.create, 2);
  assert.equal(counts.promote_needs_review, 1);
  assert.equal(counts.reuse_existing, 0);
  assert.equal(counts.unresolved_assignment, 1);
  assert.equal(counts.signed_at_missing, 1);
  assert.equal(counts.errors, 0);
});

test("signed backfill apply, then repeated apply, is idempotent", async () => {
  const s = await seedBackfillScenario();

  const run1 = await runSignedRecruitmentBackfill({ apply: true, onlyCompanyIds: s.companyIds });
  assert.equal(run1.create, 2);
  assert.equal(run1.promote_needs_review, 1);
  assert.equal(run1.unresolved_assignment, 1);
  assert.equal(run1.errors, 0);

  const [fresh] = await relationshipsFor(s.fresh.id);
  assert.equal(fresh!.status, "active");
  assert.equal(fresh!.originType, "recruitment");
  const [inferred] = await relationshipsFor(s.inferred.id);
  assert.equal(inferred!.status, "active");
  assert.equal(inferred!.originType, "opportunity_import");
  const [unassigned] = await relationshipsFor(s.unassigned.id);
  assert.equal(unassigned!.assignedUserId, null);
  assert.equal(unassigned!.startedAtPrecision, "unknown", "missing signed_at never becomes a fabricated start date");
  assert.equal((await relationshipsFor(s.pipeline.id)).length, 0, "accepted-stage recruitment never enters Portfolio");

  const afterFirst = await snapshot(s.companyIds);
  const run2 = await runSignedRecruitmentBackfill({ apply: true, onlyCompanyIds: s.companyIds });
  assert.equal(run2.create, 0);
  assert.equal(run2.promote_needs_review, 0);
  assert.equal(run2.reuse_existing, 3);
  assert.equal(run2.signed_events, 0);
  assert.equal(run2.errors, 0);
  assert.deepEqual(await snapshot(s.companyIds), afterFirst, "second apply must not write anything");
});
