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

// ---- Phase 11.5C.3: DRUID VERIFIED CONTEXT grounding -----------------------

function mockFetchCapturingSystemPrompt(capture: (systemPrompt: string) => void) {
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    capture(body.messages[0].content);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(validSignal) }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

test("qualifySignalViaDeepSeek: with druidContext supplied, the system prompt contains a separated DRUID VERIFIED CONTEXT section stating external facts still require Evidence, and that DRUID context may only inform strategic interpretation/recommended motion", async () => {
  let capturedSystemPrompt = "";
  mockFetchCapturingSystemPrompt((p) => { capturedSystemPrompt = p; });

  await qualifySignalViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://acme.example/news/acquisition", text: "Acme announced the acquisition...", title: "Acme acquires AI consultancy" }],
    druidContext: "[technology_ecosystem]\n- DRUID integrates with major CCaaS platforms.",
  });

  assert.ok(capturedSystemPrompt.includes("DRUID VERIFIED CONTEXT is trusted background about DRUID itself."), "must include the framing sentence");
  assert.ok(
    capturedSystemPrompt.includes("All factual claims about the external company/event must still come from the supplied Evidence."),
    "must state external facts still require Evidence -- this is the strict boundary that must never be relaxed",
  );
  assert.ok(
    capturedSystemPrompt.includes(
      "You MAY use DRUID VERIFIED CONTEXT only to interpret the strategic relevance of externally evidenced facts to DRUID and to formulate DRUID-specific implications or recommended partner motion.",
    ),
    "must explicitly allow DRUID context to inform strategic interpretation/recommended motion -- the corrected, non-useless framing",
  );
  assert.ok(
    capturedSystemPrompt.includes("It must never substitute for missing Evidence or increase factual confidence in an unsupported external claim."),
    "must include the anti-substitution/anti-confidence-inflation rule",
  );
  assert.ok(
    capturedSystemPrompt.includes("DRUID VERIFIED CONTEXT:\n[technology_ecosystem]\n- DRUID integrates with major CCaaS platforms."),
    "must include the actual formatted context block, clearly labeled",
  );
  // The existing "evidence... your ONLY source of truth" rule must survive
  // unchanged, and the DRUID section must precede it (background first).
  const contextIndex = capturedSystemPrompt.indexOf("DRUID VERIFIED CONTEXT is trusted background");
  const rulesIndex = capturedSystemPrompt.indexOf("You will be given:");
  assert.ok(contextIndex > -1 && rulesIndex > -1 && contextIndex < rulesIndex, "DRUID context must appear before the existing rules text");
  assert.ok(
    capturedSystemPrompt.includes("evidence: one or more {url, title, text} items -- your ONLY source of truth."),
    "the existing evidence-is-the-only-source-of-truth rule must remain unchanged",
  );
});

test("qualifySignalViaDeepSeek: with druidContext omitted or '', the system prompt is byte-identical to the pre-11.5C.3 baseline (no DRUID VERIFIED CONTEXT section)", async () => {
  let promptWithOmittedField = "";
  mockFetchCapturingSystemPrompt((p) => { promptWithOmittedField = p; });
  await qualifySignalViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://acme.example/news/acquisition", text: "Acme announced the acquisition...", title: "Acme acquires AI consultancy" }],
  });

  let promptWithEmptyString = "";
  mockFetchCapturingSystemPrompt((p) => { promptWithEmptyString = p; });
  await qualifySignalViaDeepSeek("test-key", {
    entityHint: "Acme Systems",
    territoryName: "UK & Ireland",
    evidence: [{ url: "https://acme.example/news/acquisition", text: "Acme announced the acquisition...", title: "Acme acquires AI consultancy" }],
    druidContext: "",
  });

  assert.equal(promptWithOmittedField, promptWithEmptyString, "omitting druidContext and passing '' must produce identical prompts");
  assert.ok(!promptWithOmittedField.includes("DRUID VERIFIED CONTEXT"), "baseline prompt must never contain a DRUID VERIFIED CONTEXT section");
  assert.ok(
    promptWithOmittedField.startsWith(
      "You are an intelligence analyst for a channel/alliances team at DRUID, an enterprise conversational/agentic AI platform vendor.",
    ),
    "baseline prompt must start with the exact original intro sentence",
  );
  assert.ok(
    promptWithOmittedField.includes("evidence: one or more {url, title, text} items -- your ONLY source of truth."),
    "existing evidence rule text must remain unchanged",
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
