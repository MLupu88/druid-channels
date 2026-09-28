import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  findCompanyByDomain,
  getDealWithHistory,
  getOwner,
  HubSpotAmbiguousCompanyError,
  HubSpotInputError,
  HubSpotProviderError,
  listCompanyDealAssociations,
  listDealPipelines,
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

// ---------------------------------------------------------------------------
// Commercial read primitives
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: URL;
  method: string | undefined;
  body: unknown;
}

function mockFetchSequence(responses: Array<[number, unknown]>): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  let index = 0;
  globalThis.fetch = (async (url, init) => {
    captured.push({ url: new URL(String(url)), method: init?.method, body: init?.body });
    const [status, body] = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return jsonResponse(status, body);
  }) as typeof fetch;
  return captured;
}

function isProviderError(code: string) {
  return (error: unknown) => error instanceof HubSpotProviderError && error.code === code;
}

test("listCompanyDealAssociations uses one GET, merges duplicate deal IDs, and keeps unique type strings", async () => {
  const captured = mockFetchSequence([
    [
      200,
      {
        id: "900",
        properties: {},
        associations: {
          deals: {
            results: [
              { id: "1", type: "company_to_deal" },
              { id: "1", type: "company_to_deal_unlabeled" },
              { id: "1", type: "company_to_deal" },
              { id: "2", type: "company_to_deal" },
            ],
          },
        },
      },
    ],
  ]);

  const result = await listCompanyDealAssociations("private-token", "900");

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.method, "GET");
  assert.equal(captured[0]!.url.origin, "https://api.hubapi.com");
  assert.equal(captured[0]!.url.pathname, "/crm/v3/objects/companies/900");
  assert.equal(captured[0]!.url.searchParams.get("associations"), "deals");
  assert.deepEqual(result, {
    deals: [
      { dealId: "1", associationTypes: ["company_to_deal", "company_to_deal_unlabeled"] },
      { dealId: "2", associationTypes: ["company_to_deal"] },
    ],
    returnedCount: 2,
    truncated: false,
  });
});

test("listCompanyDealAssociations returns an empty result when the company has no deals", async () => {
  mockFetchSequence([[200, { id: "900", properties: {} }]]);
  assert.deepEqual(await listCompanyDealAssociations("private-token", "900"), { deals: [], returnedCount: 0, truncated: false });
});

test("listCompanyDealAssociations follows pagination via the after cursor on HubSpot only", async () => {
  const captured = mockFetchSequence([
    [
      200,
      {
        id: "900",
        associations: {
          deals: {
            results: [{ id: "1", type: "company_to_deal" }],
            paging: { next: { after: "cursor-1", link: "https://evil.example.com/steal" } },
          },
        },
      },
    ],
    [200, { results: [{ id: "1", type: "company_to_deal_unlabeled" }, { id: "2", type: "company_to_deal" }] }],
  ]);

  const result = await listCompanyDealAssociations("private-token", "900");

  assert.equal(captured.length, 2);
  assert.equal(captured[1]!.method, "GET");
  assert.equal(captured[1]!.url.origin, "https://api.hubapi.com");
  assert.equal(captured[1]!.url.pathname, "/crm/v3/objects/companies/900/associations/deals");
  assert.equal(captured[1]!.url.searchParams.get("after"), "cursor-1");
  assert.deepEqual(result.deals, [
    { dealId: "1", associationTypes: ["company_to_deal", "company_to_deal_unlabeled"] },
    { dealId: "2", associationTypes: ["company_to_deal"] },
  ]);
  assert.equal(result.truncated, false);
});

test("listCompanyDealAssociations enforces the bound and reports truncation", async (t) => {
  await t.test("bound hit within a page", async () => {
    mockFetchSequence([
      [200, { id: "900", associations: { deals: { results: [{ id: "1" }, { id: "2" }, { id: "3" }] } } }],
    ]);
    const result = await listCompanyDealAssociations("private-token", "900", 2);
    assert.deepEqual(result.deals.map((deal) => deal.dealId), ["1", "2"]);
    assert.equal(result.returnedCount, 2);
    assert.equal("total" in result, false);
    assert.equal(result.truncated, true);
  });

  await t.test("bound reached with a further page is not fetched", async () => {
    const captured = mockFetchSequence([
      [200, { id: "900", associations: { deals: { results: [{ id: "1" }, { id: "2" }], paging: { next: { after: "x" } } } } }],
    ]);
    const result = await listCompanyDealAssociations("private-token", "900", 2);
    assert.equal(captured.length, 1);
    assert.equal(result.truncated, true);
  });

  await t.test("requested bound is clamped to 50", async () => {
    const results = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), type: "company_to_deal" }));
    mockFetchSequence([[200, { id: "900", associations: { deals: { results } } }]]);
    const result = await listCompanyDealAssociations("private-token", "900", 500);
    assert.equal(result.deals.length, 50);
    assert.equal(result.truncated, true);
  });
});

test("listCompanyDealAssociations rejects non-numeric company IDs before any request", async () => {
  const captured = mockFetchSequence([[200, {}]]);
  await assert.rejects(() => listCompanyDealAssociations("private-token", "../owners/1"), HubSpotInputError);
  assert.equal(captured.length, 0);
});

test("getDealWithHistory requests current properties, history, and company associations", async () => {
  const captured = mockFetchSequence([
    [
      200,
      {
        id: "501",
        properties: {
          dealname: "Example",
          amount: "1000",
          deal_currency_code: "EUR",
          pipeline: "default",
          dealstage: "appointmentscheduled",
          closedate: "2026-12-31T00:00:00.000Z",
          createdate: "2026-01-01T00:00:00.000Z",
          hs_is_closed: "false",
          hs_is_closed_won: "false",
          hs_is_closed_lost: "false",
          hubspot_owner_id: "77",
          hs_lastmodifieddate: "2026-08-01T00:00:00.000Z",
          unrelated: "ignored",
        },
        propertiesWithHistory: {
          dealstage: [
            { value: "qualifiedtobuy", timestamp: "2026-02-01T00:00:00.000Z", sourceType: "CRM_UI", sourceId: "u1", updatedByUserId: 5 },
            { value: "appointmentscheduled", timestamp: "2026-01-01T00:00:00.000Z", sourceType: "IMPORT" },
          ],
          amount: [{ value: "1000", timestamp: "2026-01-01T00:00:00.000Z" }],
        },
        associations: {
          companies: {
            results: [
              { id: "900", type: "deal_to_company" },
              { id: "900", type: "deal_to_company_unlabeled" },
            ],
          },
        },
      },
    ],
  ]);

  const deal = await getDealWithHistory("private-token", "501");

  const request = captured[0]!;
  assert.equal(request.method, "GET");
  assert.equal(request.url.pathname, "/crm/v3/objects/deals/501");
  const properties = request.url.searchParams.get("properties")!.split(",");
  assert.ok(properties.includes("hs_is_closed_lost"));
  assert.deepEqual(properties, [
    "dealname",
    "amount",
    "deal_currency_code",
    "pipeline",
    "dealstage",
    "closedate",
    "createdate",
    "hs_is_closed",
    "hs_is_closed_won",
    "hs_is_closed_lost",
    "hubspot_owner_id",
    "hs_lastmodifieddate",
  ]);
  assert.deepEqual(request.url.searchParams.get("propertiesWithHistory")!.split(","), [
    "dealstage",
    "amount",
    "deal_currency_code",
    "closedate",
    "pipeline",
    "hubspot_owner_id",
  ]);
  assert.equal(request.url.searchParams.get("associations"), "companies");

  assert.equal(deal.id, "501");
  assert.equal(deal.properties.hs_is_closed_lost, "false");
  assert.equal("unrelated" in deal.properties, false);
  assert.deepEqual(deal.propertiesWithHistory.dealstage, [
    { value: "qualifiedtobuy", timestamp: "2026-02-01T00:00:00.000Z", sourceType: "CRM_UI", sourceId: "u1" },
    { value: "appointmentscheduled", timestamp: "2026-01-01T00:00:00.000Z", sourceType: "IMPORT", sourceId: null },
  ]);
  assert.deepEqual(deal.propertiesWithHistory.pipeline, []);
  assert.deepEqual(deal.companies, [{ id: "900", associationTypes: ["deal_to_company", "deal_to_company_unlabeled"] }]);
  assert.equal(deal.companiesHasMore, false);
});

test("getDealWithHistory maps a 404 to a typed not_found error", async () => {
  mockFetchSequence([[404, { message: "not found" }]]);
  await assert.rejects(() => getDealWithHistory("private-token", "501"), isProviderError("not_found"));
});

test("listDealPipelines parses multiple pipelines and keeps metadata as provider strings", async () => {
  const captured = mockFetchSequence([
    [
      200,
      {
        results: [
          {
            id: "default",
            label: "Sales",
            displayOrder: 0,
            archived: false,
            stages: [
              { id: "appointmentscheduled", label: "Appointment", displayOrder: 0, archived: false, metadata: { isClosed: "false", probability: "0.2" } },
              { id: "closedwon", label: "Closed won", displayOrder: 5, archived: false, metadata: { isClosed: "true", probability: "1.0" } },
            ],
          },
          { id: "123", label: "Partners", displayOrder: 1, archived: false, stages: [{ id: "456", label: "Intro" }] },
        ],
      },
    ],
  ]);

  const pipelines = await listDealPipelines("private-token");

  assert.equal(captured[0]!.method, "GET");
  assert.equal(captured[0]!.url.pathname, "/crm/v3/pipelines/deals");
  assert.equal(pipelines.length, 2);
  assert.deepEqual(pipelines[0]!.stages[1], {
    id: "closedwon",
    label: "Closed won",
    displayOrder: 5,
    archived: false,
    metadata: { isClosed: "true", probability: "1.0" },
  });
  assert.deepEqual(pipelines[1], {
    id: "123",
    label: "Partners",
    displayOrder: 1,
    archived: false,
    stages: [{ id: "456", label: "Intro", displayOrder: null, archived: null, metadata: { isClosed: null, probability: null } }],
  });
});

test("getOwner resolves active owners, falls back to archived only on 404, and keeps other errors typed", async (t) => {
  const owner = { id: "77", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", userId: 1 };

  await t.test("active owner uses one request", async () => {
    const captured = mockFetchSequence([[200, { ...owner, archived: false }]]);
    assert.deepEqual(await getOwner("private-token", "77"), {
      id: "77",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      archived: false,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.method, "GET");
    assert.equal(captured[0]!.url.pathname, "/crm/v3/owners/77");
    assert.equal(captured[0]!.url.searchParams.get("archived"), "false");
  });

  await t.test("active 404 then archived 200 returns the archived owner", async () => {
    const captured = mockFetchSequence([
      [404, { message: "not found" }],
      [200, { ...owner, archived: true }],
    ]);
    const result = await getOwner("private-token", "77");
    assert.equal(result?.id, "77");
    assert.equal(result?.archived, true);
    assert.equal(captured.length, 2);
    assert.equal(captured[1]!.method, "GET");
    assert.equal(captured[1]!.url.pathname, "/crm/v3/owners/77");
    assert.equal(captured[1]!.url.searchParams.get("archived"), "true");
  });

  await t.test("both lookups 404 returns null", async () => {
    const captured = mockFetchSequence([
      [404, { message: "not found" }],
      [404, { message: "not found" }],
    ]);
    assert.equal(await getOwner("private-token", "77"), null);
    assert.equal(captured.length, 2);
  });

  for (const [status, code] of [
    [401, "authentication_error"],
    [403, "permission_error"],
    [429, "rate_limited"],
    [500, "http_error"],
  ] as const) {
    await t.test(`active 404 then archived ${status} stays a typed error`, async () => {
      mockFetchSequence([
        [404, { message: "not found" }],
        [status, {}],
      ]);
      await assert.rejects(() => getOwner("private-token", "77"), isProviderError(code));
    });
  }

  await t.test("non-404 on the active lookup does not fall back", async () => {
    const captured = mockFetchSequence([[500, {}]]);
    await assert.rejects(() => getOwner("private-token", "77"), isProviderError("http_error"));
    assert.equal(captured.length, 1);
  });
});

test("new primitives map 401/403/429/timeout to typed errors without leaking the token", async (t) => {
  const token = "secret-token-that-must-not-leak";
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["listCompanyDealAssociations", () => listCompanyDealAssociations(token, "900")],
    ["getDealWithHistory", () => getDealWithHistory(token, "501")],
    ["listDealPipelines", () => listDealPipelines(token)],
    ["getOwner", () => getOwner(token, "77")],
  ];
  const cases: Array<[string, () => void]> = [
    ["authentication_error", () => mockFetchSequence([[401, { message: `echo ${token}` }]])],
    ["permission_error", () => mockFetchSequence([[403, { message: `echo ${token}` }]])],
    ["rate_limited", () => mockFetchSequence([[429, { message: `echo ${token}` }]])],
    [
      "timeout",
      () => {
        globalThis.fetch = (async () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }) as typeof fetch;
      },
    ],
  ];

  for (const [name, call] of calls) {
    for (const [code, arrange] of cases) {
      await t.test(`${name} ${code}`, async () => {
        arrange();
        await assert.rejects(call, (error: unknown) => {
          assert.ok(error instanceof HubSpotProviderError);
          assert.equal(error.code, code);
          assert.equal(error.message.includes(token), false);
          assert.equal(String(error.stack).includes(token), false);
          return true;
        });
      });
    }
  }
});

test("testConnection keeps its generic message for a 404", async () => {
  mockFetchOnce(404, {});
  assert.deepEqual(await testConnection("private-token"), { ok: false, message: "HubSpot returned an unexpected error." });
});
