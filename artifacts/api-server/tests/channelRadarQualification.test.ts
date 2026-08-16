// Pure unit tests for Stage 5 Channel Radar's DeepSeek qualification --
// no live network, DB, or server. fetch is mocked per-test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { qualifySignalViaDeepSeek, classifySameEventViaDeepSeek, RadarAiProviderError } from "../src/services/channelRadarProviders/ai";

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
  druid_partner_motion: null,
  confidence: "high",
  evidence_urls: ["https://acme.example/news/acquisition", "https://not-given.example/fabricated"],
  related_entity_name: "Nimbus AI Consulting",
  related_entity_type: "ecosystem",
  relationship_label: "acquired by Acme Systems",
  regional_applicability_certain: true,
};

test("qualifySignalViaDeepSeek parses a valid signal and filters invalid evidence URLs", async () => {
  mockFetchOnce(200, {
    choices: [{ message: { content: JSON.stringify(validSignal) }, finish_reason: "stop" }],
  });

  const result = await qualifySignalViaDeepSeek("test-key", {
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
  // Phase 10 fields round-trip.
  assert.equal(result.relatedEntityName, "Nimbus AI Consulting");
  assert.equal(result.relatedEntityType, "ecosystem");
  assert.equal(result.relationshipLabel, "acquired by Acme Systems");
  assert.equal(result.regionalApplicabilityCertain, true);
  assert.equal(result.druidPartnerMotion, null);
});

test("qualifySignalViaDeepSeek parses the new 'watch' implication", async () => {
  mockFetchOnce(200, {
    choices: [{ message: { content: JSON.stringify({ ...validSignal, implication: "watch" }) }, finish_reason: "stop" }],
  });

  const result = await qualifySignalViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://acme.example/news/acquisition", text: "evidence", title: "title" }],
  });

  assert.equal(result.implication, "watch");
});

test("qualifySignalViaDeepSeek parses the new signal_type/entity_type taxonomy values (partner_program, tender_rfp, technology_vendor)", async () => {
  mockFetchOnce(200, {
    choices: [{
      message: {
        content: JSON.stringify({ ...validSignal, signal_type: "partner_program", entity_type: "technology_vendor", related_entity_type: null, related_entity_name: null, relationship_label: null }),
      },
      finish_reason: "stop",
    }],
  });

  const result = await qualifySignalViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://acme.example/news/acquisition", text: "evidence", title: "title" }],
  });

  assert.equal(result.signalType, "partner_program");
  assert.equal(result.entityType, "technology_vendor");
  assert.equal(result.relatedEntityName, null);
  assert.equal(result.relatedEntityType, null);
});

test("qualifySignalViaDeepSeek: a tender_rfp signal with no named counterparty parses with all three related_entity_* fields null together", async () => {
  mockFetchOnce(200, {
    choices: [{
      message: { content: JSON.stringify({ ...validSignal, signal_type: "tender_rfp", related_entity_name: null, related_entity_type: null, relationship_label: null }) },
      finish_reason: "stop",
    }],
  });

  const result = await qualifySignalViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://acme.example/news/tender", text: "evidence", title: "title" }],
  });

  assert.equal(result.signalType, "tender_rfp");
  assert.equal(result.relatedEntityName, null);
  assert.equal(result.relatedEntityType, null);
  assert.equal(result.relationshipLabel, null);
});

test("qualifySignalViaDeepSeek honestly parses keep:false for weak/generic evidence", async () => {
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

  const result = await qualifySignalViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://news.example/generic", text: "generic market trend piece", title: "The state of enterprise software" }],
  });

  assert.equal(result.keep, false);
});

test("qualifySignalViaDeepSeek throws RadarAiProviderError on malformed model output", async () => {
  mockFetchOnce(200, {
    choices: [{ message: { content: "not valid json" }, finish_reason: "stop" }],
  });

  await assert.rejects(
    () =>
      qualifySignalViaDeepSeek("test-key", {
        entityHint: "Acme Systems",
        territoryName: "UK & Ireland",
        evidence: [{ url: "https://acme.example/news", text: "evidence", title: "title" }],
      }),
    RadarAiProviderError,
  );
});

test("qualifySignalViaDeepSeek throws RadarAiProviderError on a non-2xx response", async () => {
  mockFetchOnce(500, { error: "internal" });

  await assert.rejects(
    () =>
      qualifySignalViaDeepSeek("test-key", {
        entityHint: "Acme Systems",
        territoryName: "UK & Ireland",
        evidence: [{ url: "https://acme.example/news", text: "evidence", title: "title" }],
      }),
    RadarAiProviderError,
  );
});

// ---- Phase 10: bounded cross-run same-event classification -----------------

const sameEventCandidate = {
  headline: "Acme Systems acquires boutique AI consultancy",
  summary: "Acme announced the acquisition of a small AI consultancy.",
  sourceTitle: "Acme news",
  sourceUrl: "https://acme.example/news/acquisition",
};

test("classifySameEventViaDeepSeek parses same_event: true", async () => {
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify({ same_event: true }) }, finish_reason: "stop" }] });

  const result = await classifySameEventViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    candidate: sameEventCandidate,
    newEvidence: { url: "https://reuters.example/acme-deal", title: "Acme buys AI shop", text: "Acme Systems has acquired a boutique AI consultancy." },
  });

  assert.equal(result.sameEvent, true);
});

test("classifySameEventViaDeepSeek parses same_event: false", async () => {
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify({ same_event: false }) }, finish_reason: "stop" }] });

  const result = await classifySameEventViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    candidate: sameEventCandidate,
    newEvidence: { url: "https://reuters.example/acme-hire", title: "Acme hires new VP", text: "Acme Systems appointed a new VP of Alliances." },
  });

  assert.equal(result.sameEvent, false);
});

test("classifySameEventViaDeepSeek throws RadarAiProviderError on malformed model output -- caller must default to 'different event', not crash", async () => {
  mockFetchOnce(200, { choices: [{ message: { content: "not valid json" }, finish_reason: "stop" }] });

  await assert.rejects(
    () =>
      classifySameEventViaDeepSeek("test-key", {
        entityHint: "Acme Systems",
        candidate: sameEventCandidate,
        newEvidence: { url: "https://reuters.example/acme-deal", title: "title", text: "text" },
      }),
    RadarAiProviderError,
  );
});

test("classifySameEventViaDeepSeek throws RadarAiProviderError on a non-2xx response", async () => {
  mockFetchOnce(500, { error: "internal" });

  await assert.rejects(
    () =>
      classifySameEventViaDeepSeek("test-key", {
        entityHint: "Acme Systems",
        candidate: sameEventCandidate,
        newEvidence: { url: "https://reuters.example/acme-deal", title: "title", text: "text" },
      }),
    RadarAiProviderError,
  );
});
