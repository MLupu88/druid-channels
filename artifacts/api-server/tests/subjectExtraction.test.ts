// Phase 11.6.1 P3A: pure unit tests for the new batched subject-extraction
// provider function (discoveryProviders/ai.ts's extractSubjectsViaDeepSeek)
// -- no live server, database, or network call. fetch is mocked per-test,
// same convention as tests/discoveryProviders.test.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { extractSubjectsViaDeepSeek, AiProviderError, SUBJECT_EXTRACTION_TIMEOUT_MS } from "../src/services/discoveryProviders/ai";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

function deepseekResponse(results: unknown[]) {
  return { choices: [{ message: { content: JSON.stringify({ results }) }, finish_reason: "stop" }] };
}

const CANDIDATES = [
  { resultId: "0", title: "UiPath Newsroom", url: "https://uipath.com/newsroom/x", snippet: "UiPath announces..." },
  { resultId: "1", title: "Reuters: UiPath wins deal", url: "https://reuters.com/article-1", snippet: "UiPath, the automation company, ..." },
  { resultId: "2", title: "Top 10 RPA vendors 2026", url: "https://analyst.example/listicle", snippet: "1. UiPath 2. Automation Anywhere ..." },
  { resultId: "3", title: "Generic blog post", url: "https://blog.example/post", snippet: "unrelated musings" },
];

test("A: first-party subject -- source_is_first_party=true, identity_status=resolved", async () => {
  mockFetchOnce(200, deepseekResponse([
    { result_id: "0", subject_company_name: "UiPath", source_is_first_party: true, identity_status: "resolved" },
    { result_id: "1", subject_company_name: "UiPath", source_is_first_party: false, identity_status: "resolved" },
    { result_id: "2", subject_company_name: null, source_is_first_party: false, identity_status: "ambiguous" },
    { result_id: "3", subject_company_name: null, source_is_first_party: false, identity_status: "unknown" },
  ]));

  const results = await extractSubjectsViaDeepSeek("test-key", { candidates: CANDIDATES, territoryCountries: ["Romania"] });
  const byId = new Map(results.map((r) => [r.resultId, r]));

  assert.deepEqual(byId.get("0"), { resultId: "0", subjectCompanyName: "UiPath", sourceIsFirstParty: true, identityStatus: "resolved" });
});

test("A: third-party subject -- source_is_first_party=false, identity_status=resolved", async () => {
  mockFetchOnce(200, deepseekResponse([
    { result_id: "0", subject_company_name: "UiPath", source_is_first_party: true, identity_status: "resolved" },
    { result_id: "1", subject_company_name: "UiPath", source_is_first_party: false, identity_status: "resolved" },
    { result_id: "2", subject_company_name: null, source_is_first_party: false, identity_status: "ambiguous" },
    { result_id: "3", subject_company_name: null, source_is_first_party: false, identity_status: "unknown" },
  ]));

  const results = await extractSubjectsViaDeepSeek("test-key", { candidates: CANDIDATES, territoryCountries: ["Romania"] });
  const byId = new Map(results.map((r) => [r.resultId, r]));

  assert.deepEqual(byId.get("1"), { resultId: "1", subjectCompanyName: "UiPath", sourceIsFirstParty: false, identityStatus: "resolved" });
});

test("A: unknown -- no company confidently identified", async () => {
  mockFetchOnce(200, deepseekResponse([
    { result_id: "0", subject_company_name: "UiPath", source_is_first_party: true, identity_status: "resolved" },
    { result_id: "1", subject_company_name: "UiPath", source_is_first_party: false, identity_status: "resolved" },
    { result_id: "2", subject_company_name: null, source_is_first_party: false, identity_status: "ambiguous" },
    { result_id: "3", subject_company_name: null, source_is_first_party: false, identity_status: "unknown" },
  ]));

  const results = await extractSubjectsViaDeepSeek("test-key", { candidates: CANDIDATES, territoryCountries: ["Romania"] });
  const byId = new Map(results.map((r) => [r.resultId, r]));

  assert.deepEqual(byId.get("3"), { resultId: "3", subjectCompanyName: null, sourceIsFirstParty: false, identityStatus: "unknown" });
});

test("A: ambiguous/multi-subject listicle -- no single dominant subject, never guessed", async () => {
  mockFetchOnce(200, deepseekResponse([
    { result_id: "0", subject_company_name: "UiPath", source_is_first_party: true, identity_status: "resolved" },
    { result_id: "1", subject_company_name: "UiPath", source_is_first_party: false, identity_status: "resolved" },
    { result_id: "2", subject_company_name: null, source_is_first_party: false, identity_status: "ambiguous" },
    { result_id: "3", subject_company_name: null, source_is_first_party: false, identity_status: "unknown" },
  ]));

  const results = await extractSubjectsViaDeepSeek("test-key", { candidates: CANDIDATES, territoryCountries: ["Romania"] });
  const byId = new Map(results.map((r) => [r.resultId, r]));

  assert.deepEqual(byId.get("2"), { resultId: "2", subjectCompanyName: null, sourceIsFirstParty: false, identityStatus: "ambiguous" });
});

test("A: malformed AI output (invalid identity_status enum value) is rejected as schema_invalid", async () => {
  mockFetchOnce(200, deepseekResponse([
    { result_id: "0", subject_company_name: "UiPath", source_is_first_party: true, identity_status: "definitely" },
  ]));

  await assert.rejects(
    () => extractSubjectsViaDeepSeek("test-key", { candidates: [CANDIDATES[0]!], territoryCountries: [] }),
    (err: unknown) => err instanceof AiProviderError && err.code === "schema_invalid",
  );
});

test("A: malformed AI output (missing required field) is rejected as schema_invalid", async () => {
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify({ results: [{ result_id: "0" }] }) }, finish_reason: "stop" }] });

  await assert.rejects(
    () => extractSubjectsViaDeepSeek("test-key", { candidates: [CANDIDATES[0]!], territoryCountries: [] }),
    (err: unknown) => err instanceof AiProviderError && err.code === "schema_invalid",
  );
});

test("A: non-JSON model output is rejected as malformed_json", async () => {
  mockFetchOnce(200, { choices: [{ message: { content: "not json at all" }, finish_reason: "stop" }] });

  await assert.rejects(
    () => extractSubjectsViaDeepSeek("test-key", { candidates: [CANDIDATES[0]!], territoryCountries: [] }),
    (err: unknown) => err instanceof AiProviderError && err.code === "malformed_json",
  );
});

test("A: a result_id the model hallucinated (never given as input) is dropped, never leaked into the caller's mapping", async () => {
  mockFetchOnce(200, deepseekResponse([
    { result_id: "0", subject_company_name: "UiPath", source_is_first_party: true, identity_status: "resolved" },
    { result_id: "999-not-given", subject_company_name: "Fabricated Co", source_is_first_party: false, identity_status: "resolved" },
  ]));

  const results = await extractSubjectsViaDeepSeek("test-key", { candidates: [CANDIDATES[0]!], territoryCountries: [] });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.resultId, "0");
});

test("A: truncated response (finish_reason=length) is rejected as truncated", async () => {
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify({ results: [] }) }, finish_reason: "length" }] });

  await assert.rejects(
    () => extractSubjectsViaDeepSeek("test-key", { candidates: [CANDIDATES[0]!], territoryCountries: [] }),
    (err: unknown) => err instanceof AiProviderError && err.code === "truncated",
  );
});

test("check: subject-extraction timeout is bounded (30 seconds)", () => {
  assert.equal(SUBJECT_EXTRACTION_TIMEOUT_MS, 30_000);
});

test("subject extraction never resolves or invents a domain -- no domain field exists anywhere in its output shape", async () => {
  mockFetchOnce(200, deepseekResponse([
    { result_id: "0", subject_company_name: "UiPath", source_is_first_party: true, identity_status: "resolved" },
  ]));
  const results = await extractSubjectsViaDeepSeek("test-key", { candidates: [CANDIDATES[0]!], territoryCountries: [] });
  assert.deepEqual(Object.keys(results[0]!).sort(), ["identityStatus", "resultId", "sourceIsFirstParty", "subjectCompanyName"]);
});
