// Phase 12 Portfolio Reconciliation: DB-backed tests for
// reconcilePortfolioRelationshipForOpportunity, its wiring into
// applyOpportunityCreate (routes/opportunities.ts), and the one-time
// backfill script's grouping/idempotency behavior. Direct @workspace/db +
// service-layer calls against a disposable Postgres, no HTTP server -- same
// pattern as tests/partnerOpportunities.test.ts.
//
//   DATABASE_URL=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... tsx --test tests/portfolioOpportunityReconciliation.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and, inArray } from "drizzle-orm";
import { db, pool, companiesTable, territoriesTable, usersTable, partnerOpportunitiesTable, partnerRelationshipsTable, channelChangeEventsTable } from "@workspace/db";
import { applyOpportunityCreate } from "../src/routes/opportunities";
import {
  reconcilePortfolioRelationshipForOpportunity,
  resolveRelationshipAssigneeForOpportunity,
  findRelationshipByCompanyAndTerritory,
} from "../src/services/partnerRelationshipService";
import { groupOpportunitiesByCompanyTerritory, runOpportunityBackfill, canonicalOpportunityAssignee } from "../src/scripts/backfillPortfolioFromOpportunities";

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `Phase12-${label}-${Date.now()}-${counter}`;
}

const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdUserIds: string[] = [];
const createdOpportunityIds: string[] = [];
const createdRelationshipIds: string[] = [];

// ownerUserId: the territory's canonical PAM (territories.owner_user_id) --
// an opportunity assignee only resolves onto a relationship when they own
// the opportunity's territory.
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

async function makeUser(overrides: Partial<typeof usersTable.$inferInsert> = {}) {
  const [user] = await db
    .insert(usersTable)
    .values({ name: uniq("User"), email: `${uniq("user")}@example.test`, passwordHash: "test-fixture-hash", role: "pam", active: true, ...overrides })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

function baseOpp(overrides: Partial<typeof partnerOpportunitiesTable.$inferInsert> & { territoryId: string; assignedUserId: string; companyId: string }) {
  return {
    name: uniq("Deal"),
    attributionType: "partner_sourced" as const,
    status: "open" as const,
    dealValue: "1000",
    currency: "USD" as const,
    opportunityDate: "2026-07-01",
    sourceSystem: "import" as const,
    ...overrides,
  };
}

after(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(channelChangeEventsTable).where(inArray(channelChangeEventsTable.actorUserId, createdUserIds));
  }
  for (const id of createdRelationshipIds) await db.delete(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, id));
  // Relationships auto-created by applyOpportunityCreate below aren't in
  // createdRelationshipIds -- sweep by companyId instead so nothing leaks.
  if (createdCompanyIds.length > 0) {
    await db.delete(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.companyId, createdCompanyIds));
  }
  for (const id of createdOpportunityIds) await db.delete(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  for (const id of createdCompanyIds) await db.delete(companiesTable).where(eq(companiesTable.id, id));
  for (const id of createdUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  for (const id of createdTerritoryIds) await db.delete(territoriesTable).where(eq(territoriesTable.id, id));
  await pool.end();
});

// ---- resolveRelationshipAssigneeForOpportunity -----------------------------

test("resolveRelationshipAssigneeForOpportunity: an active PAM who owns the opportunity's territory resolves to their own id", async () => {
  const pam = await makeUser({ role: "pam", active: true });
  const territory = await makeTerritory(pam.id);
  const resolved = await resolveRelationshipAssigneeForOpportunity(pam.id, territory.id);
  assert.equal(resolved, pam.id);
});

test("resolveRelationshipAssigneeForOpportunity: an active PAM who owns a DIFFERENT territory never resolves -- no wrong-PAM assignment, no substitution", async () => {
  const pam = await makeUser({ role: "pam", active: true });
  await makeTerritory(pam.id);
  const otherOwner = await makeUser({ role: "pam", active: true });
  const opportunityTerritory = await makeTerritory(otherOwner.id);
  const resolved = await resolveRelationshipAssigneeForOpportunity(pam.id, opportunityTerritory.id);
  assert.equal(resolved, null, "must not assign the named PAM, and must not substitute the territory's owner either");
});

test("resolveRelationshipAssigneeForOpportunity: an active PAM for an unowned territory never resolves", async () => {
  const pam = await makeUser({ role: "pam", active: true });
  const unowned = await makeTerritory();
  assert.equal(await resolveRelationshipAssigneeForOpportunity(pam.id, unowned.id), null);
});

test("resolveRelationshipAssigneeForOpportunity: an inactive PAM never resolves -- no invented assignment", async () => {
  const pam = await makeUser({ role: "pam", active: false });
  const territory = await makeTerritory(pam.id);
  const resolved = await resolveRelationshipAssigneeForOpportunity(pam.id, territory.id);
  assert.equal(resolved, null);
});

test("resolveRelationshipAssigneeForOpportunity: a non-PAM role (e.g. admin) never resolves -- an opportunity's assigned_user_id is not blindly trusted", async () => {
  const admin = await makeUser({ role: "admin", active: true });
  const territory = await makeTerritory(admin.id);
  const resolved = await resolveRelationshipAssigneeForOpportunity(admin.id, territory.id);
  assert.equal(resolved, null);
});

// ---- reconcilePortfolioRelationshipForOpportunity --------------------------

test("no existing relationship: creates a needs_review, opportunity_import relationship with the resolved PAM -- never Active", async () => {
  const pam = await makeUser({ role: "pam", active: true });
  const territory = await makeTerritory(pam.id);
  const company = await makeCompany();

  const result = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);
  createdRelationshipIds.push(result.relationship.id);

  assert.equal(result.created, true);
  assert.equal(result.relationship.status, "needs_review", "must never default to active -- the app does not know this is a real active partner yet");
  assert.equal(result.relationship.originType, "opportunity_import");
  assert.equal(result.relationship.assignedUserId, pam.id);
  assert.equal(result.resolvedAssignedUserId, pam.id);
  assert.equal(result.relationship.relationshipStartedAt, null, "must never infer relationship_started_at from an opportunity date");
  assert.equal(result.relationship.startedAtPrecision, "unknown");
});

test("unresolved PAM: relationship is still created, but assigned_user_id stays null rather than inventing an owner", async () => {
  const territory = await makeTerritory();
  const company = await makeCompany();
  const inactivePam = await makeUser({ role: "pam", active: false });

  const result = await reconcilePortfolioRelationshipForOpportunity(
    { companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: inactivePam.id },
    null,
  );
  createdRelationshipIds.push(result.relationship.id);

  assert.equal(result.created, true);
  assert.equal(result.relationship.assignedUserId, null);
  assert.equal(result.resolvedAssignedUserId, null);
  assert.equal(result.relationship.status, "needs_review");
});

test("mismatched PAM (active, but owns another territory): needs_review relationship is still created, with assigned_user_id null", async () => {
  const pam = await makeUser({ role: "pam", active: true });
  await makeTerritory(pam.id);
  const territoryOwner = await makeUser({ role: "pam", active: true });
  const territory = await makeTerritory(territoryOwner.id);
  const company = await makeCompany();

  const result = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);
  createdRelationshipIds.push(result.relationship.id);

  assert.equal(result.created, true);
  assert.equal(result.relationship.status, "needs_review");
  assert.equal(result.relationship.originType, "opportunity_import");
  assert.equal(result.relationship.assignedUserId, null, "never the mismatched PAM, and never the territory owner as a substitute");
  assert.equal(result.resolvedAssignedUserId, null);
});

test("existing relationship for the (company, territory) pair: reused untouched, no duplicate, explicitly-managed fields preserved", async () => {
  const territory = await makeTerritory();
  const company = await makeCompany();
  const pam = await makeUser({ role: "pam", active: true });

  const [existing] = await db
    .insert(partnerRelationshipsTable)
    .values({
      companyId: company.id,
      territoryId: territory.id,
      status: "active",
      partnerType: "Reseller",
      strategicImportance: "high",
      originType: "manual",
    })
    .returning();
  createdRelationshipIds.push(existing!.id);

  const result = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);

  assert.equal(result.created, false, "must reuse the existing relationship, never create a second one");
  assert.equal(result.relationship.id, existing!.id);
  assert.equal(result.relationship.status, "active", "an explicitly-managed status must never be overwritten by opportunity reconciliation");
  assert.equal(result.relationship.partnerType, "Reseller");
  assert.equal(result.relationship.strategicImportance, "high");
  assert.equal(result.relationship.originType, "manual", "origin_type is set once at creation and must never be rewritten");

  const rows = await db
    .select()
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, company.id), eq(partnerRelationshipsTable.territoryId, territory.id)));
  assert.equal(rows.length, 1, "no duplicate relationship row must be created");
});

test("repeated reconciliation for the same pair is idempotent -- calling it twice never creates a second relationship", async () => {
  const territory = await makeTerritory();
  const company = await makeCompany();
  const pam = await makeUser({ role: "pam", active: true });

  const first = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);
  createdRelationshipIds.push(first.relationship.id);
  const second = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.relationship.id, second.relationship.id);

  const rows = await db
    .select()
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, company.id), eq(partnerRelationshipsTable.territoryId, territory.id)));
  assert.equal(rows.length, 1);
});

// ---- Wired into applyOpportunityCreate (the real opportunity-creation path) --

test("applyOpportunityCreate: creating an opportunity for a company with no Portfolio relationship reconciles one automatically", async () => {
  const pam = await makeUser({ role: "pam", active: true });
  const territory = await makeTerritory(pam.id);
  const company = await makeCompany();

  const opp = await db.transaction((tx) =>
    applyOpportunityCreate(tx, baseOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, createdByUserId: pam.id })),
  );
  createdOpportunityIds.push(opp.id);

  const relationship = await findRelationshipByCompanyAndTerritory(company.id, territory.id);
  assert.ok(relationship, "a Portfolio relationship must exist after the opportunity is created");
  createdRelationshipIds.push(relationship!.id);
  assert.equal(relationship!.status, "needs_review");
  assert.equal(relationship!.originType, "opportunity_import");
  assert.equal(relationship!.assignedUserId, pam.id);
});

test("applyOpportunityCreate: re-importing another opportunity for the same company/territory never duplicates the relationship (idempotent import)", async () => {
  const territory = await makeTerritory();
  const company = await makeCompany();
  const pam = await makeUser({ role: "pam", active: true });

  const first = await db.transaction((tx) =>
    applyOpportunityCreate(tx, baseOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, createdByUserId: pam.id, externalId: uniq("ext-a") })),
  );
  createdOpportunityIds.push(first.id);
  const second = await db.transaction((tx) =>
    applyOpportunityCreate(tx, baseOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, createdByUserId: pam.id, externalId: uniq("ext-b") })),
  );
  createdOpportunityIds.push(second.id);

  const rows = await db
    .select()
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, company.id), eq(partnerRelationshipsTable.territoryId, territory.id)));
  assert.equal(rows.length, 1, "two opportunities for the same company/territory must reconcile to exactly one relationship");
  createdRelationshipIds.push(rows[0]!.id);
});

test("applyOpportunityCreate: an opportunity for a company already in Portfolio reuses the existing relationship without changing its status", async () => {
  const territory = await makeTerritory();
  const company = await makeCompany();
  const pam = await makeUser({ role: "pam", active: true });

  const [existing] = await db
    .insert(partnerRelationshipsTable)
    .values({ companyId: company.id, territoryId: territory.id, status: "dormant", originType: "manual" })
    .returning();
  createdRelationshipIds.push(existing!.id);

  const opp = await db.transaction((tx) =>
    applyOpportunityCreate(tx, baseOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id, createdByUserId: pam.id })),
  );
  createdOpportunityIds.push(opp.id);

  const [reloaded] = await db.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, existing!.id));
  assert.equal(reloaded!.status, "dormant", "an opportunity must never flip an existing relationship's status");

  const rows = await db
    .select()
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, company.id), eq(partnerRelationshipsTable.territoryId, territory.id)));
  assert.equal(rows.length, 1);
});

// ---- Backfill script: pure grouping ----------------------------------------

test("groupOpportunitiesByCompanyTerritory: groups by (company, territory), deduping assigned_user_id and preserving oldest-first order", () => {
  const older = new Date("2026-01-01T00:00:00.000Z");
  const newer = new Date("2026-02-01T00:00:00.000Z");
  const groups = groupOpportunitiesByCompanyTerritory([
    { id: "o2", companyId: "c1", territoryId: "t1", assignedUserId: "u2", createdAt: newer },
    { id: "o1", companyId: "c1", territoryId: "t1", assignedUserId: "u1", createdAt: older },
    { id: "o3", companyId: "c2", territoryId: "t1", assignedUserId: "u1", createdAt: older },
  ]);

  assert.equal(groups.length, 2);
  const c1t1 = groups.find((g) => g.companyId === "c1" && g.territoryId === "t1")!;
  assert.deepEqual(c1t1.opportunityAssignedUserIds, ["u1", "u2"], "the oldest opportunity's assignee must be tried first");
  const c2t1 = groups.find((g) => g.companyId === "c2" && g.territoryId === "t1")!;
  assert.deepEqual(c2t1.opportunityAssignedUserIds, ["u1"]);

  // Tied created_at: the lower opportunity id is canonical, regardless of
  // the order rows arrive in.
  const tiedAt = new Date("2026-03-01T00:00:00.000Z");
  const tiedRows = [
    { id: "opp-b", companyId: "c3", territoryId: "t1", assignedUserId: "u-from-b", createdAt: tiedAt },
    { id: "opp-a", companyId: "c3", territoryId: "t1", assignedUserId: "u-from-a", createdAt: tiedAt },
  ];
  for (const input of [tiedRows, [...tiedRows].reverse()]) {
    const [tied] = groupOpportunitiesByCompanyTerritory(input);
    assert.deepEqual(tied!.opportunityAssignedUserIds, ["u-from-a", "u-from-b"]);
    assert.equal(canonicalOpportunityAssignee(tied!), "u-from-a", "tied created_at must fall back to the lower opportunity id, never input order");
  }
});

test("backfill (via reconcilePortfolioRelationshipForOpportunity, the same function the script calls): running twice is idempotent", async () => {
  const territory = await makeTerritory();
  const company = await makeCompany();
  const pam = await makeUser({ role: "pam", active: true });

  const [seededOpp] = await db.insert(partnerOpportunitiesTable).values(baseOpp({ territoryId: territory.id, assignedUserId: pam.id, companyId: company.id })).returning();
  createdOpportunityIds.push(seededOpp!.id);

  const run1 = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);
  createdRelationshipIds.push(run1.relationship.id);
  const run2 = await reconcilePortfolioRelationshipForOpportunity({ companyId: company.id, territoryId: territory.id, opportunityAssignedUserId: pam.id }, null);

  assert.equal(run1.created, true);
  assert.equal(run2.created, false);
  assert.equal(run1.relationship.id, run2.relationship.id);
});

test("backfill: dry run and --apply agree -- only the canonical (oldest) opportunity's assignee is used, never a later valid PAM", async () => {
  const territoryOwner = await makeUser({ role: "pam", active: true });
  const territory = await makeTerritory(territoryOwner.id);
  const mismatchedPam = await makeUser({ role: "pam", active: true });
  await makeTerritory(mismatchedPam.id);
  const company = await makeCompany();

  // Historical rows inserted directly (no applyOpportunityCreate, so nothing
  // is reconciled yet). The OLDEST opportunity names a PAM who owns another
  // territory; a LATER one names the territory's real owner, who would be
  // valid -- but must not be searched for.
  const [oldest] = await db
    .insert(partnerOpportunitiesTable)
    .values({ ...baseOpp({ territoryId: territory.id, assignedUserId: mismatchedPam.id, companyId: company.id }), createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning();
  const [later] = await db
    .insert(partnerOpportunitiesTable)
    .values({ ...baseOpp({ territoryId: territory.id, assignedUserId: territoryOwner.id, companyId: company.id }), createdAt: new Date("2026-02-01T00:00:00Z") })
    .returning();
  createdOpportunityIds.push(oldest!.id, later!.id);
  assert.equal(await resolveRelationshipAssigneeForOpportunity(territoryOwner.id, territory.id), territoryOwner.id, "precondition: the later assignee WOULD be valid");

  const dry = await runOpportunityBackfill({ apply: false, onlyCompanyIds: [company.id] });
  assert.deepEqual(dry, { candidates: 1, already_in_portfolio: 0, created: 1, unresolved_pam: 1, errors: 0 }, "dry run must report unassigned");
  assert.equal(await findRelationshipByCompanyAndTerritory(company.id, territory.id), null, "dry run must not write");

  const applied = await runOpportunityBackfill({ apply: true, onlyCompanyIds: [company.id] });
  assert.deepEqual(applied, dry, "apply must produce exactly what the dry run predicted");
  const relationship = await findRelationshipByCompanyAndTerritory(company.id, territory.id);
  assert.ok(relationship);
  createdRelationshipIds.push(relationship!.id);
  assert.equal(relationship!.status, "needs_review");
  assert.equal(relationship!.assignedUserId, null, "neither the mismatched PAM nor the later opportunity's PAM");

  const reapplied = await runOpportunityBackfill({ apply: true, onlyCompanyIds: [company.id] });
  assert.deepEqual(reapplied, { candidates: 1, already_in_portfolio: 1, created: 0, unresolved_pam: 0, errors: 0 });
  const [reused] = await db
    .select()
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, company.id), eq(partnerRelationshipsTable.territoryId, territory.id)));
  assert.equal(reused!.id, relationship!.id);
  assert.equal(reused!.assignedUserId, null, "the existing relationship is reused untouched");
});
