// Phase 11.5C.3: pure unit tests for druidFacts.ts's formatTrustedDruidContext
// -- no live server, database, or network call. This function never queries
// the DB itself (callers pass in listTrustedDruidFacts()'s result), so every
// behavior here is testable with hand-constructed fixture objects.
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder \
//     tsx --test tests/formatTrustedDruidContext.test.ts
// or `pnpm run test:format-trusted-druid-context` with the same env exported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTrustedDruidContext } from "../src/services/druidFacts";
import { DRUID_FACT_CATEGORIES, type DruidFact } from "@workspace/db";

let fixtureRunId = 0;
function fakeFact(overrides: Partial<DruidFact> & { category: string; factText: string }): DruidFact {
  fixtureRunId++;
  return {
    id: `fixture-id-${fixtureRunId}`,
    category: overrides.category as DruidFact["category"],
    factText: overrides.factText,
    sourceType: "manual",
    sourceUrl: null,
    sourceNote: null,
    sourceContextId: null,
    verificationStatus: "verified",
    verifiedByUserId: "fixture-verifier-id",
    verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    active: true,
    deactivatedByUserId: null,
    deactivatedAt: null,
    createdByUserId: "fixture-creator-id",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedByUserId: "fixture-creator-id",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as DruidFact;
}

test("formatTrustedDruidContext returns '' for zero facts", () => {
  assert.equal(formatTrustedDruidContext([]), "");
});

test("formatTrustedDruidContext renders a single fact under its category header", () => {
  const result = formatTrustedDruidContext([fakeFact({ category: "product", factText: "DRUID is an enterprise conversational AI platform." })]);
  assert.equal(result, "[product]\n- DRUID is an enterprise conversational AI platform.");
});

test("formatTrustedDruidContext groups multiple facts in the same category under one header", () => {
  const result = formatTrustedDruidContext([
    fakeFact({ category: "product", factText: "Fact one." }),
    fakeFact({ category: "product", factText: "Fact two." }),
  ]);
  assert.equal(result, "[product]\n- Fact one.\n- Fact two.");
});

test("formatTrustedDruidContext orders categories by DRUID_FACT_CATEGORIES' fixed declared order, not input order", () => {
  // Deliberately supplied in reverse of the declared category order.
  const reversedCategories = [...DRUID_FACT_CATEGORIES].reverse();
  const facts = reversedCategories.map((category) => fakeFact({ category, factText: `Fact for ${category}.` }));

  const result = formatTrustedDruidContext(facts);
  const headerOrder = [...result.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]);
  assert.deepEqual(headerOrder, [...DRUID_FACT_CATEGORIES]);
});

test("formatTrustedDruidContext never leaks id/source_url/source_note/source_context_id/source_type/verification metadata", () => {
  const fact = fakeFact({
    category: "proof_point",
    factText: "A clean, admin-written fact.",
    id: "SENTINEL-ID-MUST-NOT-LEAK",
    sourceUrl: "https://sentinel-leak.example/should-not-appear",
    sourceNote: "SENTINEL-NOTE-MUST-NOT-LEAK",
    sourceContextId: "SENTINEL-SOURCE-CONTEXT-ID",
    sourceType: "ingested",
    verifiedByUserId: "SENTINEL-VERIFIER-ID",
  });

  const result = formatTrustedDruidContext([fact]);
  assert.ok(result.includes("A clean, admin-written fact."), "the fact text itself must still be present");
  for (const sentinel of [
    "SENTINEL-ID-MUST-NOT-LEAK",
    "sentinel-leak.example",
    "SENTINEL-NOTE-MUST-NOT-LEAK",
    "SENTINEL-SOURCE-CONTEXT-ID",
    "SENTINEL-VERIFIER-ID",
    "ingested",
  ]) {
    assert.ok(!result.includes(sentinel), `formatted context must never include "${sentinel}"`);
  }
});

test("formatTrustedDruidContext bounds to a maximum of 30 facts", () => {
  const facts = Array.from({ length: 35 }, (_, i) => fakeFact({ category: "other", factText: `Fact number ${i}.` }));
  const result = formatTrustedDruidContext(facts);

  const factLines = result.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(factLines.length, 30, "only the first 30 facts may be included");
  assert.ok(result.includes("Fact number 29."), "the 30th fact (index 29) must be included");
  assert.ok(!result.includes("Fact number 30."), "the 31st fact (index 30) must not be included");
});

test("formatTrustedDruidContext bounds total formatted length to at most 4000 characters, without truncating a fact mid-sentence", () => {
  // Each fact is long enough that well under 30 of them exceed 4000 chars.
  const longText = "This is a deliberately long, repeated sentence used only to exercise the character bound. ".repeat(6); // ~564 chars
  const facts = Array.from({ length: 20 }, (_, i) => fakeFact({ category: "other", factText: `${longText}(#${i})` }));

  const result = formatTrustedDruidContext(facts);
  assert.ok(result.length <= 4000, `formatted context must never exceed 4000 characters (was ${result.length})`);

  // Every fact line that IS present must be a complete, unbroken line -- the
  // formatter only ever omits whole category blocks, never truncates one.
  const lines = result.split("\n");
  for (const line of lines) {
    if (line.startsWith("- ")) {
      assert.ok(line.endsWith(")"), `every included fact line must be whole/complete, never cut off mid-sentence: "${line.slice(-30)}"`);
    }
  }
});

test("formatTrustedDruidContext omits an entire category block rather than partially rendering it when it would exceed the character bound", () => {
  const nearLimitText = "x".repeat(3980);
  const facts = [
    fakeFact({ category: "product", factText: nearLimitText }),
    // This whole category ([positioning] header + fact line) cannot fit
    // after the first block -- it must be omitted entirely, not partially.
    fakeFact({ category: "positioning", factText: "This positioning fact must be entirely absent." }),
  ];

  const result = formatTrustedDruidContext(facts);
  assert.ok(result.includes(nearLimitText), "the first, fitting category block must still be fully present");
  assert.ok(!result.includes("[positioning]"), "a category header must never appear without its content fitting");
  assert.ok(!result.includes("This positioning fact"), "a category that cannot fit must be entirely omitted, not partially rendered");
});
