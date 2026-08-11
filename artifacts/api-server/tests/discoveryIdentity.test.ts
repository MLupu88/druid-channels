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

// ---- Phase 3A: canonical registrable-domain identity ------------------------

test("Phase 3A: a first-party subdomain (e.g. ir.acme.example) resolves to the canonical registrable domain, not the raw subdomain", async () => {
  const resolveIdentity = async () => null;
  const result = await resolveCandidateCompanyIdentity(
    { sourceIsFirstParty: true, subjectCompanyName: "Acme Systems" },
    "ir.acme.example",
    resolveIdentity,
  );
  assert.deepEqual(result, { companyName: "Acme Systems", companyDomain: "acme.example" });
});

test("Phase 3A: a third-party-resolved identity's domain is also canonicalized, even if the resolver returns a full URL or www-prefixed form", async () => {
  const resolveIdentity = async () => ({ name: "Acme Systems", domain: "https://www.acme.example/" });
  const result = await resolveCandidateCompanyIdentity(
    { sourceIsFirstParty: false, subjectCompanyName: "Acme Systems" },
    "some-news-site.example",
    resolveIdentity,
  );
  assert.deepEqual(result, { companyName: "Acme Systems", companyDomain: "acme.example" });
});

// ---- D. evidence-host guard: a known platform domain can never become identity, even if marked first-party ----

test("D: evidence on a known platform domain (e.g. youtube.com) marked sourceIsFirstParty=true is NOT trusted -- forced through third-party resolution instead", async () => {
  let resolveIdentityCalledWith: string | null = null;
  const resolveIdentity = async (subjectCompanyName: string) => {
    resolveIdentityCalledWith = subjectCompanyName;
    return { name: "Acme Systems", domain: "acme.example" };
  };
  const result = await resolveCandidateCompanyIdentity(
    // The AI qualification step (incorrectly, or via a hostile page) marked
    // this YouTube video as first-party evidence for "Acme Systems" -- the
    // guard must override that classification.
    { sourceIsFirstParty: true, subjectCompanyName: "Acme Systems" },
    "youtube.com",
    resolveIdentity,
  );
  assert.equal(resolveIdentityCalledWith, "Acme Systems", "expected the guard to force the third-party identity-resolution path");
  assert.deepEqual(result, { companyName: "Acme Systems", companyDomain: "acme.example" });
});

test("D: evidence on a known platform domain that cannot be resolved to a real company is dropped, never persisted as the platform's own identity", async () => {
  const resolveIdentity = async () => null; // unresolved
  const result = await resolveCandidateCompanyIdentity(
    { sourceIsFirstParty: true, subjectCompanyName: "Acme Systems" },
    "linkedin.com",
    resolveIdentity,
  );
  assert.equal(result, null);
});

test("D: a LinkedIn company-page URL's evidence never becomes companyDomain even when resolution succeeds with a different domain", async () => {
  const resolveIdentity = async () => ({ name: "Acme Systems", domain: "acme.example" });
  const result = await resolveCandidateCompanyIdentity(
    { sourceIsFirstParty: true, subjectCompanyName: "Acme Systems" },
    "linkedin.com",
    resolveIdentity,
  );
  assert.notEqual(result?.companyDomain, "linkedin.com");
  assert.deepEqual(result, { companyName: "Acme Systems", companyDomain: "acme.example" });
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
