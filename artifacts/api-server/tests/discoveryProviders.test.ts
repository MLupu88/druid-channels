// Pure unit tests for the live Discovery providers (Tavily search
// normalization, DeepSeek qualification parsing) -- no live server,
// database, or network call. fetch is mocked per-test. @workspace/db
// throws at import time if DATABASE_URL is unset (see lib/db/src/index.ts)
// but pg.Pool construction doesn't actually connect until a query runs and
// none of the functions under test here ever query -- the placeholder
// value is set by the "test:discovery-providers" script, not this file
// (ESM hoists imports before any of this file's own top-level code runs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { searchViaTavily, SearchProviderError } from "../src/services/discoveryProviders/search";
import { qualifyViaDeepSeek, AiProviderError } from "../src/services/discoveryProviders/ai";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

test("searchViaTavily normalizes Tavily results and never fabricates a publish date", async () => {
  process.env.SEARCH_API_KEY = "test-key";
  mockFetchOnce(200, {
    query: "AI systems integrator",
    results: [
      { title: "Acme Systems", url: "https://acme.example/news", content: "Acme launched an AI practice.", score: 0.9 },
      { title: "Missing URL result", content: "should be dropped" }, // malformed -- no url
    ],
  });

  const results = await searchViaTavily("AI systems integrator", { maxResults: 5 });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, "https://acme.example/news");
  assert.equal(results[0]!.title, "Acme Systems");
  assert.equal(results[0]!.snippet, "Acme launched an AI practice.");
  assert.equal(results[0]!.publishedAt, null); // Tavily gives no per-result date -- must not be defaulted to "today"
});

test("searchViaTavily throws SearchProviderError on a non-2xx response", async () => {
  process.env.SEARCH_API_KEY = "test-key";
  mockFetchOnce(500, { error: "internal" });
  await assert.rejects(() => searchViaTavily("query", { maxResults: 5 }), SearchProviderError);
});

test("qualifyViaDeepSeek parses a valid qualification and filters invalid evidence URLs", async () => {
  process.env.AI_API_KEY = "test-key";
  const validQualification = {
    partner_type: "System integrator",
    signal_type: "ai_investment",
    subject_company_name: "Acme Systems",
    source_is_first_party: true,
    enterprise_access: true,
    relevant_capability: true,
    technology_adjacency: false,
    partnership_openness: false,
    recent_trigger: true,
    why_it_fits: "Serves enterprise customers and just launched an AI practice.",
    why_now: "New AI practice announced this quarter.",
    suggested_angle: "Add DRUID's agent layer to their new AI practice.",
    suggested_target_role: "Head of AI",
    suggested_message: "Saw your new AI practice launch -- would love to explore a partnership.",
    evidence_urls: ["https://acme.example/news", "https://not-given.example/fabricated"],
  };
  mockFetchOnce(200, {
    choices: [{ message: { content: JSON.stringify(validQualification) }, finish_reason: "stop" }],
  });

  const result = await qualifyViaDeepSeek({
    companyName: "Acme Systems",
    domain: "acme.example",
    evidence: [{ url: "https://acme.example/news", text: "Acme launched an AI practice." }],
    criteria: {
      partnerTypes: [],
      industries: [],
      technologies: [],
      territoryName: "Global",
      territoryCountries: [],
      excludedDomains: [],
      minChecksRequired: 3,
      searchIntent: [],
      targetSignalTypes: [],
    },
  });

  assert.equal(result.partnerType, "System integrator");
  assert.equal(result.signalType, "ai_investment");
  assert.equal(result.subjectCompanyName, "Acme Systems");
  assert.equal(result.sourceIsFirstParty, true);
  assert.equal(result.enterpriseAccess, true);
  // The fabricated URL that wasn't part of the supplied evidence must be dropped.
  assert.deepEqual(result.evidenceUrls, ["https://acme.example/news"]);
});

test("qualifyViaDeepSeek throws AiProviderError on malformed model output", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, {
    choices: [{ message: { content: "not valid json" }, finish_reason: "stop" }],
  });

  await assert.rejects(
    () =>
      qualifyViaDeepSeek({
        companyName: "Acme Systems",
        domain: "acme.example",
        evidence: [{ url: "https://acme.example/news", text: "evidence" }],
        criteria: {
          partnerTypes: [],
          industries: [],
          technologies: [],
          territoryName: "Global",
          territoryCountries: [],
          excludedDomains: [],
          minChecksRequired: 3,
          searchIntent: [],
          targetSignalTypes: [],
        },
      }),
    AiProviderError,
  );
});
