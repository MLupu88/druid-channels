// Phase 11.5C.2: route-level authz/behavior regression tests for DRUID
// Context source ingestion (routes/druid_context_sources.ts). Same harness
// convention as druidFactsAuthz.test.ts: DB-backed, in-process HTTP via
// createServer(app), own fixtures, try/finally teardown that sweeps by
// creator rather than relying on individual test bookkeeping. No live
// Tavily call -- the refresh route exercises the real provider path, so
// this file never calls /druid-context-sources/refresh; source fixtures
// are seeded directly via services/druidContextSources.ts's
// refreshDruidContextSources with an injected crawlFn instead.
//
//   DATABASE_URL=... SESSION_SECRET=... tsx --test tests/druidContextSourcesAuthz.test.ts
// or `pnpm run test:druid-context-sources-authz` with the same env exported.
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
import { refreshDruidContextSources } from "../src/services/druidContextSources";

let server: Server;
let baseUrl: string;

const createdUserIds: string[] = [];
const createdSourceUrls: string[] = [];

let pamId = "";
let pamToken = "";
let adminId = "";
let adminToken = "";

async function insertUser(name: string, role: "pam" | "head_of_channels") {
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

let runId = 0;
async function seedSource(text = "Seed source content for authz tests."): Promise<string> {
  runId++;
  const url = `https://druidai.com/phase115c2-authz-${Date.now()}-${runId}`;
  createdSourceUrls.push(url);
  await refreshDruidContextSources(async () => [{ url, text }]);
  const [row] = await db.select({ id: druidContextSourcesTable.id }).from(druidContextSourcesTable).where(eq(druidContextSourcesTable.sourceUrl, url));
  return row!.id;
}

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  baseUrl = `http://127.0.0.1:${address.port}/api`;

  const pam = await insertUser("Phase115c2 Pam", "pam");
  pamId = pam.id;
  pamToken = pam.token;

  const admin = await insertUser("Phase115c2 Admin", "head_of_channels");
  adminId = admin.id;
  adminToken = admin.token;
});

after(async () => {
  try {
    if (createdUserIds.length > 0) {
      await db.delete(druidFactsTable).where(inArray(druidFactsTable.createdByUserId, createdUserIds));
    }
    for (const url of createdSourceUrls) {
      await db.delete(druidContextSourcesTable).where(eq(druidContextSourcesTable.sourceUrl, url));
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

// The response contract is snake_case; the Drizzle rows underneath are
// camelCase -- same lesson caught by 11.5C.1's druidFactsAuthz.test.ts.
const CAMEL_CASE_LEAK_KEYS = ["sourceUrl", "extractedText", "reviewStatus", "extractedAt", "lastSeenAt", "reviewedByUserId", "reviewedAt"] as const;

function assertSnakeCaseSourceShape(body: any) {
  assert.equal(typeof body.source_url, "string");
  assert.equal(typeof body.extracted_text, "string");
  assert.equal(typeof body.review_status, "string");
  assert.equal(typeof body.extracted_at, "string");
  assert.equal(typeof body.last_seen_at, "string");
  assert.equal(body.normalized_url, undefined, "normalized_url must never be part of the public response");
  assert.equal(body.content_hash, undefined, "content_hash must never be part of the public response");
  for (const key of CAMEL_CASE_LEAK_KEYS) {
    assert.equal(body[key], undefined, `response must not leak the camelCase Drizzle property "${key}"`);
  }
}

// ---- Non-admin users cannot touch any DRUID context source route ----------

test("PAM cannot refresh, list, review, ignore, or create a fact from a DRUID context source (403)", async () => {
  const sourceId = await seedSource();

  const refreshRes = await authedFetch("/druid-context-sources/refresh", pamToken, { method: "POST" });
  assert.equal(refreshRes.status, 403);

  const listRes = await authedFetch("/druid-context-sources", pamToken);
  assert.equal(listRes.status, 403);

  const reviewRes = await authedFetch(`/druid-context-sources/${sourceId}/review`, pamToken, { method: "POST" });
  assert.equal(reviewRes.status, 403);

  const ignoreRes = await authedFetch(`/druid-context-sources/${sourceId}/ignore`, pamToken, { method: "POST" });
  assert.equal(ignoreRes.status, 403);

  const factRes = await authedFetch(`/druid-context-sources/${sourceId}/facts`, pamToken, {
    method: "POST",
    body: JSON.stringify({ category: "product", fact_text: "PAM attempt" }),
  });
  assert.equal(factRes.status, 403);

  const [row] = await db.select().from(druidContextSourcesTable).where(eq(druidContextSourcesTable.id, sourceId));
  assert.equal(row!.reviewStatus, "pending_review", "no forbidden PAM request may have mutated the source's review status");
  assert.equal(row!.reviewedByUserId, null);
  assert.equal(row!.reviewedAt, null);

  const factRows = await db.select().from(druidFactsTable).where(eq(druidFactsTable.sourceContextId, sourceId));
  assert.equal(factRows.length, 0, "no forbidden PAM request may have created a fact");
});

// ---- Admin happy paths -------------------------------------------------

test("admin can list DRUID context sources with the correct wire shape", async () => {
  await seedSource();
  const res = await authedFetch("/druid-context-sources", adminToken);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 0);
  assertSnakeCaseSourceShape(list[0]);
});

test("admin can mark a source reviewed", async () => {
  const sourceId = await seedSource();
  const res = await authedFetch(`/druid-context-sources/${sourceId}/review`, adminToken, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assertSnakeCaseSourceShape(body);
  assert.equal(body.review_status, "reviewed");
  assert.equal(body.reviewed_by_user_id, adminId);
  assert.ok(body.reviewed_at);
});

test("admin can ignore a source, and a second review/ignore attempt is rejected (409)", async () => {
  const sourceId = await seedSource();
  const res = await authedFetch(`/druid-context-sources/${sourceId}/ignore`, adminToken, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.review_status, "ignored");

  const reReview = await authedFetch(`/druid-context-sources/${sourceId}/review`, adminToken, { method: "POST" });
  assert.equal(reReview.status, 409);

  const reIgnore = await authedFetch(`/druid-context-sources/${sourceId}/ignore`, adminToken, { method: "POST" });
  assert.equal(reIgnore.status, 409);
});

test("admin cannot create a fact from an ignored source (409), and no fact is created", async () => {
  const sourceId = await seedSource();
  await authedFetch(`/druid-context-sources/${sourceId}/ignore`, adminToken, { method: "POST" });

  const res = await authedFetch(`/druid-context-sources/${sourceId}/facts`, adminToken, {
    method: "POST",
    body: JSON.stringify({ category: "product", fact_text: "Should never be created" }),
  });
  assert.equal(res.status, 409);

  const factRows = await db.select().from(druidFactsTable).where(eq(druidFactsTable.sourceContextId, sourceId));
  assert.equal(factRows.length, 0);
});

test("admin creates a fact from a pending_review source: fact is unverified and carries source_context_id/source_url; source becomes reviewed", async () => {
  const sourceId = await seedSource("DRUID's ideal partner has enterprise contact-center delivery experience.");

  const res = await authedFetch(`/druid-context-sources/${sourceId}/facts`, adminToken, {
    method: "POST",
    body: JSON.stringify({ category: "ideal_partner_profile", fact_text: "Looks for partners with enterprise contact-center delivery experience." }),
  });
  assert.equal(res.status, 201);
  const fact = await res.json();
  assert.equal(fact.source_type, "ingested");
  assert.equal(fact.verification_status, "unverified");
  assert.equal(fact.source_context_id, sourceId);
  assert.ok(fact.source_url, "the created fact must carry the original source_url");

  const sourceRes = await authedFetch("/druid-context-sources", adminToken);
  const sourceList = await sourceRes.json();
  const updatedSource = sourceList.find((s: any) => s.id === sourceId);
  assert.equal(updatedSource.review_status, "reviewed");
});

test("a reviewed source can still create a second fact via the API", async () => {
  const sourceId = await seedSource("A source that will produce two facts.");
  const first = await authedFetch(`/druid-context-sources/${sourceId}/facts`, adminToken, {
    method: "POST",
    body: JSON.stringify({ category: "product", fact_text: "First fact." }),
  });
  assert.equal(first.status, 201);

  const second = await authedFetch(`/druid-context-sources/${sourceId}/facts`, adminToken, {
    method: "POST",
    body: JSON.stringify({ category: "proof_point", fact_text: "Second fact from the same source." }),
  });
  assert.equal(second.status, 201);
  const secondBody = await second.json();
  assert.equal(secondBody.source_context_id, sourceId);
});

// ---- 404s -----------------------------------------------------------------

const NONEXISTENT_SOURCE_ID = "00000000-0000-0000-0000-000000000001";

test("review/ignore/facts all return 404 for a nonexistent source id", async () => {
  const reviewRes = await authedFetch(`/druid-context-sources/${NONEXISTENT_SOURCE_ID}/review`, adminToken, { method: "POST" });
  assert.equal(reviewRes.status, 404);

  const ignoreRes = await authedFetch(`/druid-context-sources/${NONEXISTENT_SOURCE_ID}/ignore`, adminToken, { method: "POST" });
  assert.equal(ignoreRes.status, 404);

  const factRes = await authedFetch(`/druid-context-sources/${NONEXISTENT_SOURCE_ID}/facts`, adminToken, {
    method: "POST",
    body: JSON.stringify({ category: "product", fact_text: "Should 404" }),
  });
  assert.equal(factRes.status, 404);
});
