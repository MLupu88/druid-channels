import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { druidContextSourcesTable, type DruidContextSource, type DruidFact } from "@workspace/db";
import { eq, and, ne, desc, sql } from "drizzle-orm";
import * as ingestionProvider from "./druidContextIngestionProvider";
import { createIngestedDruidFact } from "./druidFacts";

// Phase 11.5C.2: dedup/versioning, refresh orchestration, source review
// lifecycle, and transactional fact creation from a source. Deliberately
// its own file, not merged into druidFacts.ts -- source material and
// canonical facts are separate concepts with separate lifecycles (see
// druid_context_sources.ts's schema comment). No network calls happen
// here; all Tavily access is delegated to druidContextIngestionProvider.ts.

export class DruidContextSourceIgnoredError extends Error {
  constructor() {
    super("Cannot create a fact from an ignored source version.");
    this.name = "DruidContextSourceIgnoredError";
  }
}

// Both markSourceReviewed and markSourceIgnored are only valid from
// pending_review -- reviewed/ignored are terminal (same "no generic state
// machine, just the two valid edges" philosophy as
// channelRadarEngine.ts's isValidStatusTransition).
export class DruidContextSourceInvalidTransitionError extends Error {
  constructor(from: string) {
    super(`Cannot change review status from "${from}" -- only a pending_review source can be marked reviewed or ignored.`);
    this.name = "DruidContextSourceInvalidTransitionError";
  }
}

// Deliberately NOT reusing/exporting anything from
// discoveryEngine.ts/companyIdentity.ts's domain helpers (per the approved
// design: a fixed single ingestion target deserves its own tiny local
// guard, not a dependency on a Discovery-scoped module). Mirrors, but does
// not share code with, druidContextIngestionProvider.ts's isDruidDomainUrl
// (that one gates which crawled URLs are even considered; this one is the
// deterministic key-normalization step for already-accepted URLs).
const TRACKING_PARAM_PREFIX = /^utm_/i;
const TRACKING_PARAM_EXACT = new Set(["gclid", "fbclid"]);

/**
 * Deterministic matching key for dedup/versioning -- never displayed (see
 * druid_context_sources.ts's schema comment). Lowercases the hostname,
 * strips a leading "www.", drops the fragment (URL parsing already does
 * this), normalizes a trailing slash, strips common tracking parameters,
 * and keeps any remaining query parameters sorted so parameter order never
 * creates a spurious new "version" of the same page.
 */
export function normalizeUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl.trim().toLowerCase();
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  if (pathname === "") pathname = "/";

  const keptParams: string[] = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (TRACKING_PARAM_PREFIX.test(lowerKey) || TRACKING_PARAM_EXACT.has(lowerKey)) continue;
    keptParams.push(`${lowerKey}=${value}`);
  }
  keptParams.sort();
  const query = keptParams.length > 0 ? `?${keptParams.join("&")}` : "";

  return `${hostname}${pathname}${query}`;
}

// A safety cap on what gets persisted/shown for review -- Tavily's basic
// extract_depth content is already reasonably sized, so this rarely
// actually truncates; it exists to bound worst-case row size and UI
// rendering, same philosophy as discoveryProviders/extraction.ts's
// MAX_TEXT_LENGTH.
const MAX_EXTRACTED_TEXT_LENGTH = 8_000;

export function boundExtractedText(text: string): string {
  return text.slice(0, MAX_EXTRACTED_TEXT_LENGTH);
}

/** SHA-256 hex digest over the FINAL, already-bounded text -- never the raw provider response. */
export function computeContentHash(boundedText: string): string {
  return createHash("sha256").update(boundedText).digest("hex");
}

export interface RefreshSummary {
  pagesCrawled: number;
  newSources: number;
  updatedSources: number;
}

/**
 * Crawls druidai.com (via the provider layer) and persists each page as a
 * source version: an unchanged (normalizedUrl, contentHash) pair only bumps
 * lastSeenAt; a new or changed one inserts a new pending_review row,
 * leaving any prior version of that URL untouched. A single page's
 * persistence never depends on another's -- one bad row can't corrupt the
 * rest of the batch.
 *
 * crawlFn is injectable (defaults to the real provider's crawl()) so tests
 * can supply canned pages without a live Tavily credential or network call
 * -- same convention as discoveryEngine.ts's resolveCandidateCompanyIdentity
 * accepting an injectable resolveIdentity.
 */
export async function refreshDruidContextSources(
  crawlFn: () => Promise<ingestionProvider.CrawledPage[]> = ingestionProvider.crawl,
): Promise<RefreshSummary> {
  const pages = await crawlFn();

  let newSources = 0;
  let updatedSources = 0;

  for (const page of pages) {
    const normalizedUrl = normalizeUrl(page.url);
    const boundedText = boundExtractedText(page.text);
    const contentHash = computeContentHash(boundedText);

    const [existing] = await db
      .select({ id: druidContextSourcesTable.id })
      .from(druidContextSourcesTable)
      .where(and(eq(druidContextSourcesTable.normalizedUrl, normalizedUrl), eq(druidContextSourcesTable.contentHash, contentHash)));

    if (existing) {
      await db.update(druidContextSourcesTable).set({ lastSeenAt: new Date() }).where(eq(druidContextSourcesTable.id, existing.id));
      updatedSources++;
    } else {
      await db.insert(druidContextSourcesTable).values({
        sourceUrl: page.url,
        normalizedUrl,
        contentHash,
        extractedText: boundedText,
        reviewStatus: "pending_review",
      });
      newSources++;
    }
  }

  return { pagesCrawled: pages.length, newSources, updatedSources };
}

/**
 * Admin management view: every non-ignored source, pending_review first
 * (then reviewed), most recently extracted first within each group.
 * "ignored" is deliberately excluded -- there is no restore/undo affordance
 * for it in this slice (see the schema comment: a changed future version of
 * the same URL gets its own new pending_review row regardless).
 */
export async function listDruidContextSources(): Promise<DruidContextSource[]> {
  return db
    .select()
    .from(druidContextSourcesTable)
    .where(ne(druidContextSourcesTable.reviewStatus, "ignored"))
    .orderBy(
      sql`case ${druidContextSourcesTable.reviewStatus} when 'pending_review' then 0 else 1 end`,
      desc(druidContextSourcesTable.extractedAt),
    );
}

export async function getDruidContextSourceById(id: string): Promise<DruidContextSource | null> {
  const [row] = await db.select().from(druidContextSourcesTable).where(eq(druidContextSourcesTable.id, id));
  return row ?? null;
}

async function transitionReviewStatus(
  id: string,
  to: "reviewed" | "ignored",
  actingUserId: string,
): Promise<DruidContextSource | null> {
  const existing = await getDruidContextSourceById(id);
  if (!existing) return null;
  if (existing.reviewStatus !== "pending_review") {
    throw new DruidContextSourceInvalidTransitionError(existing.reviewStatus);
  }

  const [updated] = await db
    .update(druidContextSourcesTable)
    .set({ reviewStatus: to, reviewedByUserId: actingUserId, reviewedAt: new Date() })
    .where(eq(druidContextSourcesTable.id, id))
    .returning();
  return updated ?? null;
}

/** Explicit action for when an admin reviews a source but creates no fact from it. */
export async function markSourceReviewed(id: string, actingUserId: string): Promise<DruidContextSource | null> {
  return transitionReviewStatus(id, "reviewed", actingUserId);
}

/** This content VERSION is intentionally excluded from use -- see the schema comment. */
export async function markSourceIgnored(id: string, actingUserId: string): Promise<DruidContextSource | null> {
  return transitionReviewStatus(id, "ignored", actingUserId);
}

export interface CreateFactFromSourceInput {
  category: string;
  factText: string;
  sourceNote?: string | null;
}

/**
 * The one transactional entry point for turning reviewed source material
 * into a fact. Loads the source inside the transaction, rejects an ignored
 * source outright (DruidContextSourceIgnoredError), creates the fact via
 * druidFacts.ts's createIngestedDruidFact (always unverified -- see that
 * function's own comment), and -- only if the source was still
 * pending_review -- marks it reviewed in the same transaction. A
 * *reviewed* source can have any number of additional facts created from
 * it afterward without its review metadata changing again ("Mark reviewed"
 * is not re-triggered by a second/third fact). Any failure (e.g. an
 * invalid category) rolls back both the fact insert and the source-status
 * update together -- never a fact with no valid source link, never a
 * source marked reviewed with nothing created.
 */
export async function createFactFromSource(
  sourceId: string,
  input: CreateFactFromSourceInput,
  actingUserId: string,
): Promise<DruidFact | null> {
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(druidContextSourcesTable).where(eq(druidContextSourcesTable.id, sourceId));
    if (!source) return null;
    if (source.reviewStatus === "ignored") throw new DruidContextSourceIgnoredError();

    const fact = await createIngestedDruidFact(
      {
        category: input.category,
        factText: input.factText,
        sourceUrl: source.sourceUrl,
        sourceContextId: source.id,
        sourceNote: input.sourceNote ?? null,
      },
      actingUserId,
      tx,
    );

    if (source.reviewStatus === "pending_review") {
      await tx
        .update(druidContextSourcesTable)
        .set({ reviewStatus: "reviewed", reviewedByUserId: actingUserId, reviewedAt: new Date() })
        .where(eq(druidContextSourcesTable.id, sourceId));
    }

    return fact;
  });
}
