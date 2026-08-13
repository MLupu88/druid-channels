// 5B-R hotfix: buildAutomaticQueries used to zip technologies + partner
// types + industries into one combined query per step whenever 2+ of those
// dimensions were configured -- a hard implicit AND across criteria that
// could spend the entire query budget on queries requiring all of them at
// once, crowding out simpler, higher-recall shapes. The rebalanced planner
// generates a bounded MIX of query shapes instead:
//   A. broad discovery      -- partner type + geography
//   B. ecosystem-focused    -- technology/ecosystem (+ partner type) + geography
//   C. industry-focused     -- industry (+ partner type) + geography
//   D. signal-focused       -- a target signal (+ partner type) + geography
// Pure unit tests -- no live network, DB, or server. buildAutomaticQueries
// and buildSearchQueries are pure functions (plain config/territory objects
// in, strings out).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutomaticQueries, buildSearchQueries } from "../src/services/discoveryEngine";
import type { ScanConfig, Territory } from "@workspace/db";

function baseConfig(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
    id: "config-1",
    territoryId: "territory-1",
    name: "Test config",
    searchQueries: [],
    partnerTypes: [],
    industries: [],
    technologies: [],
    excludedDomains: [],
    targetSignals: [],
    maxResults: 25,
    minChecksRequired: 3,
    recencyWindowDays: 90,
    active: true,
    ...overrides,
  } as ScanConfig;
}

const territory: Territory = {
  id: "territory-1",
  name: "UK & Ireland",
  ownerUserId: null,
  countries: ["United Kingdom", "Ireland"],
  languages: [],
} as Territory;

const richConfig = baseConfig({
  partnerTypes: ["System Integrator"],
  industries: ["Banking", "Insurance"],
  technologies: ["Microsoft", "Salesforce"],
  targetSignals: ["partnerships", "rfps"],
});

// ---- A. broad discovery: partner type + geography ------------------------

test("check: a broad partner-type + geography query exists even when technology and industry are also configured", () => {
  const queries = buildAutomaticQueries(richConfig, territory);
  const hasBroadPartnerTypeOnly = queries.some(
    (q) => /system integrator|implementation partner|technology consultancy/i.test(q) && !/Banking|Insurance|Microsoft|Salesforce/i.test(q),
  );
  assert.ok(hasBroadPartnerTypeOnly, `expected a partner-type-only broad query among: ${JSON.stringify(queries)}`);
});

test("no partner types configured -> no broad partner-type query is fabricated", () => {
  const queries = buildAutomaticQueries(baseConfig({ industries: ["Banking"] }), territory);
  for (const q of queries) {
    assert.ok(!/system integrator/i.test(q));
  }
});

// ---- B. ecosystem-focused: technology + partner type + geography ---------

test("check: an ecosystem-focused (technology) query exists when technology is configured", () => {
  const queries = buildAutomaticQueries(richConfig, territory);
  assert.ok(
    queries.some((q) => /Microsoft|Salesforce/.test(q)),
    `expected at least one technology-driven query among: ${JSON.stringify(queries)}`,
  );
});

test("no technologies configured -> no technology term appears in any query", () => {
  const queries = buildAutomaticQueries(baseConfig({ partnerTypes: ["MSP"], industries: ["Banking"] }), territory);
  for (const q of queries) {
    assert.ok(!/Microsoft|Salesforce/.test(q));
  }
});

// ---- C. industry-focused: industry + partner type + geography ------------

test("check: an industry-focused query exists when industry is configured", () => {
  const queries = buildAutomaticQueries(richConfig, territory);
  assert.ok(
    queries.some((q) => /Banking|Insurance/.test(q)),
    `expected at least one industry-driven query among: ${JSON.stringify(queries)}`,
  );
});

test("no industries configured -> no industry term appears in any query", () => {
  const queries = buildAutomaticQueries(baseConfig({ partnerTypes: ["MSP"], technologies: ["Microsoft"] }), territory);
  for (const q of queries) {
    assert.ok(!/Banking|Insurance/.test(q));
  }
});

// ---- D. signal-focused: never dominates the automatic query set ----------

test("check: signal-focused queries never consume every automatic query when other criteria are configured", () => {
  const queries = buildAutomaticQueries(richConfig, territory);
  const signalQueries = queries.filter((q) => /partner program|tender contract award/i.test(q));
  assert.ok(signalQueries.length > 0, "expected at least one signal-driven query");
  assert.ok(signalQueries.length < queries.length, "signal queries must not be the entire automatic query set");
});

test("check: no single query is ever required to contain partner type + technology + industry + signal all at once", () => {
  const queries = buildAutomaticQueries(richConfig, territory);
  for (const q of queries) {
    const hasTech = /Microsoft|Salesforce/.test(q);
    const hasIndustry = /Banking|Insurance/.test(q);
    const hasSignal = /partner program|tender contract award/i.test(q);
    // No query combines all three of tech + industry + signal (each family
    // combines at most one of {technology, industry, signal} with partner
    // type + geography, never all of them together).
    assert.ok(!(hasTech && hasIndustry && hasSignal), `query combined tech+industry+signal, violating the bounded-mix rule: "${q}"`);
  }
});

// ---- bounded, no Cartesian explosion --------------------------------------

test("check: query count stays bounded at a small cap even with every dimension richly configured", () => {
  const denseConfig = baseConfig({
    partnerTypes: ["System Integrator", "VAR", "Consulting", "MSP"],
    industries: ["Banking", "Insurance", "Retail", "Healthcare"],
    technologies: ["Microsoft", "Salesforce", "SAP", "AWS"],
    targetSignals: ["partnerships", "ai_moves", "rfps", "events", "customer_wins"],
  });
  const denseTerritory: Territory = { ...territory, countries: ["United Kingdom", "Ireland", "France", "Germany"] } as Territory;
  const queries = buildAutomaticQueries(denseConfig, denseTerritory);
  assert.ok(queries.length <= 12, `expected a bounded query count (<=12), got ${queries.length}`);
  // A true Cartesian product of 4 partner types x 4 industries x 4
  // technologies x 5 signals x 4 countries would be in the hundreds --
  // confirm the planner never gets anywhere close.
  assert.ok(queries.length < 4 * 4 * 4 * 5, "query count must never approach a Cartesian product of configured dimensions");
});

test("bounded even with a narrow profile -- never padded with junk to hit a target count", () => {
  const queries = buildAutomaticQueries(baseConfig({ partnerTypes: ["MSP"] }), territory);
  assert.ok(queries.length <= 12);
  assert.ok(queries.length > 0);
});

// ---- explicit search_queries bypass automatic planning --------------------

test("check: explicit search_queries completely bypass automatic query planning", () => {
  const explicit = ['"Genesys partner" + banking', '"launched an AI practice" + Germany'];
  const queries = buildSearchQueries(baseConfig({ searchQueries: explicit, partnerTypes: ["SI"], industries: ["Banking"] }), territory);
  assert.deepEqual(queries, explicit);
});

test("empty explicit search_queries falls through to automatic planning", () => {
  const queries = buildSearchQueries(baseConfig({ searchQueries: [], partnerTypes: ["SI"] }), territory);
  assert.ok(queries.length > 0);
  assert.notDeepEqual(queries, []);
});

// ---- unknown/custom partner types survive ---------------------------------

test("check: an unknown/custom partner type string passes through into the query set literally", () => {
  const queries = buildAutomaticQueries(baseConfig({ partnerTypes: ["Boutique Advisory Collective"] }), territory);
  assert.ok(
    queries.some((q) => q.includes("Boutique Advisory Collective")),
    `expected the custom partner type to survive literally among: ${JSON.stringify(queries)}`,
  );
});

test("a mix of known and custom partner types both show up", () => {
  const queries = buildAutomaticQueries(baseConfig({ partnerTypes: ["System Integrator", "Boutique Advisory Collective"] }), territory);
  const joined = queries.join(" | ");
  assert.ok(/systems integrator|implementation partner|technology consultancy/i.test(joined));
  assert.ok(joined.includes("Boutique Advisory Collective"));
});

// ---- duplicates/synonyms never produce duplicate queries -------------------

test("check: the generated automatic query list never contains duplicate entries", () => {
  const queries = buildAutomaticQueries(richConfig, territory);
  assert.equal(new Set(queries).size, queries.length, `expected no duplicate queries, got: ${JSON.stringify(queries)}`);
});

test("repeating the same partner type twice in config never doubles up its query", () => {
  const queries = buildAutomaticQueries(baseConfig({ partnerTypes: ["MSP", "MSP"] }), territory);
  assert.equal(new Set(queries).size, queries.length);
});

// ---- nothing configured at all --------------------------------------------

test("no dimensions configured at all -> no automatic queries (nothing to search for)", () => {
  const queries = buildAutomaticQueries(baseConfig(), territory);
  assert.deepEqual(queries, []);
});
