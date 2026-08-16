// Phase 11.5C.1: route-level authz/behavior regression tests for the DRUID
// Context foundation (routes/druid_facts.ts). Same harness convention as
// discoveryExclusionsFlow.test.ts/prospectDeleteGuard.test.ts: DB-backed,
// in-process HTTP via createServer(app), own fixtures, child-first teardown.
//
//   DATABASE_URL=... SESSION_SECRET=... tsx --test tests/druidFactsAuthz.test.ts
// or `pnpm run test:druid-facts-authz` with the same env exported.
//
// NOT executed in this sandbox -- requires a real, isolated local Postgres.
// Written and ready to run once that environment exists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, pool, usersTable, druidFactsTable, druidContextSourcesTable } from "@workspace/db";
import app from "../src/app";
import { issueSessionToken } from "../src/services/session";
import { createIngestedDruidFact } from "../src/services/druidFacts";

let server: Server;
let baseUrl: string;

const createdUserIds: string[] = [];
// Phase 11.5C.2: source_url-immutability fixture needs a real
// druid_context_sources row -- tracked separately since it must be deleted
// after facts (FK) but before users.
const createdSourceIds: string[] = [];

let pamId = "";
let pamToken = "";
let adminId = "";
let adminToken = "";

async function insertUser(name: string, role: "pam" | "head_of_channels" | "admin") {
  const [user] = await db
    .insert(usersTable)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, ".")}.${Date.now()}.${Math.random().toString(36).slice(2)}@phase11-test.example`, role, territory: null, active: true })
    .returning();
  createdUserIds.push(user!.id);
  const { token } = issueSessionToken(user!.id);
  return { id: user!.id, token };
}

function authedFetch(path: string, token: string | undefined, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  });
}

// Every DRUID fact created in this file has created_by_user_id set to
// either pamId or adminId (createDruidFact always stamps the acting
// session user -- see services/druidFacts.ts). Sweeping by creator, rather
// than relying on each test to individually track the ids it created, means
// teardown is correct even if a test's own bookkeeping was skipped by an
// early assertion failure or a route-level bug that never returned a valid
// id in its response body -- every fact these fixture users could possibly
// have created is still found and deleted here, before the users
// referencing them are deleted, so the FK (created_by_user_id -> users.id,
// ON DELETE no action) is never violated. FK integrity itself is
// deliberately left untouched -- this only fixes cleanup's delete order/
// scope, never the constraint.
async function deleteFactsCreatedByFixtureUsers(): Promise<void> {
  if (createdUserIds.length === 0) return;
  await db.delete(druidFactsTable).where(inArray(druidFactsTable.createdByUserId, createdUserIds));
}

// Minimal real druid_context_sources fixture row -- normalizedUrl/
// contentHash only need to be unique here, not real normalized/hashed
// values (that logic belongs to druidContextSources.ts, untouched by this
// fix). Used to give an ingested-fact fixture a genuine sourceContextId.
let sourceFixtureRunId = 0;
async function makeContextSource(sourceUrl: string): Promise<string> {
  sourceFixtureRunId++;
  const [source] = await db
    .insert(druidContextSourcesTable)
    .values({
      sourceUrl,
      normalizedUrl: `authz-fixture-${Date.now()}-${sourceFixtureRunId}`,
      contentHash: `authz-fixture-hash-${Date.now()}-${sourceFixtureRunId}`,
      extractedText: "Fixture source text for source_url immutability HTTP tests.",
      reviewStatus: "pending_review",
    })
    .returning();
  createdSourceIds.push(source!.id);
  return source!.id;
}

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  baseUrl = `http://127.0.0.1:${address.port}/api`;

  const pam = await insertUser("Phase115c1 Pam", "pam");
  pamId = pam.id;
  pamToken = pam.token;

  const admin = await insertUser("Phase115c1 Admin", "head_of_channels");
  adminId = admin.id;
  adminToken = admin.token;
});

// try/finally so a throw partway through DB cleanup (or a bug in a route
// under test) can never leave the HTTP server or the Postgres pool open --
// finally always runs, so the process can always exit cleanly.
after(async () => {
  try {
    await deleteFactsCreatedByFixtureUsers();
    for (const id of createdSourceIds) {
      await db.delete(druidContextSourcesTable).where(eq(druidContextSourcesTable.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});

// The response contract is snake_case (fact_text, source_type,
// verified_by_user_id, ...) -- the Drizzle row underneath is camelCase
// (factText, sourceType, verifiedByUserId, ...). This asserts the wire
// format itself, not just individual field values, so a regression back to
// passing the raw row into *Response.parse() (the exact bug this test file
// caught: every mutation route 500'd because the camelCase row didn't match
// the snake_case schema) is caught immediately, not just as an opaque 500.
const CAMEL_CASE_LEAK_KEYS = [
  "factText",
  "sourceType",
  "sourceUrl",
  "sourceNote",
  "verificationStatus",
  "verifiedByUserId",
  "verifiedAt",
  "deactivatedByUserId",
  "deactivatedAt",
  "createdByUserId",
  "createdAt",
  "updatedByUserId",
  "updatedAt",
] as const;

function assertSnakeCaseFactShape(body: any, context: string) {
  assert.equal(typeof body.fact_text, "string", `${context}: fact_text must be present as a string`);
  assert.equal(typeof body.source_type, "string", `${context}: source_type must be present as a string`);
  assert.equal(typeof body.verification_status, "string", `${context}: verification_status must be present as a string`);
  assert.equal(typeof body.created_at, "string", `${context}: created_at must be present as an ISO date string`);
  assert.equal(typeof body.updated_at, "string", `${context}: updated_at must be present as an ISO date string`);
  for (const key of CAMEL_CASE_LEAK_KEYS) {
    assert.equal(body[key], undefined, `${context}: response must not leak the camelCase Drizzle property "${key}"`);
  }
}

// ---- Non-admin users cannot mutate or verify DRUID facts -------------------

test("PAM cannot list, create, edit, verify, deactivate, or reactivate DRUID facts (403)", async () => {
  const listRes = await authedFetch("/druid-facts", pamToken);
  assert.equal(listRes.status, 403);

  const createRes = await authedFetch("/druid-facts", pamToken, { method: "POST", body: JSON.stringify({ category: "product", fact_text: "PAM attempt" }) });
  assert.equal(createRes.status, 403);

  // Seed a fact as admin to exercise the remaining PAM-forbidden routes against a real id.
  const adminCreate = await authedFetch("/druid-facts", adminToken, { method: "POST", body: JSON.stringify({ category: "product", fact_text: "Seed for PAM authz checks" }) });
  assert.equal(adminCreate.status, 201, "seeding the fact as admin must succeed");
  const seeded = await adminCreate.json();
  assert.ok(seeded.id, "seed create must return a real id");

  const patchRes = await authedFetch(`/druid-facts/${seeded.id}`, pamToken, { method: "PATCH", body: JSON.stringify({ fact_text: "PAM edit attempt" }) });
  assert.equal(patchRes.status, 403);

  const verifyRes = await authedFetch(`/druid-facts/${seeded.id}/verify`, pamToken, { method: "POST" });
  assert.equal(verifyRes.status, 403);

  const deactivateRes = await authedFetch(`/druid-facts/${seeded.id}/deactivate`, pamToken, { method: "POST" });
  assert.equal(deactivateRes.status, 403);

  const reactivateRes = await authedFetch(`/druid-facts/${seeded.id}/reactivate`, pamToken, { method: "POST" });
  assert.equal(reactivateRes.status, 403);

  // A 403 must mean requireAdmin blocked the request before the route
  // handler ran at all -- prove that, not just that fact_text survived, by
  // re-checking the complete lifecycle/trust state the four forbidden calls
  // (patch/verify/deactivate/reactivate) each could have mutated.
  const [row] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, seeded.id));
  assert.equal(row!.factText, "Seed for PAM authz checks", "no forbidden PAM request may have mutated the fact text");
  assert.equal(row!.active, true, "no forbidden PAM request may have deactivated the fact");
  assert.equal(row!.verificationStatus, "unverified", "no forbidden PAM request may have verified the fact");
  assert.equal(row!.verifiedByUserId, null, "no forbidden PAM request may have set a verifier");
  assert.equal(row!.verifiedAt, null, "no forbidden PAM request may have set verified_at");
  assert.equal(row!.deactivatedByUserId, null, "no forbidden PAM request may have set a deactivator");
  assert.equal(row!.deactivatedAt, null, "no forbidden PAM request may have set deactivated_at");
});

// ---- Admin CRUD happy path --------------------------------------------------

test("admin can create, list, edit, verify, deactivate, and reactivate a DRUID fact", async () => {
  const createRes = await authedFetch("/druid-facts", adminToken, {
    method: "POST",
    body: JSON.stringify({ category: "ideal_partner_profile", fact_text: "Looks for system integrators with contact-center delivery experience.", source_url: "https://druidai.com/partners" }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assertSnakeCaseFactShape(created, "POST /druid-facts response");
  assert.equal(created.verification_status, "unverified");
  assert.equal(created.active, true);

  const listRes = await authedFetch("/druid-facts", adminToken);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  const listedItem = list.find((f: any) => f.id === created.id);
  assert.ok(listedItem, "the created fact must appear in the list");
  assertSnakeCaseFactShape(listedItem, "GET /druid-facts list item");

  const patchRes = await authedFetch(`/druid-facts/${created.id}`, adminToken, { method: "PATCH", body: JSON.stringify({ fact_text: "Updated: looks for SIs with CCaaS delivery experience." }) });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assertSnakeCaseFactShape(patched, "PATCH /druid-facts/:id response");
  assert.equal(patched.fact_text, "Updated: looks for SIs with CCaaS delivery experience.");

  const verifyRes = await authedFetch(`/druid-facts/${created.id}/verify`, adminToken, { method: "POST" });
  assert.equal(verifyRes.status, 200);
  const verified = await verifyRes.json();
  assertSnakeCaseFactShape(verified, "POST .../verify response");
  assert.equal(verified.verification_status, "verified");
  assert.equal(verified.verified_by_user_id, adminId);

  const deactivateRes = await authedFetch(`/druid-facts/${created.id}/deactivate`, adminToken, { method: "POST" });
  assert.equal(deactivateRes.status, 200);
  const deactivated = await deactivateRes.json();
  assertSnakeCaseFactShape(deactivated, "POST .../deactivate response");
  assert.equal(deactivated.active, false);
  assert.equal(deactivated.deactivated_by_user_id, adminId);
  assert.ok(deactivated.deactivated_at);
  assert.equal(deactivated.verification_status, "verified", "deactivation must not touch verification");

  const reactivateRes = await authedFetch(`/druid-facts/${created.id}/reactivate`, adminToken, { method: "POST" });
  assert.equal(reactivateRes.status, 200);
  const reactivated = await reactivateRes.json();
  assertSnakeCaseFactShape(reactivated, "POST .../reactivate response");
  assert.equal(reactivated.active, true);
  assert.equal(reactivated.deactivated_by_user_id, null);
  assert.equal(reactivated.deactivated_at, null);
  assert.equal(reactivated.verification_status, "unverified", "reactivation must require re-verification");
});

// ---- 404 for a nonexistent id, on every id-based mutation route -----------

const NONEXISTENT_FACT_ID = "00000000-0000-0000-0000-000000000001";

test("PATCH/verify/deactivate/reactivate all return 404 for a nonexistent DRUID fact id", async () => {
  const patchRes = await authedFetch(`/druid-facts/${NONEXISTENT_FACT_ID}`, adminToken, { method: "PATCH", body: JSON.stringify({ fact_text: "Should not apply to anything" }) });
  assert.equal(patchRes.status, 404);
  const patchBody = await patchRes.json();
  assert.equal(patchBody.error, "DRUID fact not found");

  const verifyRes = await authedFetch(`/druid-facts/${NONEXISTENT_FACT_ID}/verify`, adminToken, { method: "POST" });
  assert.equal(verifyRes.status, 404);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.error, "DRUID fact not found");

  const deactivateRes = await authedFetch(`/druid-facts/${NONEXISTENT_FACT_ID}/deactivate`, adminToken, { method: "POST" });
  assert.equal(deactivateRes.status, 404);
  const deactivateBody = await deactivateRes.json();
  assert.equal(deactivateBody.error, "DRUID fact not found");

  const reactivateRes = await authedFetch(`/druid-facts/${NONEXISTENT_FACT_ID}/reactivate`, adminToken, { method: "POST" });
  assert.equal(reactivateRes.status, 404);
  const reactivateBody = await reactivateRes.json();
  assert.equal(reactivateBody.error, "DRUID fact not found");
});

// ---- Provenance gate is enforced over HTTP ---------------------------------

test("POST /druid-facts/:id/verify returns 422 when the fact has no source_url and no source_note", async () => {
  const createRes = await authedFetch("/druid-facts", adminToken, { method: "POST", body: JSON.stringify({ category: "other", fact_text: "No provenance at all" }) });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  const verifyRes = await authedFetch(`/druid-facts/${created.id}/verify`, adminToken, { method: "POST" });
  assert.equal(verifyRes.status, 422);

  const [row] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, created.id));
  assert.equal(row!.verificationStatus, "unverified", "a rejected verify must not change the row");
});

// ---- Create API cannot set server-owned fields -----------------------------

test("POST /druid-facts ignores client-supplied verification/lifecycle/server-owned fields", async () => {
  const createRes = await authedFetch("/druid-facts", adminToken, {
    method: "POST",
    body: JSON.stringify({
      category: "product",
      fact_text: "Attempted privilege escalation via extra body fields",
      source_url: "https://druidai.com/x",
      // None of the following are part of DruidFactCreateInput -- must be silently ignored, not honored.
      source_type: "ingested",
      verification_status: "verified",
      active: false,
      verified_by_user_id: "00000000-0000-0000-0000-000000000000",
      verified_at: "2020-01-01T00:00:00.000Z",
      created_by_user_id: "00000000-0000-0000-0000-000000000000",
      deactivated_by_user_id: "00000000-0000-0000-0000-000000000000",
      deactivated_at: "2020-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assertSnakeCaseFactShape(created, "POST /druid-facts response (escalation attempt)");

  assert.equal(created.source_type, "manual", "source_type must always be server-set to manual in this slice");
  assert.equal(created.verification_status, "unverified", "verification_status must never be settable on create");
  assert.equal(created.active, true, "active must always start true, regardless of client input");
  assert.equal(created.verified_by_user_id, null);
  assert.equal(created.verified_at, null);
  assert.equal(created.created_by_user_id, adminId, "created_by_user_id must be the acting session user, never client-supplied");
  assert.equal(created.deactivated_by_user_id, null);
  assert.equal(created.deactivated_at, null);

  const [row] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, created.id));
  assert.equal(row!.sourceType, "manual");
  assert.equal(row!.verificationStatus, "unverified");
  assert.equal(row!.active, true);
});

test("PATCH /druid-facts/:id ignores client-supplied verification/lifecycle/server-owned fields", async () => {
  const createRes = await authedFetch("/druid-facts", adminToken, { method: "POST", body: JSON.stringify({ category: "product", fact_text: "Base fact for patch escalation test" }) });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  const patchRes = await authedFetch(`/druid-facts/${created.id}`, adminToken, {
    method: "PATCH",
    body: JSON.stringify({
      fact_text: "Legit edit",
      verification_status: "verified",
      active: false,
      verified_by_user_id: adminId,
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.fact_text, "Legit edit");
  assert.equal(patched.verification_status, "unverified", "PATCH must never be able to set verification_status directly");
  assert.equal(patched.active, true, "PATCH must never be able to set active directly -- only deactivate/reactivate can");
});

// ---- Phase 11.5C.2: ingested-fact source_url immutability -----------------

test("PATCH /druid-facts/:id: an ingested fact rejects a source_url change (409, stable business error, unchanged provenance) but still allows editing an allowed field", async () => {
  const sourceId = await makeContextSource("https://druidai.com/authz-ingested-original");
  const fact = await createIngestedDruidFact(
    { category: "product", factText: "Ingested authz fixture", sourceUrl: "https://druidai.com/authz-ingested-original", sourceContextId: sourceId },
    adminId,
  );

  const rejectedRes = await authedFetch(`/druid-facts/${fact.id}`, adminToken, {
    method: "PATCH",
    body: JSON.stringify({ source_url: "https://druidai.com/authz-attempted-change" }),
  });
  assert.equal(rejectedRes.status, 409);
  const rejectedBody = await rejectedRes.json();
  assert.equal(typeof rejectedBody.error, "string");
  assert.ok(rejectedBody.error.toLowerCase().includes("source_url"), "the response must surface the stable source_url-immutable business error, not a generic message");

  const [rowAfterRejection] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, fact.id));
  assert.equal(rowAfterRejection!.sourceUrl, "https://druidai.com/authz-ingested-original", "a rejected PATCH must not change source_url");
  assert.equal(rowAfterRejection!.sourceContextId, sourceId, "a rejected PATCH must not change source_context_id");

  const allowedRes = await authedFetch(`/druid-facts/${fact.id}`, adminToken, {
    method: "PATCH",
    body: JSON.stringify({ fact_text: "Rewritten after the rejected source_url attempt" }),
  });
  assert.equal(allowedRes.status, 200);
  const allowedBody = await allowedRes.json();
  assert.equal(allowedBody.fact_text, "Rewritten after the rejected source_url attempt");
  assert.equal(allowedBody.source_url, "https://druidai.com/authz-ingested-original", "an allowed edit must leave source_url untouched");
  assert.equal(allowedBody.source_context_id, sourceId, "an allowed edit must leave source_context_id untouched");
});
