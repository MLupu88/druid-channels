// Phase 11.6E: pure, DB-free unit tests for druidContextSources.ts's
// cleanExtractedText -- the deterministic garbage-removal step applied to
// a crawled page's text before boundExtractedText/computeContentHash (see
// refreshDruidContextSources). No network, no DB, no LLM -- run with:
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder tsx --test tests/druidContextCleanup.test.ts
// or `pnpm run test:druid-context-cleanup`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanExtractedText, computeContentHash } from "../src/services/druidContextSources";

// ---- version-transition semantics (pure, no DB) ----------------------------
// Demonstrates, without any DB coupling, exactly the first-refresh behavior
// described in refreshDruidContextSources's own comment: an existing row's
// content_hash was computed from OLD raw text (never rewritten by this
// feature), so a hash computed over newly-cleaned text will legitimately
// differ from it on the first refresh after 11.6E ships -- this is
// expected, not a defect. Once a cleaned version exists, repeated identical
// cleaned crawls hash-match each other normally.

test("raw noisy text and its cleaned form hash differently -- the first post-11.6E refresh will not match an old raw-text row", () => {
  const raw = ["DRUID Platform", "Home", "Home", "M12.5 3.5L8 8L12.5 12.5 M3.5 8H12.5 M8 3.5V12.5 M0 0 L10 10 C 20 20", "Real DRUID product content here."].join("\n");
  const cleaned = cleanExtractedText(raw);
  assert.notEqual(cleaned, raw, "cleanup must have actually changed this noisy input");
  assert.notEqual(computeContentHash(raw), computeContentHash(cleaned), "a hash computed from the pre-11.6E raw text must not equal a hash computed from the cleaned text");
});

test("cleaned text is deterministic across repeated cleanup calls, so a stable cleaned version hash-matches itself on later identical crawls", () => {
  const raw = ["DRUID Platform", "Home", "Home", "Real DRUID product content here."].join("\n");
  const cleanedFirst = cleanExtractedText(raw);
  const cleanedSecond = cleanExtractedText(raw);
  assert.equal(cleanedFirst, cleanedSecond);
  assert.equal(computeContentHash(cleanedFirst), computeContentHash(cleanedSecond), "two crawls of the same underlying page must produce the same cleaned-text hash once a cleaned version exists");
});

test("a normal meaningful paragraph is preserved exactly, unchanged", () => {
  const text = "DRUID is an enterprise conversational and agentic AI platform vendor.\n\nIt helps large organizations automate customer and employee interactions.";
  assert.equal(cleanExtractedText(text), text);
});

test("SVG path-command noise is removed, real content around it survives", () => {
  const text = [
    "DRUID Platform Overview",
    "M12.5 3.5L8 8L12.5 12.5 M3.5 8H12.5 M8 3.5V12.5 M0 0 L10 10 C 20 20 30 10 40 0 Z Q 5 5 10 10 A 5 5 0 0 1 15 15",
    "Build agentic AI experiences with DRUID's conversational platform.",
  ].join("\n");
  const cleaned = cleanExtractedText(text);
  assert.ok(cleaned.includes("DRUID Platform Overview"));
  assert.ok(cleaned.includes("Build agentic AI experiences with DRUID's conversational platform."));
  assert.ok(!cleaned.includes("M12.5 3.5L8"), "the SVG path-command line must be removed");
});

test("inline base64/data-URI blobs are stripped, surrounding text survives", () => {
  const dataUri = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==";
  const text = `Our logo: ${dataUri} represents DRUID's brand identity.`;
  const cleaned = cleanExtractedText(text);
  assert.ok(!cleaned.includes("base64"));
  assert.ok(!cleaned.includes(dataUri));
  assert.ok(cleaned.includes("Our logo:"));
  assert.ok(cleaned.includes("represents DRUID's brand identity."));
});

test("repeated internal whitespace is collapsed within a line, without touching real spacing between words", () => {
  const text = "DRUID    integrates   with    leading   enterprise   platforms.";
  assert.equal(cleanExtractedText(text), "DRUID integrates with leading enterprise platforms.");
});

test("a nav item repeated back-to-back collapses to one occurrence, without deleting the unique content around it", () => {
  const text = ["Home", "Home", "Home", "Product", "Pricing", "About DRUID's enterprise AI platform."].join("\n");
  const cleaned = cleanExtractedText(text);
  const lines = cleaned.split("\n");
  assert.equal(lines.filter((l) => l === "Home").length, 1, "consecutive duplicate chrome lines must collapse to one");
  assert.ok(cleaned.includes("Product"));
  assert.ok(cleaned.includes("Pricing"));
  assert.ok(cleaned.includes("About DRUID's enterprise AI platform."));
});

test("non-consecutive repeats of a real short line are left alone (never deduplicated across the whole page)", () => {
  // A legitimately repeated short phrase (e.g. a recurring section label
  // separated by real content) must survive -- only IMMEDIATELY consecutive
  // duplicates are chrome-collapsed.
  const text = ["Featured Resources", "A whitepaper on agentic AI in the enterprise.", "Featured Resources", "A case study on conversational automation."].join("\n");
  const cleaned = cleanExtractedText(text);
  assert.equal(cleaned.split("\n").filter((l) => l === "Featured Resources").length, 2, "non-consecutive repeats are real structure, not chrome, and must not be removed");
});

test("known cookie/privacy/copyright boilerplate lines are removed when they are the entire line", () => {
  const text = ["DRUID's platform in one sentence.", "Accept all cookies", "Privacy Policy", "© 2026 DRUID AI. All rights reserved.", "Real closing sentence about DRUID."].join("\n");
  const cleaned = cleanExtractedText(text);
  assert.ok(!cleaned.includes("Accept all cookies"));
  assert.ok(!cleaned.includes("Privacy Policy"));
  assert.ok(!/©\s*2026/.test(cleaned));
  assert.ok(cleaned.includes("DRUID's platform in one sentence."));
  assert.ok(cleaned.includes("Real closing sentence about DRUID."));
});

test("a sentence that merely mentions cookies/privacy in real prose is NOT removed (exact-line blocklist only, never substring)", () => {
  const text = "DRUID never stores customer conversation data without explicit privacy policy consent from the enterprise customer.";
  assert.equal(cleanExtractedText(text), text);
});

test("excessive consecutive blank lines collapse to a single paragraph break, never removing the paragraphs themselves", () => {
  const text = "First paragraph about DRUID.\n\n\n\n\nSecond paragraph about DRUID.";
  assert.equal(cleanExtractedText(text), "First paragraph about DRUID.\n\nSecond paragraph about DRUID.");
});

test("empty input returns empty output", () => {
  assert.equal(cleanExtractedText(""), "");
});

test("whitespace-only / near-empty input collapses to an empty string", () => {
  assert.equal(cleanExtractedText("   \n\n   \n"), "");
});

test("cleanup is deterministic: the same input always produces the exact same output", () => {
  const text = [
    "DRUID Platform",
    "M12.5 3.5L8 8L12.5 12.5 M3.5 8H12.5 M8 3.5V12.5",
    "Home",
    "Home",
    "Accept all cookies",
    "A real sentence about DRUID's ideal partner profile.",
  ].join("\n");
  const first = cleanExtractedText(text);
  const second = cleanExtractedText(text);
  assert.equal(first, second);
});

test("text with no cleanable noise round-trips completely unchanged", () => {
  const text = "DRUID is looking for system integrators and consultancies with enterprise AI delivery experience.";
  assert.equal(cleanExtractedText(text), text);
});
