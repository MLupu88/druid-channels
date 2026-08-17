// Phase 11.6.1 (final refinement pass): pure, DB-free regression tests for
// druidContextSources.ts's cross-page site-chrome cleanup
// (pruneCrossPageChrome and its constituent pure functions) -- the
// deterministic, batch-aware cleanup stage that runs BEFORE the existing
// per-page cleanExtractedText (see refreshDruidContextSources). No
// network, no DB, no LLM. Run with:
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder tsx --test tests/druidContextCrossPageCleanup.test.ts
//
// EVIDENCE BASIS: this rule (single-line >=5 pages + >=3 words, multi-line
// blocks >=3 lines on >=2 pages, quote/stat exclusion, normalizedUrl
// deduplication for frequency analysis) was derived and validated against
// a REAL captured 17-page druidai.com Tavily /crawl response (local-only,
// gitignored, never committed -- see artifacts/api-server/.local-captures/
// and the task report for the full corpus inspection, including the
// discovery that the single-line->=5-pages-only rule was ALSO removing
// genuinely ambiguous bare terms -- "Druid Agent", "Healthcare",
// "Insurance" -- and that the raw crawl contained a duplicate www/non-www
// home-page entry that inflated a real, unique product paragraph into a
// false "repeated on 2 pages" chrome candidate). The short fixture strings
// below are taken directly from that real corpus -- kept minimal, never
// the full captured pages, never citing the raw capture file itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeCrossPageLineFrequencies,
  computeSingleLineChromeSet,
  computeCrossPageBlockKeys,
  dedupePagesForFrequencyAnalysis,
  applyCrossPageChromeToPage,
  pruneCrossPageChrome,
  isQuotedLine,
  containsQuantifiedStat,
  pruneAssetNoiseLines,
} from "../src/services/druidContextSources";

// ---- Fixtures built from real corpus-observed strings (minimal, labeled) ---

const REAL_NAV_CHROME_LINE = "Skip to content"; // real: 15 of 17 pages
const REAL_CTA_CHROME_LINES = ["Talk to an expert", "Request a demo", "Read Customer Story"];
const REAL_TESTIMONIAL_QUOTE = '"Platform is intuitive and powerful, allowing us to build and deploy conversational AI solutions quickly."';
const REAL_TESTIMONIAL_QUOTE_CURLY = "“With Druid AI we’ve not only improved response times but also increased efficiency.”";
// Real, exact quantified proof-point lines from the captured corpus.
const REAL_PROOF_POINTS = ["96% accuracy of answers delivered by AI agents", "$2.4M in additional enrollment revenue"];
// Real bare business/product/category terms the ORIGINAL (pre-refinement)
// single-line-only rule wrongly removed at pageCount>=5.
const REAL_AMBIGUOUS_BARE_TERMS = ["Druid Agent", "Healthcare", "Insurance"];
// Real page-specific business prose (each appears on exactly one real page).
const UNIQUE_PAGE_BODIES = [
  "AI Adoption in Healthcare Benchmark: What 15 months of production data actually reveals",
  "The Druid Banking AI Agent course is designed to help you create AI agents that guide users through real financial workflows.",
  "Discover how global companies are leveraging Druid AI agents to accelerate operations, enhance customer experiences, and unlock business value.",
  "AI agents that build trust at every touchpoint",
  "Voice accounts for 54% of engaged Healthcare CX interactions, and chat accounts for 46%.",
];
// The real "Featured Resources" shared-card block (druidai.com's home and
// academy pages, verbatim, minimal excerpt).
const REAL_FEATURED_RESOURCES_BLOCK = ["Featured Resources", "2026 Gartner® Magic Quadrant™ for Conversational AI Platforms", "For customer experience"];

function buildFivePages(chromeLine: string, uniqueSuffix: string): string[] {
  return UNIQUE_PAGE_BODIES.map((body, i) => [chromeLine, `${body} (${uniqueSuffix} ${i})`].join("\n"));
}
function asPages(texts: string[], urlPrefix = "https://example.com/page"): { url: string; text: string }[] {
  return texts.map((text, i) => ({ url: `${urlPrefix}-${i}`, text }));
}

// ---- 1. Repeated global nav/CTA chrome removed (single-line signal) -------

test("pruneCrossPageChrome: 'Skip to content' (real 15/17-page corpus line) is removed, unique page body survives", () => {
  const texts = buildFivePages(REAL_NAV_CHROME_LINE, "nav-case");
  const cleaned = pruneCrossPageChrome(asPages(texts));
  for (let i = 0; i < cleaned.length; i++) {
    assert.ok(!cleaned[i]!.includes(REAL_NAV_CHROME_LINE), `expected chrome removed from page ${i}`);
    assert.ok(cleaned[i]!.includes(UNIQUE_PAGE_BODIES[i]!), `expected unique body retained on page ${i}`);
  }
});

test("pruneCrossPageChrome: real repeated CTA labels are removed when repeated on >=5 pages with >=3 words each", () => {
  for (const cta of REAL_CTA_CHROME_LINES) {
    const cleaned = pruneCrossPageChrome(asPages(buildFivePages(cta, "cta-case")));
    assert.ok(cleaned.every((p) => !p.includes(cta)), `expected "${cta}" removed`);
  }
});

// ---- 2. Ambiguous bare terms now protected (the core fix this turn) -------

test("pruneCrossPageChrome: 'Druid Agent' / 'Healthcare' / 'Insurance' survive even when repeated on >=5 pages -- a bare 1-2 word term is no longer removed on frequency alone", () => {
  for (const term of REAL_AMBIGUOUS_BARE_TERMS) {
    const cleaned = pruneCrossPageChrome(asPages(buildFivePages(term, "bare-term-case")));
    assert.ok(cleaned.every((p) => p.includes(term)), `expected "${term}" to survive, word count = ${term.split(/\s+/).length}`);
  }
});

test("computeSingleLineChromeSet: word-count floor excludes bare 1-2 word terms even when EACH independently repeats on >=5 pages, while a multi-word CTA phrase at the same page count still qualifies", () => {
  // Six pages: every bare term AND the CTA phrase each appear on all 6 --
  // same page-count evidence strength for both, only word count differs.
  const pages = Array.from({ length: 6 }, (_, i) =>
    [...REAL_AMBIGUOUS_BARE_TERMS, "Talk to an expert", `Unique body ${i}.`].join("\n"),
  );
  const chromeSet = computeSingleLineChromeSet(pages);
  for (const term of REAL_AMBIGUOUS_BARE_TERMS) {
    assert.ok(!chromeSet.has(term), `expected "${term}" (pageCount=6) to be excluded by the word-count floor`);
  }
  assert.ok(chromeSet.has("Talk to an expert"), "expected the multi-word CTA phrase at the same page count to still qualify");
});

// ---- 3. Quoted testimonials and quantified proof points survive -----------

test("pruneCrossPageChrome: real testimonial quotes (straight and curly) NEVER removed, even repeated on >=5 pages exactly like chrome", () => {
  for (const quote of [REAL_TESTIMONIAL_QUOTE, REAL_TESTIMONIAL_QUOTE_CURLY]) {
    const cleaned = pruneCrossPageChrome(asPages(buildFivePages(quote, "quote-case")));
    assert.ok(cleaned.every((p) => p.includes(quote)), `expected quote to survive: ${quote}`);
  }
});

test("pruneCrossPageChrome: real quantified proof points (percentages, dollar figures) NEVER removed, even repeated on >=5 pages", () => {
  for (const stat of REAL_PROOF_POINTS) {
    const cleaned = pruneCrossPageChrome(asPages(buildFivePages(stat, "stat-case")));
    assert.ok(cleaned.every((p) => p.includes(stat)), `expected proof point to survive: ${stat}`);
  }
});

test("isQuotedLine / containsQuantifiedStat: recognize the real corpus's exact shapes", () => {
  assert.ok(isQuotedLine(REAL_TESTIMONIAL_QUOTE));
  assert.ok(isQuotedLine(REAL_TESTIMONIAL_QUOTE_CURLY));
  assert.ok(!isQuotedLine("Not a quoted line."));
  assert.ok(containsQuantifiedStat("96% accuracy of answers delivered by AI agents"));
  assert.ok(containsQuantifiedStat("$2.4M in additional enrollment revenue"));
  assert.ok(!containsQuantifiedStat("Healthcare"));
});

// ---- 4. Multi-line block removal: Featured Resources / shared cards -------

test("computeCrossPageBlockKeys + applyCrossPageChromeToPage: the real 'Featured Resources' shared-card block (>=3 lines, >=2 real pages) is detected and removed", () => {
  const pageA = [REAL_FEATURED_RESOURCES_BLOCK.join("\n"), "Unique body A."].join("\n");
  const pageB = [REAL_FEATURED_RESOURCES_BLOCK.join("\n"), "Unique body B."].join("\n");
  const blockKeys = computeCrossPageBlockKeys([pageA, pageB]);
  assert.ok(blockKeys.size > 0, "expected at least one qualifying block");
  const cleanedA = applyCrossPageChromeToPage(pageA, new Set(), blockKeys);
  const cleanedB = applyCrossPageChromeToPage(pageB, new Set(), blockKeys);
  for (const line of REAL_FEATURED_RESOURCES_BLOCK) {
    assert.ok(!cleanedA.includes(line), `expected "${line}" removed from page A`);
    assert.ok(!cleanedB.includes(line), `expected "${line}" removed from page B`);
  }
  assert.ok(cleanedA.includes("Unique body A."));
  assert.ok(cleanedB.includes("Unique body B."));
});

test("pruneCrossPageChrome: end-to-end, the Featured Resources block is removed via the full pipeline (not just the isolated block function)", () => {
  const pages = asPages(
    [REAL_FEATURED_RESOURCES_BLOCK.join("\n") + "\nUnique A.", REAL_FEATURED_RESOURCES_BLOCK.join("\n") + "\nUnique B."],
  );
  const cleaned = pruneCrossPageChrome(pages);
  for (const line of REAL_FEATURED_RESOURCES_BLOCK) assert.ok(cleaned.every((p) => !p.includes(line)));
  assert.ok(cleaned[0]!.includes("Unique A."));
  assert.ok(cleaned[1]!.includes("Unique B."));
});

test("a block containing a quoted testimonial line is excluded from block removal entirely, even though it repeats on >=2 pages", () => {
  const block = ["Case Study Testimonial", REAL_TESTIMONIAL_QUOTE, "Read Customer Story"];
  const pageA = block.join("\n");
  const pageB = block.join("\n");
  const blockKeys = computeCrossPageBlockKeys([pageA, pageB]);
  assert.equal(blockKeys.size, 0, "a block containing a quoted line must never qualify for removal");
});

test("a block containing a quantified proof point is excluded from block removal entirely, even though it repeats on >=2 pages", () => {
  const block = ["Case Study Stat", "96% accuracy of answers delivered by AI agents", "MatrixCare"];
  const pageA = block.join("\n");
  const pageB = block.join("\n");
  const blockKeys = computeCrossPageBlockKeys([pageA, pageB]);
  assert.equal(blockKeys.size, 0, "a block containing a quantified stat must never qualify for removal");
});

// ---- 5. The www/non-www crawl-duplication fix (real-corpus root cause) ----

test("dedupePagesForFrequencyAnalysis: two crawled entries for the SAME normalizedUrl (e.g. www vs non-www) collapse to one page for frequency purposes -- reproduces and fixes the real 'Druid Conductor' false positive", () => {
  const productParagraph = "The Druid Conductor orchestrates pre-built AI agents, agentic AI workflows, and your existing systems, so teams work more efficiently.";
  const pages = [
    { url: "https://example.com/", text: productParagraph },
    { url: "https://www.example.com/", text: productParagraph }, // same normalizedUrl, crawled twice
  ];
  const deduped = dedupePagesForFrequencyAnalysis(pages);
  assert.equal(deduped.length, 1, "the duplicate normalizedUrl entry must collapse to one reference page");
});

test("pruneCrossPageChrome: a unique product paragraph that only appears (once) under a duplicate www/non-www URL pair is NEVER treated as cross-page chrome", () => {
  const productParagraph = "The Druid Conductor orchestrates pre-built AI agents, agentic AI workflows, and your existing systems, so teams work more efficiently.";
  const pages = [
    { url: "https://example.com/", text: `Unique header.\n${productParagraph}\nAnother unique line.` },
    { url: "https://www.example.com/", text: `Unique header.\n${productParagraph}\nAnother unique line.` },
  ];
  const cleaned = pruneCrossPageChrome(pages);
  for (const p of cleaned) assert.ok(p.includes(productParagraph), "the real product paragraph must survive, not be treated as 2-page chrome");
});

test("dedupePagesForFrequencyAnalysis: prefers the LONGER text per normalizedUrl (a general, content-based tiebreak, not a URL-string rule)", () => {
  const pages = [
    { url: "https://example.com/", text: "short" },
    { url: "https://www.example.com/", text: "much longer real content here" },
  ];
  const deduped = dedupePagesForFrequencyAnalysis(pages);
  assert.deepEqual(deduped, ["much longer real content here"]);
});

// ---- 6. Asset-noise removal (unchanged from the prior pass) ---------------

test("pruneAssetNoiseLines: the real corpus's truncated markdown-image-reference remnant ('.svg)') is removed, unrelated parenthetical prose is not", () => {
  const text = ["For customer experience", ".svg)", ".svg)", "Register for Orientation (Aug 19–20)"].join("\n");
  const cleaned = pruneAssetNoiseLines(text);
  assert.ok(!cleaned.includes(".svg)"));
  assert.ok(cleaned.includes("Register for Orientation (Aug 19–20)"));
});

test("pruneAssetNoiseLines: a bare asset filename line is removed, real prose survives", () => {
  const text = ["DRUID Platform Overview", "hero-banner.svg", "Build agentic AI experiences with DRUID."].join("\n");
  const cleaned = pruneAssetNoiseLines(text);
  assert.ok(!cleaned.includes("hero-banner.svg"));
  assert.ok(cleaned.includes("DRUID Platform Overview"));
});

// ---- 7. No short-line-run heuristic; unique body text always retained -----

test("structural: druidContextSources.ts never imports or reimplements a short-line-run/length-based removal heuristic", () => {
  const path = fileURLToPath(new URL("../src/services/druidContextSources.ts", import.meta.url));
  const source = readFileSync(path, "utf8");
  assert.ok(!/pruneShortLineRuns|isShortNoTerminalPunctuationLine/i.test(source));
});

test("pruneCrossPageChrome: a short, page-UNIQUE capability line (appearing on only one page) is never removed regardless of length or punctuation", () => {
  const uniqueShortLines = ["Agentic AI", "Process Automation", "Generative AI", "Conversational AI 101", "DRUID Conductor"];
  const texts = UNIQUE_PAGE_BODIES.map((body, i) => [REAL_NAV_CHROME_LINE, uniqueShortLines[i], body].join("\n"));
  const cleaned = pruneCrossPageChrome(asPages(texts));
  for (let i = 0; i < cleaned.length; i++) {
    assert.ok(cleaned[i]!.includes(uniqueShortLines[i]!), `expected "${uniqueShortLines[i]}" retained`);
  }
});

// ---- 8/9. Determinism and order-independence -------------------------------

test("pruneCrossPageChrome is deterministic: identical input always produces identical output", () => {
  const pages = asPages(buildFivePages(REAL_NAV_CHROME_LINE, "det-case"));
  assert.deepEqual(pruneCrossPageChrome(pages), pruneCrossPageChrome(pages));
});

function removedLineSet(originalPages: { text: string }[], cleanedPages: readonly string[]): Set<string> {
  const removed = new Set<string>();
  for (let i = 0; i < originalPages.length; i++) {
    const origLines = new Set(originalPages[i]!.text.split("\n").map((l) => l.trim()).filter(Boolean));
    const cleanLines = new Set(cleanedPages[i]!.split("\n").map((l) => l.trim()).filter(Boolean));
    for (const line of origLines) if (!cleanLines.has(line)) removed.add(line);
  }
  return removed;
}

test("pruneCrossPageChrome: page ordering never changes which lines/blocks are classified as chrome (order-independent)", () => {
  const pages = asPages([
    ...buildFivePages(REAL_NAV_CHROME_LINE, "order-case"),
    REAL_FEATURED_RESOURCES_BLOCK.join("\n") + "\nUnique C.",
    REAL_FEATURED_RESOURCES_BLOCK.join("\n") + "\nUnique D.",
  ]);
  const reversedPages = [...pages].reverse();

  const forwardCleaned = pruneCrossPageChrome(pages);
  const reversedCleaned = pruneCrossPageChrome(reversedPages);

  const forwardRemoved = removedLineSet(pages, forwardCleaned);
  const reverseRemoved = removedLineSet(reversedPages, reversedCleaned);
  assert.deepEqual([...forwardRemoved].sort(), [...reverseRemoved].sort());
});

test("computeCrossPageLineFrequencies / computeCrossPageBlockKeys: fewer pages than the respective threshold means no candidate qualifies", () => {
  const chromeSet = computeSingleLineChromeSet([REAL_NAV_CHROME_LINE, REAL_NAV_CHROME_LINE, REAL_NAV_CHROME_LINE, REAL_NAV_CHROME_LINE]); // only 4 pages, floor is 5
  assert.equal(chromeSet.size, 0);
  const blockKeys = computeCrossPageBlockKeys([REAL_FEATURED_RESOURCES_BLOCK.join("\n")]); // only 1 page, floor is 2
  assert.equal(blockKeys.size, 0);
});

// ---- 10. Cleanup runs before bounding/hash (structural) ---------------------

test("structural: refreshDruidContextSources computes cross-page cleanup over the WHOLE batch (pruneCrossPageChrome) before the per-page clean/bound/hash loop", () => {
  const path = fileURLToPath(new URL("../src/services/druidContextSources.ts", import.meta.url));
  const source = readFileSync(path, "utf8");
  const crossPageCallIdx = source.indexOf("pruneCrossPageChrome(pages)");
  const perPageCallIdx = source.indexOf("boundExtractedText(cleanExtractedText(pruneAssetNoiseLines(");
  assert.ok(crossPageCallIdx !== -1, "expected the batch-level cross-page call");
  assert.ok(perPageCallIdx !== -1, "expected the per-page clean/bound chain");
  assert.ok(crossPageCallIdx < perPageCallIdx, "cross-page cleanup must run before the per-page clean/bound/hash chain");
});
