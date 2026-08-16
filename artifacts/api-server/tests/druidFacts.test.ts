// Phase 11.5C.1: service-level DB-backed coverage for the DRUID Context
// foundation (services/druidFacts.ts). Same harness convention as
// connectionsCredentialResolution.test.ts/discoveryExclusionsFlow.test.ts:
// real Postgres, own fixtures, explicit child-first teardown.
//
//   DATABASE_URL=... tsx --test tests/druidFacts.test.ts
// or `pnpm run test:druid-facts` with the same env exported.
//
// NOT executed in this sandbox -- requires a real, isolated local Postgres
// (see NEXT_SESSION.md/PROJECT_HANDOFF.md's placeholder-DATABASE_URL
// convention; this file intentionally does NOT use the placeholder, since
// it genuinely reads/writes the druid_facts table). Written and ready to
// run once that environment exists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, usersTable, druidFactsTable } from "@workspace/db";
import {
  listDruidFacts,
  listTrustedDruidFacts,
  createDruidFact,
  updateDruidFact,
  verifyDruidFact,
  deactivateDruidFact,
  reactivateDruidFact,
  DruidFactMissingProvenanceError,
  InvalidDruidFactCategoryError,
} from "../src/services/druidFacts";

let adminUserId: string;
const createdUserIds: string[] = [];
const createdFactIds: string[] = [];

before(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      name: "Phase115c1 Test Admin",
      email: `phase115c1.${Date.now()}.${Math.random().toString(36).slice(2)}@phase11-test.example`,
      role: "head_of_channels",
      territory: null,
      active: true,
    })
    .returning();
  adminUserId = admin!.id;
  createdUserIds.push(adminUserId);
});

after(async () => {
  for (const id of createdFactIds) {
    await db.delete(druidFactsTable).where(eq(druidFactsTable.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
  await pool.end();
});

async function makeFact(overrides: Parameters<typeof createDruidFact>[0] = { category: "product", factText: "Test fact" }) {
  const created = await createDruidFact(overrides, adminUserId);
  createdFactIds.push(created.id);
  return created;
}

// ---- Create defaults are server-owned --------------------------------------

test("createDruidFact always starts source_type=manual, verification_status=unverified, active=true", async () => {
  const fact = await makeFact({ category: "positioning", factText: "DRUID is an enterprise conversational/agentic AI platform vendor." });
  assert.equal(fact.sourceType, "manual");
  assert.equal(fact.verificationStatus, "unverified");
  assert.equal(fact.active, true);
  assert.equal(fact.createdByUserId, adminUserId);
  assert.equal(fact.updatedByUserId, adminUserId);
});

// ---- Server-side category validation (defense-in-depth) --------------------

test("createDruidFact rejects an invalid category, even called directly (bypassing the HTTP/Zod layer)", async () => {
  await assert.rejects(
    () => createDruidFact({ category: "not_a_real_category", factText: "Should never be created" }, adminUserId),
    InvalidDruidFactCategoryError,
  );

  const all = await listDruidFacts();
  assert.ok(!all.some((f) => f.factText === "Should never be created"), "no row may have been inserted for a rejected category");
});

test("updateDruidFact rejects an invalid category and leaves the existing row unchanged", async () => {
  const fact = await makeFact({ category: "product", factText: "Valid fact for invalid-category-edit test" });

  await assert.rejects(
    () => updateDruidFact(fact.id, { category: "not_a_real_category" }, adminUserId),
    InvalidDruidFactCategoryError,
  );

  const [row] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, fact.id));
  assert.equal(row!.category, "product", "the category must remain unchanged after a rejected update");
  assert.equal(row!.factText, "Valid fact for invalid-category-edit test");
});

// ---- Provenance gate on verification ---------------------------------------

test("a fact cannot be verified with no provenance (no source_url, no source_note)", async () => {
  const fact = await makeFact({ category: "product", factText: "No provenance fact" });
  await assert.rejects(() => verifyDruidFact(fact.id, adminUserId), DruidFactMissingProvenanceError);

  const [row] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, fact.id));
  assert.equal(row!.verificationStatus, "unverified", "a rejected verify attempt must not change anything");
});

test("verifyDruidFact succeeds with only a source_url", async () => {
  const fact = await makeFact({ category: "product", factText: "Has a URL", sourceUrl: "https://druidai.com/product" });
  const verified = await verifyDruidFact(fact.id, adminUserId);
  assert.equal(verified!.verificationStatus, "verified");
  assert.equal(verified!.verifiedByUserId, adminUserId);
  assert.ok(verified!.verifiedAt);
});

test("verifyDruidFact succeeds with only a source_note", async () => {
  const fact = await makeFact({ category: "positioning", factText: "Has a note only", sourceNote: "Internal positioning statement, agreed with Head of Channels" });
  const verified = await verifyDruidFact(fact.id, adminUserId);
  assert.equal(verified!.verificationStatus, "verified");
});

test("verifyDruidFact rejects when source_url/source_note are present but whitespace-only", async () => {
  const fact = await makeFact({ category: "product", factText: "Whitespace only", sourceUrl: "   ", sourceNote: "  " });
  await assert.rejects(() => verifyDruidFact(fact.id, adminUserId), DruidFactMissingProvenanceError);
});

// ---- Edit resets verification ----------------------------------------------

test("a verified fact becomes unverified when edited", async () => {
  const fact = await makeFact({ category: "product", factText: "Will be edited", sourceUrl: "https://druidai.com/x" });
  const verified = await verifyDruidFact(fact.id, adminUserId);
  assert.equal(verified!.verificationStatus, "verified");

  const edited = await updateDruidFact(fact.id, { factText: "Edited text" }, adminUserId);
  assert.equal(edited!.verificationStatus, "unverified", "editing a verified fact must reset verification");
  assert.equal(edited!.verifiedByUserId, null);
  assert.equal(edited!.verifiedAt, null);
  assert.equal(edited!.factText, "Edited text");
});

test("editing an already-unverified fact does not touch verification fields", async () => {
  const fact = await makeFact({ category: "product", factText: "Never verified" });
  const edited = await updateDruidFact(fact.id, { factText: "Still never verified" }, adminUserId);
  assert.equal(edited!.verificationStatus, "unverified");
  assert.equal(edited!.verifiedByUserId, null);
});

// ---- Deactivate / reactivate lifecycle -------------------------------------

test("deactivateDruidFact records actor + timestamp and leaves verification_status untouched", async () => {
  const fact = await makeFact({ category: "product", factText: "Will be deactivated", sourceUrl: "https://druidai.com/y" });
  const verified = await verifyDruidFact(fact.id, adminUserId);
  assert.equal(verified!.verificationStatus, "verified");

  const deactivated = await deactivateDruidFact(fact.id, adminUserId);
  assert.equal(deactivated!.active, false);
  assert.equal(deactivated!.deactivatedByUserId, adminUserId);
  assert.ok(deactivated!.deactivatedAt);
  assert.equal(deactivated!.verificationStatus, "verified", "deactivation must not touch verification status");
});

test("a verified fact becomes unverified when reactivated, and deactivation audit fields are cleared", async () => {
  const fact = await makeFact({ category: "product", factText: "Full lifecycle", sourceUrl: "https://druidai.com/z" });
  await verifyDruidFact(fact.id, adminUserId);
  const deactivated = await deactivateDruidFact(fact.id, adminUserId);
  assert.equal(deactivated!.verificationStatus, "verified");

  const reactivated = await reactivateDruidFact(fact.id, adminUserId);
  assert.equal(reactivated!.active, true);
  assert.equal(reactivated!.deactivatedByUserId, null, "reactivate must clear deactivated_by_user_id");
  assert.equal(reactivated!.deactivatedAt, null, "reactivate must clear deactivated_at");
  assert.equal(reactivated!.verificationStatus, "unverified", "reactivation must never silently restore trust");
  assert.equal(reactivated!.verifiedByUserId, null);
  assert.equal(reactivated!.verifiedAt, null);
});

// ---- listTrustedDruidFacts is the sole trusted read path -------------------

test("listTrustedDruidFacts returns only active=true AND verification_status=verified rows", async () => {
  const activeVerified = await makeFact({ category: "product", factText: "Active + verified", sourceUrl: "https://druidai.com/a" });
  await verifyDruidFact(activeVerified.id, adminUserId);

  const activeUnverified = await makeFact({ category: "product", factText: "Active + unverified" });

  const inactiveVerified = await makeFact({ category: "product", factText: "Inactive + verified", sourceUrl: "https://druidai.com/b" });
  await verifyDruidFact(inactiveVerified.id, adminUserId);
  await deactivateDruidFact(inactiveVerified.id, adminUserId);

  const inactiveUnverified = await makeFact({ category: "product", factText: "Inactive + unverified" });
  await deactivateDruidFact(inactiveUnverified.id, adminUserId);

  const trusted = await listTrustedDruidFacts();
  const trustedIds = new Set(trusted.map((f) => f.id));

  assert.ok(trustedIds.has(activeVerified.id), "active+verified must be included");
  assert.ok(!trustedIds.has(activeUnverified.id), "active+unverified must be excluded");
  assert.ok(!trustedIds.has(inactiveVerified.id), "inactive+verified must be excluded");
  assert.ok(!trustedIds.has(inactiveUnverified.id), "inactive+unverified must be excluded");
});

test("listDruidFacts returns the full admin view, including inactive/unverified rows", async () => {
  const fact = await makeFact({ category: "other", factText: "Admin-visible regardless of state" });
  await deactivateDruidFact(fact.id, adminUserId);

  const all = await listDruidFacts();
  assert.ok(all.some((f) => f.id === fact.id), "listDruidFacts must include inactive rows");
});
