// Phase 11.5B: pure unit tests -- no DB, no live network. Covers two of the
// explicitly required behaviors that don't need a live DB fixture:
//  - secret-never-returned: toConnectionResponse's API-facing shape never
//    includes the ciphertext, encryption key version, or any decrypted
//    plaintext, even when the underlying row has a secret stored.
//  - real provider-test behavior with mocked HTTP: testConnection() for
//    both Tavily (web_search) and DeepSeek (ai) makes one minimal, bounded
//    live call and maps success/failure honestly, without ever needing
//    isConfigured()/DB access itself (the caller resolves apiKey first).
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { toConnectionResponse } from "../src/services/connections";
import { testConnection as testSearchConnection, SearchProviderError } from "../src/services/discoveryProviders/search";
import { testConnection as testAiConnection, AiProviderError } from "../src/services/discoveryProviders/ai";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- secret-never-returned -------------------------------------------

const SECRET_PLAINTEXT_MARKER = "sk-should-never-leak-9f8e7d6c";

function fakeConnectionRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date();
  return {
    id: "11111111-1111-1111-1111-111111111111",
    providerType: "web_search",
    providerName: "Web Search",
    status: "connected",
    configJson: {},
    credentialEnvVar: "SEARCH_API_KEY",
    enabled: true,
    // A ciphertext packed as ivBase64:authTagBase64:ciphertextBase64 -- the
    // exact shape encryptSecret() produces. Deliberately contains the
    // plaintext marker base64-encoded so the "never leaks" assertion below
    // is meaningful (a naive `!includes(rawPlaintext)` check would trivially
    // pass on real ciphertext even if the field were accidentally exposed).
    secretCiphertext: `aXY=:dGFn:${Buffer.from(SECRET_PLAINTEXT_MARKER, "utf8").toString("base64")}`,
    secretLast4: "6c9c",
    encryptionKeyVersion: 1,
    updatedByUserId: "22222222-2222-2222-2222-222222222222",
    lastTestedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any;
}

test("toConnectionResponse never includes secret_ciphertext, encryption_key_version, updated_by_user_id, or the decrypted plaintext", () => {
  const response = toConnectionResponse(fakeConnectionRow());
  const serialized = JSON.stringify(response);

  assert.equal("secret_ciphertext" in response, false);
  assert.equal("encryption_key_version" in response, false);
  assert.equal("updated_by_user_id" in response, false);
  assert.equal(serialized.includes(SECRET_PLAINTEXT_MARKER), false);
  assert.equal(serialized.includes(Buffer.from(SECRET_PLAINTEXT_MARKER, "utf8").toString("base64")), false);
});

test("toConnectionResponse masks with secret_last4 and has_db_secret, derived from presence only", () => {
  const withSecret = toConnectionResponse(fakeConnectionRow());
  assert.equal(withSecret.has_db_secret, true);
  assert.equal(withSecret.secret_last4, "6c9c");

  const withoutSecret = toConnectionResponse(
    fakeConnectionRow({ secretCiphertext: null, secretLast4: null, encryptionKeyVersion: null }),
  );
  assert.equal(withoutSecret.has_db_secret, false);
  assert.equal(withoutSecret.secret_last4, null);
});

test("toConnectionResponse reports enabled honestly", () => {
  assert.equal(toConnectionResponse(fakeConnectionRow({ enabled: true })).enabled, true);
  assert.equal(toConnectionResponse(fakeConnectionRow({ enabled: false })).enabled, false);
});

// ---- real provider-test behavior with mocked HTTP ----------------------

test("web_search testConnection: a successful minimal Tavily search (max_results 1) resolves without throwing", async () => {
  let capturedBody: any = null;
  let capturedAuth: string | null = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    capturedAuth = init.headers.Authorization;
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await testSearchConnection("tvly-real-key");

  assert.equal(capturedAuth, "Bearer tvly-real-key");
  assert.equal(capturedBody.max_results, 1);
  assert.equal(capturedBody.query, "test");
});

test("web_search testConnection: a non-2xx Tavily response throws SearchProviderError, not a raw exception", async () => {
  mockFetchOnce(401, { error: "invalid key" });
  await assert.rejects(() => testSearchConnection("bad-key"), SearchProviderError);
});

test("ai testConnection: a successful minimal DeepSeek completion (max_tokens 1) resolves without throwing", async () => {
  let capturedBody: any = null;
  let capturedAuth: string | null = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    capturedAuth = init.headers.Authorization;
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await testAiConnection("sk-real-key");

  assert.equal(capturedAuth, "Bearer sk-real-key");
  assert.equal(capturedBody.max_tokens, 1);
});

test("ai testConnection: a non-2xx DeepSeek response throws AiProviderError, not a raw exception", async () => {
  mockFetchOnce(401, { error: "invalid key" });
  await assert.rejects(() => testAiConnection("bad-key"), AiProviderError);
});

test("ai testConnection: an aborted/network-failed request maps to AiProviderError('timeout'), never a raw exception", async () => {
  globalThis.fetch = (async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  try {
    await testAiConnection("sk-real-key");
    assert.fail("expected testConnection to throw");
  } catch (err) {
    assert.ok(err instanceof AiProviderError);
    assert.equal((err as AiProviderError).code, "timeout");
  }
});
