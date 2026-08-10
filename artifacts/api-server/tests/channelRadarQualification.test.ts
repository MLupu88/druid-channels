// Pure unit tests for Stage 5 Channel Radar's DeepSeek qualification --
// no live network, DB, or server. fetch is mocked per-test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { qualifySignalViaDeepSeek, RadarAiProviderError } from "../src/services/channelRadarProviders/ai";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

const validSignal = {
  keep: true,
  entity_name: "Acme Systems",
  entity_type: "competitor",
  signal_type: "acquisition",
  headline: "Acme Systems acquires boutique AI consultancy",
  summary: "Acme announced the acquisition of a small AI consultancy to expand its agentic AI delivery capability.",
  why_it_matters: "Acme is building out AI delivery capacity in the same space DRUID competes in.",
  implication: "threat",
  impact: "medium",
  recommended_action: "Watch for Acme's next enterprise AI announcement and brief the territory PAM.",
  confidence: "high",
  evidence_urls: ["https://acme.example/news/acquisition", "https://not-given.example/fabricated"],
};

test("qualifySignalViaDeepSeek parses a valid signal and filters invalid evidence URLs", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, {
    choices: [{ message: { content: JSON.stringify(validSignal) }, finish_reason: "stop" }],
  });

  const result = await qualifySignalViaDeepSeek({
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://acme.example/news/acquisition", text: "Acme announced the acquisition...", title: "Acme acquires AI consultancy" }],
  });

  assert.equal(result.keep, true);
  assert.equal(result.entityName, "Acme Systems");
  assert.equal(result.signalType, "acquisition");
  assert.equal(result.implication, "threat");
  // The fabricated URL that wasn't part of the supplied evidence must be dropped.
  assert.deepEqual(result.evidenceUrls, ["https://acme.example/news/acquisition"]);
});

test("qualifySignalViaDeepSeek honestly parses keep:false for weak/generic evidence", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, {
    choices: [{
      message: {
        content: JSON.stringify({
          ...validSignal,
          keep: false,
          headline: "General market commentary",
          impact: "low",
          confidence: "low",
          evidence_urls: [],
        }),
      },
      finish_reason: "stop",
    }],
  });

  const result = await qualifySignalViaDeepSeek({
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://news.example/generic", text: "generic market trend piece", title: "The state of enterprise software" }],
  });

  assert.equal(result.keep, false);
});

test("qualifySignalViaDeepSeek throws RadarAiProviderError on malformed model output", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, {
    choices: [{ message: { content: "not valid json" }, finish_reason: "stop" }],
  });

  await assert.rejects(
    () =>
      qualifySignalViaDeepSeek({
        entityHint: "Acme Systems",
        territoryName: "UK & Ireland",
        evidence: [{ url: "https://acme.example/news", text: "evidence", title: "title" }],
      }),
    RadarAiProviderError,
  );
});

test("qualifySignalViaDeepSeek throws RadarAiProviderError on a non-2xx response", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(500, { error: "internal" });

  await assert.rejects(
    () =>
      qualifySignalViaDeepSeek({
        entityHint: "Acme Systems",
        territoryName: "UK & Ireland",
        evidence: [{ url: "https://acme.example/news", text: "evidence", title: "title" }],
      }),
    RadarAiProviderError,
  );
});
