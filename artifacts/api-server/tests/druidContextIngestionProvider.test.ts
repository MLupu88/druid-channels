// Pure unit tests for the DRUID Context ingestion provider (Tavily Crawl
// request shape, same-domain filtering, response validation/hardening) --
// no live server, database, or network call. fetch is mocked per-test,
// same convention as discoveryProviders.test.ts. Only crawlViaTavily (the
// already-resolved-apiKey variant) is tested here -- crawl()/isConfigured()
// go through resolveProviderSecret/hasResolvableCredential, which query the
// DB, so (matching discoveryProviders.test.ts's own established boundary)
// those are out of scope for a pure test file.
//
//   DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:59999/placeholder \
//     tsx --test tests/druidContextIngestionProvider.test.ts
// or `pnpm run test:druid-context-ingestion-provider` with the same env exported.
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crawlViaTavily, DruidContextCrawlProviderError } from "../src/services/druidContextIngestionProvider";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

// Restored after every test, not just once at the end -- same rationale as
// discoveryProviders.test.ts: a test order change must never let one test's
// fetch mock leak into the next.
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- Request shape ----------------------------------------------------

test("crawlViaTavily sends the exact minimum required /crawl request fields", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: any = null;
  let capturedAuth: string | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    capturedUrl = String(url);
    capturedAuth = init.headers.Authorization;
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await crawlViaTavily("test-key");

  assert.equal(capturedUrl, "https://api.tavily.com/crawl");
  assert.equal(capturedAuth, "Bearer test-key");
  assert.equal(capturedBody.url, "https://druidai.com");
  assert.equal(capturedBody.limit, 20);
  assert.equal(capturedBody.allow_external, false);
  assert.equal(capturedBody.format, "text");
  assert.equal(capturedBody.extract_depth, "basic");
  // No invented "timeout" JSON property -- bounding is done locally via
  // AbortController, not by asking Tavily to enforce it server-side.
  assert.equal(capturedBody.timeout, undefined);
});

// ---- Same-domain filtering ---------------------------------------------

test("crawlViaTavily accepts the root druidai.com URL", async () => {
  mockFetchOnce(200, { results: [{ url: "https://druidai.com/product", raw_content: "DRUID product page" }] });
  const pages = await crawlViaTavily("test-key");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.url, "https://druidai.com/product");
  assert.equal(pages[0]!.text, "DRUID product page");
});

test("crawlViaTavily accepts a subdomain of druidai.com", async () => {
  mockFetchOnce(200, { results: [{ url: "https://app.druidai.com/pricing", raw_content: "Pricing" }] });
  const pages = await crawlViaTavily("test-key");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.url, "https://app.druidai.com/pricing");
});

test("crawlViaTavily rejects an external domain even if Tavily returns it (defense in depth against allow_external being ignored)", async () => {
  mockFetchOnce(200, {
    results: [
      { url: "https://druidai.com/product", raw_content: "DRUID product page" },
      { url: "https://evil-external.example/page", raw_content: "should never be persisted" },
      { url: "https://not-druidai.com/page", raw_content: "similar-looking but different domain -- must be rejected" },
    ],
  });
  const pages = await crawlViaTavily("test-key");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.url, "https://druidai.com/product");
});

test("crawlViaTavily rejects a non-http(s) protocol URL", async () => {
  mockFetchOnce(200, {
    results: [
      { url: "javascript:alert(1)", raw_content: "malicious" },
      { url: "ftp://druidai.com/file", raw_content: "wrong protocol" },
      { url: "https://druidai.com/legit", raw_content: "legit" },
    ],
  });
  const pages = await crawlViaTavily("test-key");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.url, "https://druidai.com/legit");
});

test("crawlViaTavily drops results with a malformed/unparseable url", async () => {
  mockFetchOnce(200, {
    results: [
      { url: "not a valid url at all", raw_content: "malformed" },
      { url: "https://druidai.com/ok", raw_content: "ok" },
    ],
  });
  const pages = await crawlViaTavily("test-key");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.url, "https://druidai.com/ok");
});

test("crawlViaTavily drops results missing url or raw_content", async () => {
  mockFetchOnce(200, {
    results: [
      { url: "https://druidai.com/no-content" },
      { raw_content: "no url" },
      { url: "https://druidai.com/ok", raw_content: "ok" },
    ],
  });
  const pages = await crawlViaTavily("test-key");
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.url, "https://druidai.com/ok");
});

test("crawlViaTavily bounds the returned page count to the configured crawl limit even if the provider returns more", async () => {
  const results = Array.from({ length: 30 }, (_, i) => ({ url: `https://druidai.com/page-${i}`, raw_content: `page ${i}` }));
  mockFetchOnce(200, { results });
  const pages = await crawlViaTavily("test-key");
  assert.equal(pages.length, 20);
});

// ---- Error handling ------------------------------------------------------

test("crawlViaTavily throws DruidContextCrawlProviderError('http_error') on a non-2xx response", async () => {
  mockFetchOnce(500, { error: "internal" });
  await assert.rejects(() => crawlViaTavily("test-key"), DruidContextCrawlProviderError);
});

test("crawlViaTavily maps an aborted request to DruidContextCrawlProviderError('timeout')", async () => {
  globalThis.fetch = (async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  try {
    await crawlViaTavily("test-key");
    assert.fail("expected crawlViaTavily to throw");
  } catch (err) {
    assert.ok(err instanceof DruidContextCrawlProviderError);
    assert.equal((err as DruidContextCrawlProviderError).code, "timeout");
  }
});

test("crawlViaTavily maps a network failure (non-abort) to DruidContextCrawlProviderError('network_error')", async () => {
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as typeof fetch;

  try {
    await crawlViaTavily("test-key");
    assert.fail("expected crawlViaTavily to throw");
  } catch (err) {
    assert.ok(err instanceof DruidContextCrawlProviderError);
    assert.equal((err as DruidContextCrawlProviderError).code, "network_error");
  }
});

test("crawlViaTavily throws DruidContextCrawlProviderError('malformed_json') on unparseable response text", async () => {
  globalThis.fetch = (async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  try {
    await crawlViaTavily("test-key");
    assert.fail("expected crawlViaTavily to throw");
  } catch (err) {
    assert.ok(err instanceof DruidContextCrawlProviderError);
    assert.equal((err as DruidContextCrawlProviderError).code, "malformed_json");
  }
});

test("crawlViaTavily throws DruidContextCrawlProviderError('malformed_response') when results is missing or not an array", async () => {
  mockFetchOnce(200, { not_results: [] });
  try {
    await crawlViaTavily("test-key");
    assert.fail("expected crawlViaTavily to throw");
  } catch (err) {
    assert.ok(err instanceof DruidContextCrawlProviderError);
    assert.equal((err as DruidContextCrawlProviderError).code, "malformed_response");
  }
});

test("crawlViaTavily throws DruidContextCrawlProviderError('oversized_response') when the response exceeds the size ceiling", async () => {
  const hugeText = "x".repeat(3_000_000);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results: [{ url: "https://druidai.com/x", raw_content: hugeText }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await crawlViaTavily("test-key");
    assert.fail("expected crawlViaTavily to throw");
  } catch (err) {
    assert.ok(err instanceof DruidContextCrawlProviderError);
    assert.equal((err as DruidContextCrawlProviderError).code, "oversized_response");
  }
});
