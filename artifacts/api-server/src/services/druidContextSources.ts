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

// Phase 11.6.1: cross-page site-chrome removal, validated against a real
// captured 17-page druidai.com Tavily /crawl response (~107K chars raw;
// see the task report for the full corpus inspection -- the capture
// itself is local-only, gitignored, and never committed). This is the one
// stage in the pipeline with visibility across the WHOLE crawled batch,
// which cross-page repetition requires -- cleanExtractedText below runs
// per-page and structurally cannot see this signal. See
// refreshDruidContextSources for exactly where this runs (before any
// per-page cleaning/bounding/hashing).
//
// TWO deterministic signals, combined (see the task report for the full
// evidence trail behind each refinement):
//
//   (A) High-confidence SINGLE-LINE chrome (computeSingleLineChromeSet):
//       a line repeated on >=5 distinct pages, with >=3 words, that isn't
//       a quoted statement or a quantified proof point (same protection as
//       signal B's block guard below -- a stat line reaching the
//       page-count floor on its own must never be removed just because it
//       didn't happen to repeat as part of a detected block). The
//       word-count floor is a real-corpus-driven
//       refinement: at pageCount>=5 alone, genuinely ambiguous bare
//       business/product/category terms -- "Druid Agent" (2 words),
//       "Healthcare", "Insurance" (1 word each) -- were being removed
//       solely because they repeat, with no other evidence they're chrome
//       (they read as UI/filter-widget labels, but that's a *guess*, not
//       proof). A >=3-word floor is not a revival of the explicitly
//       rejected "short consecutive line run" heuristic (that heuristic
//       had NO cross-page corroboration at all, and wrongly stripped a
//       real single-page capability list); here it only narrows an
//       ALREADY cross-page-proven candidate set, protecting short bare
//       terms from single-line removal unless corroborated by signal (B)
//       below. The accepted cost: "0%" (a bare client-rendered stat-widget
//       placeholder) and "BLOG" (a nav label) also survive as single
//       lines now -- an accepted, disclosed trade favoring never deleting
//       real content over catching every noise instance.
//
//   (B) Repeated MULTI-LINE BLOCK removal (computeCrossPageBlockKeys): a
//       contiguous run of >=3 non-empty normalized lines, identical on
//       >=2 distinct pages, is structural evidence of a shared widget/
//       card/section (nav clusters, footer/certification-badge/social-
//       link clusters, "Featured Resources" resource cards, BLOG
//       article-card teasers, and -- once corroborated by an identical
//       3-line demo-dialogue block on >=2 pages, not just a lone repeated
//       line -- a reused interactive demo-widget transcript). This is
//       what actually reaches "Featured Resources" (only 2 pages) and
//       "BLOG" (protected from removal as a lone word by (A), but
//       legitimately removed here as part of its repeated article-card
//       block) without needing a lower, unsafe single-line threshold.
//       Every block containing a quoted line OR a quantified proof-point
//       (a percentage or dollar figure) is excluded outright, regardless
//       of page count -- real customer testimonials and stats in the
//       corpus repeat as part of a "social proof" block shape exactly
//       like genuine chrome blocks do, and must never be caught by
//       association.
//
// CRITICAL real-corpus finding behind dedupePagesForFrequencyAnalysis
// below: the capture contains "https://druidai.com/" and
// "https://www.druidai.com/" as two separate crawled entries for what is
// the SAME logical home page (normalizeUrl already collapses them to one
// persistence key). Counting both as independent "pages" wrongly inflated
// a genuine, unique, substantive product paragraph (a multi-sentence
// description of "The Druid Conductor") to "repeated on 2 pages" -- pure
// crawl-duplication noise, not real cross-page repetition. Frequency
// analysis (both signals A and B) is computed over a deduplicated
// reference set (one text per normalizedUrl, preferring the longer/fuller
// crawled text as a general, content-based tiebreak); the resulting
// chrome-line/block sets are then applied to every raw crawled page
// (duplicates included), so no page goes uncleaned.
export interface CrossPageLineFrequency {
  line: string;
  pageCount: number;
}

/** Pure, deterministic -- exported separately so its exact behavior is independently testable/auditable. */
export function computeCrossPageLineFrequencies(pagesText: readonly string[]): CrossPageLineFrequency[] {
  const pageCountByLine = new Map<string, number>();
  for (const pageText of pagesText) {
    // A line can appear multiple times WITHIN one page -- only count it
    // once per page here, so a single noisy page can never inflate the
    // cross-page count on its own.
    const linesOnThisPage = new Set(
      pageText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
    for (const line of linesOnThisPage) {
      pageCountByLine.set(line, (pageCountByLine.get(line) ?? 0) + 1);
    }
  }
  return [...pageCountByLine.entries()].map(([line, pageCount]) => ({ line, pageCount }));
}

// A line entirely wrapped in matching quotation marks (straight " or
// curly " ") is an attributed statement (a customer testimonial, a quoted
// claim) -- real evidence from the captured corpus shows exactly this
// shape being reused verbatim across several pages as a shared
// quote-carousel widget. Never removed (as a single line OR as part of a
// block), regardless of repeat count. General structural signal, not a
// druidai.com-specific rule.
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "“": "”" };

export function isQuotedLine(line: string): boolean {
  if (line.length < 2) return false;
  const first = line[0]!;
  const last = line[line.length - 1]!;
  return QUOTE_PAIRS[first] === last;
}

// A general, purely structural signal (digits + "%" or "$" + digit) --
// never semantic/fuzzy. Real-corpus evidence: quantified proof points
// ("96% accuracy of answers delivered by AI agents", "$2.4M in additional
// enrollment revenue") repeat as part of the same "social proof" block
// shape as genuine chrome and must never be caught by association with a
// nearby quote or company name. Any line matching this, and any BLOCK
// containing such a line, is excluded from removal outright.
const QUANTIFIED_STAT_PATTERN = /\d+%|\$\d/;

export function containsQuantifiedStat(line: string): boolean {
  return QUANTIFIED_STAT_PATTERN.test(line);
}

const CROSS_PAGE_CHROME_MIN_PAGE_OCCURRENCES = 5;
const CROSS_PAGE_CHROME_MIN_WORD_COUNT = 3;

function wordCount(line: string): number {
  return line.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * High-confidence single-line chrome (signal A above): repeated on
 * >=minPageOccurrences distinct pages, at least minWordCount words, never
 * a quoted statement, never a quantified proof point (same protection the
 * block signal below applies -- a stat line reaching the page-count floor
 * on its own must be protected exactly like one embedded in a block; see
 * this file's cross-page-chrome comment for the real-corpus testimonial/
 * proof-point evidence behind both guards). Returns the SET of exact line
 * strings to remove -- pure and deterministic, exported separately for
 * independent testing.
 */
export function computeSingleLineChromeSet(
  pagesText: readonly string[],
  minPageOccurrences = CROSS_PAGE_CHROME_MIN_PAGE_OCCURRENCES,
  minWordCount = CROSS_PAGE_CHROME_MIN_WORD_COUNT,
): Set<string> {
  const frequencies = computeCrossPageLineFrequencies(pagesText);
  return new Set(
    frequencies
      .filter(
        (f) =>
          f.pageCount >= minPageOccurrences &&
          wordCount(f.line) >= minWordCount &&
          !isQuotedLine(f.line) &&
          !containsQuantifiedStat(f.line),
      )
      .map((f) => f.line),
  );
}

const CROSS_PAGE_BLOCK_WINDOW_SIZE = 3;
const CROSS_PAGE_BLOCK_MIN_PAGE_OCCURRENCES = 2;
// Separator joining a block's lines into one map key -- lines are always
// individually trimmed and never contain a raw newline themselves (they
// were produced by splitting on "\n"), so this can never collide with real
// line content.
const BLOCK_KEY_SEPARATOR = "\n";

function nonEmptyLineRecords(pageText: string): Array<{ originalIndex: number; text: string }> {
  const lines = pageText.split("\n");
  const records: Array<{ originalIndex: number; text: string }> = [];
  lines.forEach((rawLine, originalIndex) => {
    const trimmed = rawLine.trim();
    if (trimmed.length > 0) records.push({ originalIndex, text: trimmed });
  });
  return records;
}

/**
 * Repeated multi-line block detection (signal B above): a contiguous run
 * of `windowSize` non-empty normalized lines, identical on
 * >=minBlockPageOccurrences distinct pages. Any block containing a quoted
 * line or a quantified stat is excluded outright. Returns the SET of
 * qualifying block keys (each line joined by BLOCK_KEY_SEPARATOR) -- pure
 * and deterministic, exported separately for independent testing.
 */
export function computeCrossPageBlockKeys(
  pagesText: readonly string[],
  windowSize = CROSS_PAGE_BLOCK_WINDOW_SIZE,
  minBlockPageOccurrences = CROSS_PAGE_BLOCK_MIN_PAGE_OCCURRENCES,
): Set<string> {
  const blockKeyToPages = new Map<string, Set<number>>();
  pagesText.forEach((pageText, pageIndex) => {
    const records = nonEmptyLineRecords(pageText);
    // Dedupe within-page occurrences of the same block, same rationale as
    // computeCrossPageLineFrequencies -- one noisy page can't inflate a
    // block's cross-page count on its own.
    const blockKeysOnThisPage = new Set<string>();
    for (let start = 0; start + windowSize <= records.length; start++) {
      const key = records
        .slice(start, start + windowSize)
        .map((r) => r.text)
        .join(BLOCK_KEY_SEPARATOR);
      blockKeysOnThisPage.add(key);
    }
    for (const key of blockKeysOnThisPage) {
      if (!blockKeyToPages.has(key)) blockKeyToPages.set(key, new Set());
      blockKeyToPages.get(key)!.add(pageIndex);
    }
  });

  const qualifying = new Set<string>();
  for (const [key, pageSet] of blockKeyToPages.entries()) {
    if (pageSet.size < minBlockPageOccurrences) continue;
    const lines = key.split(BLOCK_KEY_SEPARATOR);
    if (lines.some((l) => isQuotedLine(l) || containsQuantifiedStat(l))) continue;
    qualifying.add(key);
  }
  return qualifying;
}

/**
 * Collapses a crawled page batch to one text per normalizedUrl (reusing
 * the same normalizeUrl already used for persistence -- see its own
 * comment) for FREQUENCY-ANALYSIS PURPOSES ONLY, preferring the longer
 * (fuller) crawled text as a general, content-based tiebreak when the same
 * URL was crawled twice under different hostname/path variants. See this
 * file's cross-page-chrome-removal comment above for the real-corpus
 * finding this fixes (a duplicate www/non-www home-page crawl entry
 * inflating a genuine single-page product paragraph into a false
 * "repeated on 2 pages" chrome candidate). Every ORIGINAL crawled page
 * still gets cleaned (see pruneCrossPageChrome below) -- only the
 * evidence used to decide WHAT counts as chrome is deduplicated.
 */
export function dedupePagesForFrequencyAnalysis(pages: readonly { url: string; text: string }[]): string[] {
  const byNormalizedUrl = new Map<string, string>();
  for (const page of pages) {
    const key = normalizeUrl(page.url);
    const existing = byNormalizedUrl.get(key);
    if (existing === undefined || page.text.length > existing.length) {
      byNormalizedUrl.set(key, page.text);
    }
  }
  return [...byNormalizedUrl.values()];
}

/** Applies a precomputed chrome-line set and block-key set to one page's text -- pure, deterministic. */
export function applyCrossPageChromeToPage(pageText: string, chromeLines: ReadonlySet<string>, qualifyingBlockKeys: ReadonlySet<string>): string {
  const records = nonEmptyLineRecords(pageText);
  const removeOriginalIndices = new Set<number>();
  for (let start = 0; start + CROSS_PAGE_BLOCK_WINDOW_SIZE <= records.length; start++) {
    const window = records.slice(start, start + CROSS_PAGE_BLOCK_WINDOW_SIZE);
    const key = window.map((r) => r.text).join(BLOCK_KEY_SEPARATOR);
    if (qualifyingBlockKeys.has(key)) {
      for (const r of window) removeOriginalIndices.add(r.originalIndex);
    }
  }

  const lines = pageText.split("\n");
  return lines
    .filter((rawLine, idx) => {
      if (removeOriginalIndices.has(idx)) return false; // removed as part of a repeated block
      return !chromeLines.has(rawLine.trim()); // or removed as a high-confidence single line
    })
    .join("\n");
}

/**
 * Top-level orchestration: computes both chrome signals from a
 * deduplicated reference view of the batch, then applies them to every
 * raw crawled page. This is the one function refreshDruidContextSources
 * calls -- pure and deterministic given the same input, independent of
 * page order (see the regression suite for the order-independence proof).
 */
export function pruneCrossPageChrome(pages: readonly { url: string; text: string }[]): string[] {
  const referenceTexts = dedupePagesForFrequencyAnalysis(pages);
  const chromeLines = computeSingleLineChromeSet(referenceTexts);
  const qualifyingBlockKeys = computeCrossPageBlockKeys(referenceTexts);
  return pages.map((p) => applyCrossPageChromeToPage(p.text, chromeLines, qualifyingBlockKeys));
}

// A line that is JUST a bare filename with an image/font extension (e.g.
// "logo.svg") is never meaningful prose -- narrower and different from the
// SVG-path-command dump regex below (SVG_PATH_LINE), which catches raw
// path-command characters, not a filename.
//
// The second pattern (TRUNCATED_MARKDOWN_IMAGE_REF_LINE) is a real-corpus
// finding: the captured crawl contains 48 occurrences of the bare
// fragment ".svg)" across 2 pages -- the tail end of a markdown image
// reference (`![alt](...logo.svg)`) whose leading `![alt](...` portion was
// dropped by Tavily's plain-text extraction, leaving only the closing
// `.svg)` behind. This is a general structural shape (a truncated
// markdown image-reference remnant), not a druidai.com-specific string --
// anchored to start with a literal "." and end with ")", so it can never
// match real prose (e.g. "Register for Orientation (Aug 19-20)" does not
// start with a dot and is untouched).
const BARE_ASSET_FILENAME_LINE = /^[\w-]+\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf)$/i;
const TRUNCATED_MARKDOWN_IMAGE_REF_LINE = /^\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf)\)$/i;

export function pruneAssetNoiseLines(pageText: string): string {
  return pageText
    .split("\n")
    .filter((rawLine) => {
      const trimmed = rawLine.trim();
      return !(BARE_ASSET_FILENAME_LINE.test(trimmed) || TRUNCATED_MARKDOWN_IMAGE_REF_LINE.test(trimmed));
    })
    .join("\n");
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

  // Phase 11.6.1: cross-page chrome removal runs ONCE, over the full
  // crawled batch, BEFORE any per-page cleaning/bounding/hashing -- this
  // is the only point in the pipeline with visibility across pages, which
  // both cross-page signals (repeated single lines, repeated multi-line
  // blocks) require (see pruneCrossPageChrome's own comment for the full
  // real-corpus evidence behind this rule). Order within `pages` never
  // affects the outcome -- both signals are order-independent -- so each
  // page's own persistence below still depends on nothing but its own
  // content.
  const crossPageCleanedTexts = pruneCrossPageChrome(pages);

  let newSources = 0;
  let updatedSources = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const normalizedUrl = normalizeUrl(page.url);
    // Phase 11.6E/11.6.1: deterministic garbage removal runs BEFORE
    // bounding/hashing -- the persisted extractedText and the
    // contentHash/versioning key are both over the cleaned text, never the
    // raw crawl output. Per-page asset-noise pruning runs first (it needs
    // no batch context), then the existing per-page cleanExtractedText.
    //
    // Version-transition note: existing druid_context_sources rows are
    // NEVER rewritten by this change (no migration/backfill exists) -- an
    // existing row's content_hash was computed from the OLD, less-cleaned
    // text. So on the FIRST refresh after this feature ships, a page whose
    // only real-world change is exactly the kind of noise this cleanup now
    // strips will still (correctly, given the stored comparison target)
    // produce a hash that does NOT match that old row, and a new
    // pending_review version is created -- this is expected and
    // acceptable, not a defect (identical to the Phase 11.6E transition
    // note this one extends). From that point on, once a CLEANED version
    // of a page exists in the table, later crawls whose cleaned text is
    // unchanged hash-match THAT version normally and only bump
    // last_seen_at, exactly as the pre-existing versioning logic
    // (untouched here) already did.
    const boundedText = boundExtractedText(cleanExtractedText(pruneAssetNoiseLines(crossPageCleanedTexts[i]!)));
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
