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

// Phase 11.6E: conservative, deterministic garbage removal applied to a
// crawled page's raw text BEFORE boundExtractedText/computeContentHash --
// see refreshDruidContextSources below, the only caller. This is NOT
// summarization and never uses an LLM: it only strips extraction noise
// (SVG path dumps, embedded data-URI blobs, obviously-repeated chrome
// lines) and applies narrow, deterministic whitespace normalization
// (collapsing repeated horizontal whitespace and excess blank lines) that
// Tavily's "text" format sometimes lets through.
//
// This preserves meaningful prose/content -- no semantic extraction, no
// summarization, nothing that could discard real DRUID product/business
// text -- but it is NOT a claim that every input is byte-identical to its
// output. Whitespace/formatting normalization can and does change bytes
// even within otherwise-real content (e.g. a sentence with a stray double
// space is re-flowed to a single space). Only text that happens to contain
// none of the patterns below (no double-spaces, no blank-line runs, no
// consecutive duplicate lines, etc.) round-trips byte-for-byte unchanged
// (verified by tests/druidContextCleanup.test.ts).
//
// Deliberately narrow and pattern-based rather than "smart": every rule
// here only ever removes a whole line (or a self-contained inline blob),
// never rewrites/truncates the middle of a real sentence, and every rule
// is anchored to a pattern real prose essentially cannot match (see each
// step's own comment for why).

// Inline base64/data-URI blobs (e.g. an inlined SVG or image the raw HTML
// converter didn't fully strip) -- these are never meaningful text, and
// the pattern (a data: URI, MIME type, base64 payload) cannot occur inside
// real prose by coincidence.
const DATA_URI_PATTERN = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/gi;

// A line made up ALMOST ENTIRELY of SVG path-command letters (M L C Z Q A
// H V, both cases), digits, and path punctuation (. , - space) is an SVG
// "d" attribute dump, not prose -- real English sentences always contain
// letters far outside that tiny set (e, t, r, n, i, o, ...), so this can
// only false-positive on a pathological line of almost nothing but the
// letters MLCZQAHV, which does not occur in real DRUID product copy.
// Requires a minimum length so a short real fragment (e.g. a lone "A." or
// "Q&A" heading) is never caught by accident.
const SVG_PATH_LINE = /^[MLCZQAHVmlczqahv0-9.,\-\s]{40,}$/;

// A small, explicit, exact-match (after trim/case-fold) blocklist of
// generic site-chrome phrases -- deliberately NOT a fuzzy "contains
// cookie" heuristic, which could wrongly strip a real sentence that
// happens to mention cookies/privacy in a legitimate business context.
// Every entry here is a phrase that is ONLY ever site chrome when it is
// the ENTIRE line, never a substring rule.
const BOILERPLATE_LINE_BLOCKLIST = new Set([
  "accept all cookies",
  "accept cookies",
  "reject all cookies",
  "cookie policy",
  "cookie settings",
  "privacy policy",
  "terms of service",
  "terms and conditions",
  "all rights reserved",
  "skip to content",
  "skip to main content",
]);

function isBoilerplateLine(line: string): boolean {
  const normalized = line.trim().toLowerCase().replace(/[.©]/g, "").trim();
  if (BOILERPLATE_LINE_BLOCKLIST.has(normalized)) return true;
  // "© 2026 DRUID AI. All rights reserved." / "Copyright 2026 DRUID" style
  // copyright lines -- anchored to the start of the line so a real
  // sentence that happens to mention a year is never affected.
  if (/^(©|copyright)\s*\d{4}\b/i.test(line.trim())) return true;
  return false;
}

export function cleanExtractedText(text: string): string {
  if (!text) return text;

  const withoutDataUris = text.replace(DATA_URI_PATTERN, "");

  const rawLines = withoutDataUris.split("\n");
  const keptLines: string[] = [];
  for (const rawLine of rawLines) {
    // Collapse repeated horizontal whitespace within the line only --
    // never touches newlines, so paragraph structure is untouched.
    const line = rawLine.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, "");
    const trimmed = line.trim();

    if (trimmed.length >= 40 && SVG_PATH_LINE.test(trimmed)) continue;
    if (trimmed.length > 0 && isBoilerplateLine(trimmed)) continue;

    // Collapse a line that is an exact repeat of the immediately preceding
    // KEPT non-blank line (e.g. a nav item Tavily's extractor emitted
    // twice back to back) -- only ever removes a consecutive duplicate,
    // never a line that's merely similar, and never a blank line (blank
    // lines are handled separately below so paragraph spacing survives).
    const previousKept = keptLines[keptLines.length - 1];
    if (trimmed.length > 0 && previousKept !== undefined && previousKept.trim() === trimmed) continue;

    keptLines.push(line);
  }

  // Collapse 3+ consecutive blank lines down to a single blank line
  // (one paragraph break) -- never removes a single blank line between
  // two real paragraphs.
  const collapsedBlankRuns = keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return collapsedBlankRuns.trim();
}

// A safety cap on what gets persisted/shown for review -- Tavily's basic
// extract_depth content is already reasonably sized, so this rarely
// actually truncates; it exists to bound worst-case row size and UI
// rendering, same philosophy as discoveryProviders/extraction.ts's
// MAX_TEXT_LENGTH. Operates on the already-cleaned text (see
// refreshDruidContextSources) -- cleanup happens first so truncation never
// cuts off mid-blob-that-should-have-been-removed-anyway.
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
    // Phase 11.6E: deterministic garbage removal runs BEFORE bounding/
    // hashing -- the persisted extractedText and the contentHash/versioning
    // key are both over the cleaned text, never the raw crawl output.
    //
    // Version-transition note: existing druid_context_sources rows are
    // NEVER rewritten by this change (no migration/backfill exists) -- an
    // existing row's content_hash was computed from the OLD, uncleaned
    // text. So on the FIRST refresh after this feature ships, a page whose
    // only real-world change is exactly the kind of noise cleanExtractedText
    // now strips will still (correctly, given the stored comparison target)
    // produce a hash that does NOT match that old raw-text row, and a new
    // pending_review version is created -- this is expected and acceptable,
    // not a defect. From that point on, once a CLEANED version of a page
    // exists in the table, later crawls whose cleaned text is unchanged
    // hash-match THAT version normally and only bump last_seen_at, exactly
    // as the pre-existing versioning logic (untouched here) already did.
    const boundedText = boundExtractedText(cleanExtractedText(page.text));
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
