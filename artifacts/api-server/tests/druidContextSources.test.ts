// Phase 11.5C.2: service-level DB-backed coverage for DRUID Context source
// ingestion (services/druidContextSources.ts). Same harness convention as
// druidFacts.test.ts: real Postgres, own fixtures, explicit child-first
// teardown. refreshDruidContextSources's crawlFn is injected with canned
// pages -- no live Tavily call anywhere in this file.
//
//   DATABASE_URL=... tsx --test tests/druidContextSources.test.ts
// or `pnpm run test:druid-context-sources` with the same env exported.
//
// NOT executed in this sandbox -- requires a real, isolated local Postgres.
// Written and ready to run once that environment exists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, pool, usersTable, druidFactsTable, druidContextSourcesTable } from "@workspace/db";
import {
  normalizeUrl,
  computeContentHash,
  boundExtractedText,
  refreshDruidContextSources,
  listDruidContextSources,
  markSourceReviewed,
  markSourceIgnored,
  createFactFromSource,
  DruidContextSourceIgnoredError,
  DruidContextSourceInvalidTransitionError,
} from "../src/services/druidContextSources";
import { listTrustedDruidFacts } from "../src/services/druidFacts";
import type { CrawledPage } from "../src/services/druidContextIngestionProvider";

let adminUserId: string;
const createdUserIds: string[] = [];
// Sources reach pending_review before ever being touched by the fixture
// user (reviewedByUserId is only set once review/ignore/create-fact runs),
// so a review-sweep alone can't find them -- every source URL this file
// creates is tracked here and swept explicitly on top of the reviewer-based
// sweep below.
const createdSourceUrls: string[] = [];

before(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      name: "Phase115c2 Test Admin",
      email: `phase115c2.${Date.now()}.${Math.random().toString(36).slice(2)}@phase11-test.example`,
      role: "head_of_channels",
      territory: null,
      active: true,
    })
    .returning();
  adminUserId = admin!.id;
  createdUserIds.push(adminUserId);
});

// Sweeps everything created by this file's fixture user/sources rather than
// relying on individual test bookkeeping alone -- same robust-teardown
// lesson learned in druidFactsAuthz.test.ts. try/finally so a failure
// partway through cleanup can never leave the pool open.
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
    await pool.end();
  }
});

let runId = 0;
function uniquePage(pathSuffix: string, text: string): CrawledPage {
  runId++;
  const url = `https://druidai.com/phase115c2-${pathSuffix}-${Date.now()}-${runId}`;
  createdSourceUrls.push(url);
  return { url, text };
}

async function crawlOnce(page: CrawledPage) {
  return refreshDruidContextSources(async () => [page]);
}

async function getSourceByUrl(url: string) {
  const [row] = await db.select().from(druidContextSourcesTable).where(eq(druidContextSourcesTable.sourceUrl, url));
  return row ?? null;
}

// ---- normalizeUrl / boundExtractedText / computeContentHash ---------------

test("normalizeUrl lowercases the host, strips www., drops the fragment, normalizes trailing slash, strips utm_*/gclid/fbclid, and sorts remaining params", () => {
  const a = normalizeUrl("https://WWW.druidai.com/Product/?utm_source=x&b=2&a=1&gclid=abc#section");
  const b = normalizeUrl("https://druidai.com/Product?a=1&b=2");
  assert.equal(a, b);
  assert.equal(a, "druidai.com/Product?a=1&b=2");
});

test("normalizeUrl treats a root path with and without a trailing slash the same", () => {
  assert.equal(normalizeUrl("https://druidai.com/"), normalizeUrl("https://druidai.com"));
});

test("computeContentHash is deterministic and computed over the bounded (not raw) text", () => {
  const raw = "x".repeat(20_000);
  const bounded = boundExtractedText(raw);
  assert.ok(bounded.length < raw.length, "boundExtractedText must actually truncate an oversized page");
  assert.equal(computeContentHash(bounded), computeContentHash(boundExtractedText(raw)));
});

// ---- Refresh: create / update-only / new-version semantics -----------------

test("first crawl of a new URL creates a pending_review source", async () => {
  const page = uniquePage("first", "Initial DRUID product content.");
  const summary = await crawlOnce(page);
  assert.equal(summary.pagesCrawled, 1);
  assert.equal(summary.newSources, 1);
  assert.equal(summary.updatedSources, 0);

  const row = await getSourceByUrl(page.url);
  assert.ok(row);
  assert.equal(row!.reviewStatus, "pending_review");
  assert.equal(row!.extractedText, page.text);
});

test("a second crawl with unchanged content only bumps last_seen_at -- no duplicate row", async () => {
  const page = uniquePage("unchanged", "Stable content that never changes.");
  await crawlOnce(page);
  const first = await getSourceByUrl(page.url);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const summary = await crawlOnce(page);
  assert.equal(summary.newSources, 0);
  assert.equal(summary.updatedSources, 1);

  const rows = await db.select().from(druidContextSourcesTable).where(eq(druidContextSourcesTable.sourceUrl, page.url));
  assert.equal(rows.length, 1, "no duplicate row for unchanged content");
  assert.equal(rows[0]!.id, first!.id);
  assert.ok(rows[0]!.lastSeenAt instanceof Date);
});

test("a crawl with changed content at the same URL creates a NEW pending_review version, leaving the old one untouched", async () => {
  runId++;
  const url = `https://druidai.com/phase115c2-changed-${Date.now()}-${runId}`;
  createdSourceUrls.push(url);

  await crawlOnce({ url, text: "Version one of this page." });
  const v1 = await getSourceByUrl(url);

  const summary = await refreshDruidContextSources(async () => [{ url, text: "Version two -- content actually changed." }]);
  assert.equal(summary.newSources, 1);
  assert.equal(summary.updatedSources, 0);

  const rows = await db.select().from(druidContextSourcesTable).where(eq(druidContextSourcesTable.sourceUrl, url));
  assert.equal(rows.length, 2, "changed content must create a second, distinct version");
  const v1After = rows.find((r) => r.id === v1!.id);
  assert.equal(v1After!.extractedText, "Version one of this page.", "the old version's content must remain untouched");
  const v2 = rows.find((r) => r.id !== v1!.id);
  assert.equal(v2!.extractedText, "Version two -- content actually changed.");
  assert.equal(v2!.reviewStatus, "pending_review");
});

// ---- Review / ignore lifecycle --------------------------------------------

test("markSourceReviewed records the actor and timestamp", async () => {
  const page = uniquePage("review", "Content to be reviewed.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);

  const updated = await markSourceReviewed(source!.id, adminUserId);
  assert.equal(updated!.reviewStatus, "reviewed");
  assert.equal(updated!.reviewedByUserId, adminUserId);
  assert.ok(updated!.reviewedAt);
});

test("markSourceIgnored records the actor and timestamp", async () => {
  const page = uniquePage("ignore", "Content to be ignored.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);

  const updated = await markSourceIgnored(source!.id, adminUserId);
  assert.equal(updated!.reviewStatus, "ignored");
  assert.equal(updated!.reviewedByUserId, adminUserId);
  assert.ok(updated!.reviewedAt);
});

test("review/ignore transitions are terminal -- re-transitioning an already-reviewed or already-ignored source is rejected", async () => {
  const reviewedPage = uniquePage("terminal-reviewed", "Already reviewed.");
  await crawlOnce(reviewedPage);
  const reviewedSource = await getSourceByUrl(reviewedPage.url);
  await markSourceReviewed(reviewedSource!.id, adminUserId);
  await assert.rejects(() => markSourceReviewed(reviewedSource!.id, adminUserId), DruidContextSourceInvalidTransitionError);
  await assert.rejects(() => markSourceIgnored(reviewedSource!.id, adminUserId), DruidContextSourceInvalidTransitionError);

  const ignoredPage = uniquePage("terminal-ignored", "Already ignored.");
  await crawlOnce(ignoredPage);
  const ignoredSource = await getSourceByUrl(ignoredPage.url);
  await markSourceIgnored(ignoredSource!.id, adminUserId);
  await assert.rejects(() => markSourceIgnored(ignoredSource!.id, adminUserId), DruidContextSourceInvalidTransitionError);
});

test("listDruidContextSources excludes ignored sources", async () => {
  const page = uniquePage("list-ignored", "Will be ignored and must not be listed.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);
  await markSourceIgnored(source!.id, adminUserId);

  const listed = await listDruidContextSources();
  assert.ok(!listed.some((s) => s.id === source!.id), "an ignored source must not appear in the working list");
});

// ---- Fact creation from a source (transactional) ---------------------------

test("an ignored source cannot be used to create a fact", async () => {
  const page = uniquePage("ignored-no-fact", "Ignored source content.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);
  await markSourceIgnored(source!.id, adminUserId);

  await assert.rejects(
    () => createFactFromSource(source!.id, { category: "product", factText: "Should never be created" }, adminUserId),
    DruidContextSourceIgnoredError,
  );

  const factRows = await db.select().from(druidFactsTable).where(eq(druidFactsTable.sourceContextId, source!.id));
  assert.equal(factRows.length, 0, "no fact may be created from an ignored source");
});

test("creating a fact from a pending_review source atomically creates an unverified fact and marks the source reviewed", async () => {
  const page = uniquePage("pending-to-fact", "DRUID is an enterprise conversational AI platform.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);
  assert.equal(source!.reviewStatus, "pending_review");

  const fact = await createFactFromSource(source!.id, { category: "positioning", factText: "DRUID is an enterprise conversational AI platform." }, adminUserId);
  assert.ok(fact);
  assert.equal(fact!.sourceType, "ingested");
  assert.equal(fact!.verificationStatus, "unverified");
  assert.equal(fact!.active, true);
  assert.equal(fact!.sourceContextId, source!.id);
  assert.equal(fact!.sourceUrl, source!.sourceUrl, "the fact must carry the original source_url, not a normalized/derived one");

  const updatedSource = await getSourceByUrl(page.url);
  assert.equal(updatedSource!.reviewStatus, "reviewed", "creating a fact from a pending source must mark it reviewed");
  assert.equal(updatedSource!.reviewedByUserId, adminUserId);
  assert.ok(updatedSource!.reviewedAt);
});

test("a reviewed source can create multiple facts without its review metadata changing again", async () => {
  const page = uniquePage("multi-fact", "DRUID supports multiple independent facts from one page.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);

  const fact1 = await createFactFromSource(source!.id, { category: "product", factText: "Fact one from this source." }, adminUserId);
  const reviewedAtAfterFirst = (await getSourceByUrl(page.url))!.reviewedAt;

  const fact2 = await createFactFromSource(source!.id, { category: "proof_point", factText: "Fact two from the same source." }, adminUserId);

  assert.notEqual(fact1!.id, fact2!.id);
  assert.equal(fact2!.sourceContextId, source!.id);

  const finalSource = await getSourceByUrl(page.url);
  assert.equal(finalSource!.reviewStatus, "reviewed");
  assert.equal(finalSource!.reviewedAt!.getTime(), reviewedAtAfterFirst!.getTime(), "a second fact creation must not re-touch review metadata");
});

test("an invalid category rolls back the entire transaction -- no fact and no source-status change", async () => {
  const page = uniquePage("invalid-category", "Content for an invalid-category attempt.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);
  assert.equal(source!.reviewStatus, "pending_review");

  await assert.rejects(() => createFactFromSource(source!.id, { category: "not_a_real_category", factText: "Should not persist" }, adminUserId));

  const factRows = await db.select().from(druidFactsTable).where(eq(druidFactsTable.sourceContextId, source!.id));
  assert.equal(factRows.length, 0, "no fact may exist after a rolled-back transaction");

  const sourceAfter = await getSourceByUrl(page.url);
  assert.equal(sourceAfter!.reviewStatus, "pending_review", "the source's review status must not change when the fact creation fails");
});

// ---- Trust boundary regression ---------------------------------------------

test("listTrustedDruidFacts still excludes an ingested-but-unverified fact", async () => {
  const page = uniquePage("trust-boundary", "Ingested content that must stay untrusted until explicitly verified.");
  await crawlOnce(page);
  const source = await getSourceByUrl(page.url);

  const fact = await createFactFromSource(source!.id, { category: "other", factText: "Untrusted until verified." }, adminUserId);
  assert.equal(fact!.verificationStatus, "unverified");

  const trusted = await listTrustedDruidFacts();
  assert.ok(!trusted.some((f) => f.id === fact!.id), "an ingested-but-unverified fact must never appear in the trusted read path");
});
