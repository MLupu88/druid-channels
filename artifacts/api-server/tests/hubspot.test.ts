import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  findCompanyByDomain,
  findPrimaryCompanyForDeal,
  HubSpotAmbiguousCompanyError,
  HubSpotProviderError,
  normalizeHubSpotDomain,
  searchDeals,
  testConnection,
} from "../src/services/hubspot";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = (async () => jsonResponse(status, body)) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test("testConnection makes one minimal companies request and succeeds", async () => {
  let calls = 0;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url, init) => {
    calls += 1;
    capturedUrl = String(url);
    capturedInit = init;
    return jsonResponse(200, { results: [] });
  }) as typeof fetch;

  const result = await testConnection("private-token");

  assert.deepEqual(result, { ok: true, message: "HubSpot connection successful." });
  assert.equal(calls, 1);
  assert.equal(capturedUrl, "https://api.hubapi.com/crm/v3/objects/companies?limit=1&properties=hs_object_id");
  assert.equal(capturedInit?.method, "GET");
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer private-token");
});

test("testConnection handles 401 and 403 without leaking the token", async (t) => {
  const token = "secret-token-that-must-not-leak";
  for (const [status, phrase] of [
    [401, "authentication failed"],
    [403, "denied access"],
  ] as const) {
    await t.test(String(status), async () => {
      mockFetchOnce(status, { message: `provider echoed ${token}` });
      const result = await testConnection(token);
      assert.equal(result.ok, false);
      assert.match(result.message, new RegExp(phrase, "i"));
      assert.equal(result.message.includes(token), false);
    });
  }
});

test("testConnection reports rate limiting clearly", async () => {
  mockFetchOnce(429, { message: "too many requests" });
  const result = await testConnection("private-token");
  assert.deepEqual(result, { ok: false, message: "HubSpot rate limit reached. Try again later." });
});

test("testConnection distinguishes timeout and network failures", async (t) => {
  await t.test("timeout", async () => {
    globalThis.fetch = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch;
    assert.deepEqual(await testConnection("private-token"), {
      ok: false,
      message: "HubSpot connection timed out. Try again later.",
    });
  });

  await t.test("network", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("socket unavailable");
    }) as typeof fetch;
    assert.deepEqual(await testConnection("private-token"), {
      ok: false,
      message: "HubSpot could not be reached due to a network error.",
    });
  });
});

test("normalizeHubSpotDomain strips scheme, path, www, case, whitespace, and trailing dot", () => {
  assert.equal(normalizeHubSpotDomain("  HTTPS://WWW.Example.COM./some/path?q=1  "), "example.com");
  assert.equal(normalizeHubSpotDomain("www.EXAMPLE.com/path"), "example.com");
});

test("findCompanyByDomain performs an exact normalized-domain search and maps one match", async () => {
  let capturedUrl = "";
  let capturedBody: any;
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      results: [{ id: "101", properties: { name: "Example", domain: "example.com", hs_object_id: "101" } }],
    });
  }) as typeof fetch;

  const result = await findCompanyByDomain("private-token", " https://www.Example.com/about ");

  assert.equal(capturedUrl, "https://api.hubapi.com/crm/v3/objects/companies/search");
  assert.deepEqual(capturedBody.filterGroups, [
    { filters: [{ propertyName: "domain", operator: "EQ", value: "example.com" }] },
  ]);
  assert.deepEqual(capturedBody.properties, ["name", "domain", "hs_object_id"]);
  assert.equal(capturedBody.limit, 2);
  assert.deepEqual(result, { id: "101", name: "Example", domain: "example.com", objectId: "101" });
});

test("findCompanyByDomain returns null when HubSpot has no exact match", async () => {
  mockFetchOnce(200, { results: [] });
  assert.equal(await findCompanyByDomain("private-token", "example.com"), null);
});

test("findCompanyByDomain rejects multiple exact matches as ambiguous", async () => {
  mockFetchOnce(200, {
    results: [
      { id: "101", properties: { name: "Example A", domain: "example.com", hs_object_id: "101" } },
      { id: "202", properties: { name: "Example B", domain: "example.com", hs_object_id: "202" } },
    ],
  });

  await assert.rejects(
    () => findCompanyByDomain("private-token", "www.example.com"),
    (error: unknown) =>
      error instanceof HubSpotAmbiguousCompanyError && error.domain === "example.com" && error.matchCount === 2,
  );
});

test("searchDeals bounds the limit, requests narrow properties, and maps typed fields", async () => {
  let capturedBody: any;
  globalThis.fetch = (async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse(200, {
      results: [
        {
          id: "501",
          properties: {
            dealname: "Example renewal",
            amount: "12500.00",
            closedate: "2026-12-31T00:00:00.000Z",
            pipeline: "default",
            dealstage: "appointmentscheduled",
            createdate: "2026-01-02T03:04:05.000Z",
            hs_lastmodifieddate: "2026-08-19T10:11:12.000Z",
            hs_object_id: "501",
          },
        },
      ],
    });
  }) as typeof fetch;

  const result = await searchDeals("private-token", { query: "  Example renewal  ", limit: 200 });

  assert.equal(capturedBody.query, "Example renewal");
  assert.equal(capturedBody.limit, 20);
  assert.deepEqual(capturedBody.properties, [
    "dealname",
    "amount",
    "closedate",
    "pipeline",
    "dealstage",
    "createdate",
    "hs_lastmodifieddate",
    "hs_object_id",
  ]);
  assert.deepEqual(result, [
    {
      id: "501",
      dealName: "Example renewal",
      amount: "12500.00",
      closeDate: "2026-12-31T00:00:00.000Z",
      pipeline: "default",
      dealStage: "appointmentscheduled",
      createDate: "2026-01-02T03:04:05.000Z",
      lastModifiedDate: "2026-08-19T10:11:12.000Z",
      objectId: "501",
    },
  ]);
});

test("findPrimaryCompanyForDeal resolves the primary associated company", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });

    if (calls.length === 1) {
      return jsonResponse(200, {
        results: [
          {
            from: { id: "501" },
            to: [{ id: "101", type: "deal_to_company" }],
          },
        ],
      });
    }

    return jsonResponse(200, {
      id: "101",
      properties: {
        name: "Example Partner",
        domain: "example.com",
        hs_object_id: "101",
      },
    });
  }) as typeof fetch;

  const result = await findPrimaryCompanyForDeal("private-token", "501");

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]!.url,
    "https://api.hubapi.com/crm/v3/associations/deals/companies/batch/read",
  );
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    inputs: [{ id: "501" }],
  });
  assert.equal(
    calls[1]!.url,
    "https://api.hubapi.com/crm/v3/objects/companies/101?properties=name,domain,hs_object_id",
  );
  assert.deepEqual(result, {
    id: "101",
    name: "Example Partner",
    domain: "example.com",
    objectId: "101",
  });
});

test("malformed HubSpot JSON is handled safely", async () => {
  globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch;

  assert.deepEqual(await testConnection("private-token"), {
    ok: false,
    message: "HubSpot returned an invalid response.",
  });
  await assert.rejects(
    () => findCompanyByDomain("private-token", "example.com"),
    (error: unknown) => error instanceof HubSpotProviderError && error.code === "malformed_json",
  );
});
