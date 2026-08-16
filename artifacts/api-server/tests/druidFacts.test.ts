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
import { db, pool, usersTable, druidFactsTable, druidContextSourcesTable } from "@workspace/db";
import {
  listDruidFacts,
  listTrustedDruidFacts,
  createDruidFact,
  createIngestedDruidFact,
  updateDruidFact,
  verifyDruidFact,
  deactivateDruidFact,
  reactivateDruidFact,
  DruidFactMissingProvenanceError,
  InvalidDruidFactCategoryError,
  DruidFactSourceUrlImmutableError,
} from "../src/services/druidFacts";

let adminUserId: string;
const createdUserIds: string[] = [];
const createdFactIds: string[] = [];
// Phase 11.5C.2 source_url-immutability tests need a real
// druid_context_sources row to attach ingested fact fixtures to -- tracked
// separately since it must be deleted after facts (FK) but before users.
const createdSourceIds: string[] = [];

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
  // Child-first: facts reference both sources and users (FK), sources
  // reference users (reviewed_by_user_id) -- facts must go first, then
  // sources, then users.
  for (const id of createdFactIds) {
    await db.delete(druidFactsTable).where(eq(druidFactsTable.id, id));
  }
  for (const id of createdSourceIds) {
    await db.delete(druidContextSourcesTable).where(eq(druidContextSourcesTable.id, id));
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

// Phase 11.5C.2: a minimal real druid_context_sources fixture row, so
// createIngestedDruidFact has a genuine sourceContextId to reference --
// normalizedUrl/contentHash only need to be unique here, not real
// normalized/hashed values (that logic belongs to druidContextSources.ts,
// untouched by this fix).
let sourceFixtureRunId = 0;
async function makeContextSource(sourceUrl: string): Promise<string> {
  sourceFixtureRunId++;
  const [source] = await db
    .insert(druidContextSourcesTable)
    .values({
      sourceUrl,
      normalizedUrl: `fixture-${Date.now()}-${sourceFixtureRunId}`,
      contentHash: `fixture-hash-${Date.now()}-${sourceFixtureRunId}`,
      extractedText: "Fixture source text for source_url immutability tests.",
      reviewStatus: "pending_review",
    })
    .returning();
  createdSourceIds.push(source!.id);
  return source!.id;
}

async function makeIngestedFact(overrides: { category?: string; factText?: string; sourceUrl?: string; sourceNote?: string | null } = {}) {
  const sourceUrl = overrides.sourceUrl ?? "https://druidai.com/ingested-fixture";
  const sourceContextId = await makeContextSource(sourceUrl);
  const created = await createIngestedDruidFact(
    {
      category: overrides.category ?? "product",
      factText: overrides.factText ?? "Ingested fixture fact",
      sourceUrl,
      sourceContextId,
      sourceNote: overrides.sourceNote ?? null,
    },
    adminUserId,
  );
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

// ---- Phase 11.5C.2: ingested-fact source_url immutability ------------------

test("updateDruidFact: a manual fact's source_url remains editable exactly as before", async () => {
  const fact = await makeFact({ category: "product", factText: "Manual fact", sourceUrl: "https://druidai.com/manual-original" });
  const edited = await updateDruidFact(fact.id, { sourceUrl: "https://druidai.com/manual-changed" }, adminUserId);
  assert.equal(edited!.sourceUrl, "https://druidai.com/manual-changed");
});

test("updateDruidFact rejects changing source_url on an ingested fact, leaving source_url and source_context_id unchanged", async () => {
  const fact = await makeIngestedFact({ sourceUrl: "https://druidai.com/ingested-original" });
  assert.equal(fact.sourceType, "ingested");

  await assert.rejects(
    () => updateDruidFact(fact.id, { sourceUrl: "https://druidai.com/attempted-change" }, adminUserId),
    DruidFactSourceUrlImmutableError,
  );

  const [row] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, fact.id));
  assert.equal(row!.sourceUrl, "https://druidai.com/ingested-original", "source_url must remain unchanged after a rejected update");
  assert.equal(row!.sourceContextId, fact.sourceContextId, "source_context_id must remain unchanged");
});

test("updateDruidFact allows idempotently resubmitting an ingested fact's own unchanged source_url", async () => {
  const fact = await makeIngestedFact({ sourceUrl: "https://druidai.com/idempotent" });
  const edited = await updateDruidFact(fact.id, { sourceUrl: "https://druidai.com/idempotent", factText: "Updated text" }, adminUserId);
  assert.ok(edited, "resubmitting the fact's own current source_url must not be rejected");
  assert.equal(edited!.sourceUrl, "https://druidai.com/idempotent");
  assert.equal(edited!.factText, "Updated text");
});

test("updateDruidFact still allows editing category/fact_text/source_note on an ingested fact", async () => {
  const fact = await makeIngestedFact({ category: "product", factText: "Original text", sourceUrl: "https://druidai.com/editable-fields" });
  const edited = await updateDruidFact(fact.id, { category: "positioning", factText: "Rewritten text", sourceNote: "Added a note" }, adminUserId);
  assert.equal(edited!.category, "positioning");
  assert.equal(edited!.factText, "Rewritten text");
  assert.equal(edited!.sourceNote, "Added a note");
  assert.equal(edited!.sourceUrl, "https://druidai.com/editable-fields", "source_url must remain untouched when it is not part of the update");
});

test("editing an allowed field on a verified ingested fact still resets verification, leaving source_url/source_context_id unchanged", async () => {
  const fact = await makeIngestedFact({ sourceUrl: "https://druidai.com/verify-reset" });
  const verified = await verifyDruidFact(fact.id, adminUserId);
  assert.equal(verified!.verificationStatus, "verified");

  const edited = await updateDruidFact(fact.id, { factText: "Edited after verification" }, adminUserId);
  assert.equal(edited!.verificationStatus, "unverified", "editing an allowed field must still reset verification for an ingested fact");
  assert.equal(edited!.verifiedByUserId, null);
  assert.equal(edited!.verifiedAt, null);
  assert.equal(edited!.sourceUrl, fact.sourceUrl, "source_url must remain unchanged");
  assert.equal(edited!.sourceContextId, fact.sourceContextId, "source_context_id must remain unchanged");
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

test("listTrustedDruidFacts orders deterministically: created_at DESC, id ASC as a tie-breaker", async () => {
  const factA = await makeFact({ category: "product", factText: "Tie-break fact A", sourceUrl: "https://druidai.com/tie-a" });
  await verifyDruidFact(factA.id, adminUserId);
  const factB = await makeFact({ category: "product", factText: "Tie-break fact B", sourceUrl: "https://druidai.com/tie-b" });
  await verifyDruidFact(factB.id, adminUserId);

  // Force an identical created_at on both so this genuinely exercises the
  // tie-breaker, not just created_at's own natural ordering (which would
  // pass even without the id tie-break).
  const tiedTimestamp = new Date("2026-01-01T00:00:00.000Z");
  await db.update(druidFactsTable).set({ createdAt: tiedTimestamp }).where(eq(druidFactsTable.id, factA.id));
  await db.update(druidFactsTable).set({ createdAt: tiedTimestamp }).where(eq(druidFactsTable.id, factB.id));

  const trusted = await listTrustedDruidFacts();
  const tiedOrder = trusted.filter((f) => f.id === factA.id || f.id === factB.id).map((f) => f.id);
  const [smallerId, largerId] = [factA.id, factB.id].sort();
  assert.deepEqual(tiedOrder, [smallerId, largerId], "rows with an identical created_at must be ordered by id ascending as a deterministic tie-breaker");
});

test("listDruidFacts returns the full admin view, including inactive/unverified rows", async () => {
  const fact = await makeFact({ category: "other", factText: "Admin-visible regardless of state" });
  await deactivateDruidFact(fact.id, adminUserId);

  const all = await listDruidFacts();
  assert.ok(all.some((f) => f.id === fact.id), "listDruidFacts must include inactive rows");
});
