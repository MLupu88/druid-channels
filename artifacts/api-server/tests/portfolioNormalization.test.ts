// Pure unit tests for Stage 6 PAM Portfolio import's DeepSeek normalization
// -- no live network, DB, or server. fetch is mocked per-test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeRowsViaDeepSeek, NormalizationProviderError } from "../src/services/portfolioImportProviders/normalization";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

const validRow = {
  row_index: 0,
  company_name: "Accenture Romania",
  domain: null,
  country: "Romania",
  partner_type: "Systems Integrator",
  relationship_summary: "Mostly Microsoft work, spoke to Andrei in May, potential healthcare opportunity.",
  status_hint: "active",
  relationship_started_at_raw_text: null,
  next_action: "Follow up on healthcare opportunity",
  confidence: "medium",
  needs_review: false,
  reasons: [],
};

test("normalizeRowsViaDeepSeek parses a valid batch response", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify({ rows: [validRow] }) }, finish_reason: "stop" }] });

  const result = await normalizeRowsViaDeepSeek([
    { rowIndex: 0, sourceRaw: { text: "Accenture Romania — active relationship, mostly Microsoft work" }, deterministicHints: { companyName: null, domain: null, country: null, partnerType: null } },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.companyName, "Accenture Romania");
  assert.equal(result[0]!.needsReview, false);
});

test("normalizeRowsViaDeepSeek never invents a domain -- null stays null through validation", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify({ rows: [{ ...validRow, domain: null }] }) }, finish_reason: "stop" }] });

  const result = await normalizeRowsViaDeepSeek([
    { rowIndex: 0, sourceRaw: { Partner: "Accenture Romania" }, deterministicHints: { companyName: "Accenture Romania", domain: null, country: null, partnerType: null } },
  ]);

  assert.equal(result[0]!.domain, null);
});

test("normalizeRowsViaDeepSeek throws NormalizationProviderError on malformed model output", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, { choices: [{ message: { content: "not valid json" }, finish_reason: "stop" }] });

  await assert.rejects(
    () => normalizeRowsViaDeepSeek([{ rowIndex: 0, sourceRaw: {}, deterministicHints: { companyName: null, domain: null, country: null, partnerType: null } }]),
    NormalizationProviderError,
  );
});

test("normalizeRowsViaDeepSeek throws NormalizationProviderError on a non-2xx response", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(500, { error: "internal" });

  await assert.rejects(
    () => normalizeRowsViaDeepSeek([{ rowIndex: 0, sourceRaw: {}, deterministicHints: { companyName: null, domain: null, country: null, partnerType: null } }]),
    NormalizationProviderError,
  );
});

test("normalizeRowsViaDeepSeek rejects a response missing required schema fields", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify({ rows: [{ row_index: 0, company_name: "Acme" }] }) }, finish_reason: "stop" }] });

  await assert.rejects(
    () => normalizeRowsViaDeepSeek([{ rowIndex: 0, sourceRaw: {}, deterministicHints: { companyName: null, domain: null, country: null, partnerType: null } }]),
    NormalizationProviderError,
  );
});
