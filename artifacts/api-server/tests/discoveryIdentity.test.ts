// Pure unit tests for Stage 3's company-identity resolution -- no live
// network, DB, or server. fetch is mocked per-test for the DeepSeek
// identity call; resolveCandidateCompanyIdentity's search+AI dependency is
// injected directly for the higher-level decision-logic tests (A/B/C).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolveCandidateCompanyIdentity } from "../src/services/discoveryEngine";
import { identifyCompanyViaDeepSeek } from "../src/services/discoveryProviders/ai";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

test("A. first-party source: subject company/evidence domain used directly, no identity lookup performed", async () => {
  let called = false;
  const resolveIdentity = async () => {
    called = true;
    return null;
  };
  const result = await resolveCandidateCompanyIdentity(
    { sourceIsFirstParty: true, subjectCompanyName: "Acme Systems" },
    "acme.example",
    resolveIdentity,
  );
  assert.deepEqual(result, { companyName: "Acme Systems", companyDomain: "acme.example" });
  assert.equal(called, false); // cost control: never spends an identity lookup on first-party evidence
});

test("B. third-party source: publisher domain replaced by the resolved subject company's own domain", async () => {
  const resolveIdentity = async (name: string) => {
    assert.equal(name, "Acme Systems");
    return { name: "Acme Systems", domain: "acme.example" };
  };
  const result = await resolveCandidateCompanyIdentity(
    { sourceIsFirstParty: false, subjectCompanyName: "Acme Systems" },
    "some-news-site.example", // the publisher's domain -- must not end up as companyDomain
    resolveIdentity,
  );
  assert.deepEqual(result, { companyName: "Acme Systems", companyDomain: "acme.example" });
});

test("C. unresolved identity: the publisher is never returned as the company", async () => {
  const resolveIdentity = async () => null; // DeepSeek said unresolved, or the identity search found nothing
  const result = await resolveCandidateCompanyIdentity(
    { sourceIsFirstParty: false, subjectCompanyName: "Some Obscure Company" },
    "news-aggregator.example",
    resolveIdentity,
  );
  assert.equal(result, null); // caller (discoveryEngine.ts) skips persistence entirely on null
});

test("identifyCompanyViaDeepSeek returns a resolved identity from the supplied candidates only", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, {
    choices: [
      { message: { content: JSON.stringify({ resolved: true, name: "Acme Systems", domain: "acme.example" }) }, finish_reason: "stop" },
    ],
  });
  const result = await identifyCompanyViaDeepSeek({
    subjectCompanyName: "Acme Systems",
    candidates: [{ url: "https://acme.example", title: "Acme Systems - Official Site", snippet: "Welcome to Acme" }],
  });
  assert.deepEqual(result, { name: "Acme Systems", domain: "acme.example" });
});

test("identifyCompanyViaDeepSeek returns null when the model reports unresolved", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, {
    choices: [{ message: { content: JSON.stringify({ resolved: false, name: null, domain: null }) }, finish_reason: "stop" }],
  });
  const result = await identifyCompanyViaDeepSeek({
    subjectCompanyName: "Some Obscure Company",
    candidates: [{ url: "https://unrelated.example", title: "Unrelated result", snippet: "..." }],
  });
  assert.equal(result, null);
});
