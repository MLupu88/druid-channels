// PAM Commercial Workspace v1 (Slice B): DB-backed tests for canonical
// Portfolio scoping, the load -> authorize -> eligibility gate in front of
// every HubSpot read, and the DRUID opportunity lookup. Direct service calls
// against a disposable Postgres (no HTTP server) -- same pattern as
// tests/pamOverviewService.test.ts. HubSpot is never called: every
// dependency that could reach it throws if invoked.
//
//   DATABASE_URL=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... tsx --test tests/pamCommercialWorkspace.test.ts
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
} from "@workspace/db";
import { ForbiddenScopeError } from "../src/services/authz";
import {
  getPamCommercialWorkspace,
  getRelationshipDealsForUser,
  loadDruidOpportunitiesByDealIds,
  CommercialRelationshipNotFoundError,
  RelationshipNotEligibleError,
  type CommercialDealsDependencies,
} from "../src/services/pamCommercialService";

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `PamCommercial-${label}-${Date.now()}-${counter}`;
}

const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdUserIds: string[] = [];

after(async () => {
  if (createdCompanyIds.length > 0) {
    await db.delete(partnerOpportunitiesTable).where(inArray(partnerOpportunitiesTable.companyId, createdCompanyIds));
    await db.delete(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.companyId, createdCompanyIds));
  }
  for (const id of createdCompanyIds) await db.delete(companiesTable).where(eq(companiesTable.id, id));
  for (const id of createdTerritoryIds) await db.delete(territoriesTable).where(eq(territoriesTable.id, id));
  for (const id of createdUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  await pool.end();
});

async function makeUser(role: "pam" | "head_of_channels" = "pam") {
  const [user] = await db
    .insert(usersTable)
    .values({ name: uniq("User"), email: `${uniq("user")}@example.test`, passwordHash: "test-fixture-hash", role, active: true })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

async function makeTerritory(ownerUserId: string | null) {
  const [territory] = await db.insert(territoriesTable).values({ name: uniq("Territory"), ownerUserId }).returning();
  createdTerritoryIds.push(territory!.id);
  return territory!;
}

async function makeCompany(hubspotCompanyId: string | null = null) {
  const [company] = await db
    .insert(companiesTable)
    .values({ name: uniq("Company"), country: "Unknown", domain: `${uniq("d").toLowerCase()}.example`, hubspotCompanyId })
    .returning();
  createdCompanyIds.push(company!.id);
  return company!;
}

async function makeRelationship(values: {
  companyId: string;
  territoryId: string;
  assignedUserId: string | null;
  status: "active" | "dormant" | "closed" | "needs_review";
}) {
  const [row] = await db
    .insert(partnerRelationshipsTable)
    .values({ originType: values.status === "needs_review" ? "opportunity_import" : "manual", ...values })
    .returning();
  return row!;
}

// Any HubSpot/token access in these tests is a failure: authorization and
// eligibility must be decided before HubSpot is ever touched.
function forbiddenDeps(): CommercialDealsDependencies {
  const fail = async (): Promise<never> => {
    throw new Error("HubSpot must not be called");
  };
  return {
    resolveAccessToken: fail,
    listCompanyDealAssociations: fail,
    getDealWithHistory: fail,
    listDealPipelines: fail,
    getOwner: fail,
    loadDruidOpportunitiesByDealIds: fail,
  };
}

test("workspace is scoped by assigned_user_id (not territory), separates needs_review, and excludes closed", async () => {
  const pamA = await makePam();
  const pamB = await makePam();
  const ownTerritory = await makeTerritory(pamA.id);
  const otherTerritory = await makeTerritory(pamB.id);

  const active = await makeRelationship({ companyId: (await makeCompany("111")).id, territoryId: ownTerritory.id, assignedUserId: pamA.id, status: "active" });
  const dormant = await makeRelationship({ companyId: (await makeCompany()).id, territoryId: ownTerritory.id, assignedUserId: pamA.id, status: "dormant" });
  const review = await makeRelationship({ companyId: (await makeCompany()).id, territoryId: ownTerritory.id, assignedUserId: pamA.id, status: "needs_review" });
  const closed = await makeRelationship({ companyId: (await makeCompany()).id, territoryId: ownTerritory.id, assignedUserId: pamA.id, status: "closed" });
  // In pamA's territory but not assigned to pamA -- not theirs.
  const otherPamsInOwnTerritory = await makeRelationship({ companyId: (await makeCompany()).id, territoryId: ownTerritory.id, assignedUserId: pamB.id, status: "active" });
  const unassignedInOwnTerritory = await makeRelationship({ companyId: (await makeCompany()).id, territoryId: ownTerritory.id, assignedUserId: null, status: "active" });
  // Outside pamA's territory but assigned to pamA -- theirs.
  const assignedElsewhere = await makeRelationship({ companyId: (await makeCompany()).id, territoryId: otherTerritory.id, assignedUserId: pamA.id, status: "active" });

  const workspace = await getPamCommercialWorkspace(pamA);

  const confirmedIds = new Set(workspace.confirmed_relationships.map((r) => r.relationship_id));
  const reviewIds = new Set(workspace.awaiting_review.map((r) => r.relationship_id));
  assert.deepEqual(confirmedIds, new Set([active.id, dormant.id, assignedElsewhere.id]));
  assert.deepEqual(reviewIds, new Set([review.id]));
  for (const excluded of [closed.id, otherPamsInOwnTerritory.id, unassignedInOwnTerritory.id]) {
    assert.equal(confirmedIds.has(excluded) || reviewIds.has(excluded), false);
  }

  assert.equal(workspace.ownership_basis, "partner_relationships.assigned_user_id");
  assert.equal(workspace.hubspot_read, "not_performed");
  assert.ok(workspace.confirmed_relationships.every((r) => r.confirmed_partner && r.assigned_user_id === pamA.id));
  assert.ok(workspace.awaiting_review.every((r) => !r.confirmed_partner && r.status === "needs_review"));

  const linked = workspace.confirmed_relationships.find((r) => r.relationship_id === active.id)!;
  assert.equal(linked.hubspot_company_id, "111");
  assert.equal(linked.hubspot_link_status, "linked");
  const unlinked = workspace.confirmed_relationships.find((r) => r.relationship_id === dormant.id)!;
  assert.equal(unlinked.hubspot_company_id, null);
  assert.equal(unlinked.hubspot_link_status, "not_linked");
  assert.equal("deal_count" in unlinked, false);
});

test("deals: a territory owner who is not the assignee is refused before any HubSpot call", async () => {
  const owner = await makePam();
  const assignee = await makePam();
  const territory = await makeTerritory(owner.id);
  const rel = await makeRelationship({ companyId: (await makeCompany("222")).id, territoryId: territory.id, assignedUserId: assignee.id, status: "active" });

  await assert.rejects(getRelationshipDealsForUser(rel.id, owner, forbiddenDeps()), ForbiddenScopeError);
});

test("deals: closed relationships are ineligible before any HubSpot call; missing ones are not found", async () => {
  const pam = await makePam();
  const territory = await makeTerritory(pam.id);
  const rel = await makeRelationship({ companyId: (await makeCompany("333")).id, territoryId: territory.id, assignedUserId: pam.id, status: "closed" });

  await assert.rejects(getRelationshipDealsForUser(rel.id, pam, forbiddenDeps()), RelationshipNotEligibleError);
  await assert.rejects(
    getRelationshipDealsForUser("00000000-0000-4000-8000-000000000000", pam, forbiddenDeps()),
    CommercialRelationshipNotFoundError,
  );
});

test("deals: a global user may read another PAM's relationship; not-linked stays unknown with no HubSpot call", async () => {
  const head = await makeUser("head_of_channels");
  const pam = await makePam();
  const territory = await makeTerritory(pam.id);
  const rel = await makeRelationship({ companyId: (await makeCompany()).id, territoryId: territory.id, assignedUserId: pam.id, status: "needs_review" });

  const result = await getRelationshipDealsForUser(rel.id, head, forbiddenDeps());
  assert.equal(result.relationship.relationship_id, rel.id);
  assert.equal(result.relationship.confirmed_partner, false);
  assert.equal(result.hubspot.availability, "not_linked");
  assert.equal(result.deals, null);
});

// Only source_system=hubspot establishes HubSpot deal identity. An "import"
// row with an identical external_id is NOT matched: the importer's
// external_id may be a CSV-supplied or generated CUTOVER-* ID and no
// persisted field proves which.
test("DRUID lookup matches external_id under source_system=hubspot only", async () => {
  const pam = await makePam();
  const territory = await makeTerritory(pam.id);
  const company = await makeCompany();
  const dealId = String(Date.now());
  const base = {
    companyId: company.id,
    territoryId: territory.id,
    assignedUserId: pam.id,
    attributionType: "partner_sourced" as const,
    dealValue: "1000",
    currency: "USD" as const,
    opportunityDate: "2026-07-01",
  };
  const inserted = await db
    .insert(partnerOpportunitiesTable)
    .values([
      { ...base, name: uniq("Import"), sourceSystem: "import", externalId: dealId },
      { ...base, name: uniq("Hubspot"), sourceSystem: "hubspot", externalId: dealId },
      { ...base, name: uniq("Manual"), sourceSystem: "manual", externalId: null },
      { ...base, name: uniq("Other"), sourceSystem: "hubspot", externalId: `${dealId}9` },
    ])
    .returning();

  const rows = await loadDruidOpportunitiesByDealIds([dealId]);
  assert.deepEqual(
    rows.map((r) => r.opportunity.id),
    [inserted[1]!.id],
  );
  assert.equal(rows[0]!.opportunity.sourceSystem, "hubspot");
  assert.ok(rows.every((r) => r.companyName === company.name));
  assert.deepEqual(await loadDruidOpportunitiesByDealIds([]), []);
});

async function makePam() {
  return makeUser("pam");
}
