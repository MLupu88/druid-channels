// Pure unit tests for Stage 6.4 PAM Workspace Copilot's deterministic
// pieces: intent routing, App Guide keyword matching, the shared
// "needs attention" rule, and the DeepSeek provider boundary's
// parse/validate behavior against a mocked fetch. No live server, database,
// or network call -- see the 6.4 report for why DB-touching context-builder
// functions (getPamWorkspaceSummary, resolveMentionedCompany, etc.) are
// instead covered by the live smoke checks, matching this repo's
// established convention (reused/trusted patterns + one live pass, not a
// second DB-mocking layer).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/services/copilotIntent";
import { getAppGuideContext, APP_GUIDE } from "../src/services/appGuide";
import { isNeedingAttention } from "../src/services/partnerRelationshipService";
import { chatViaDeepSeek, CopilotProviderError } from "../src/services/copilotProvider";

const originalFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

// ---- classifyIntent (check G/H: deterministic how_to vs operational routing) ----

test("classifyIntent: recognizes how-to phrasing regardless of case", () => {
  assert.equal(classifyIntent("How do I import my partner book?"), "how_to");
  assert.equal(classifyIntent("where do i log a meeting"), "how_to");
  assert.equal(classifyIntent("What is the difference between Discovery and Radar?"), "how_to");
  assert.equal(classifyIntent("HOW TO update a recruitment status"), "how_to");
});

test("classifyIntent: operational questions never match a how-to pattern", () => {
  assert.equal(classifyIntent("What should I focus on?"), "operational");
  assert.equal(classifyIntent("Why am I behind target?"), "operational");
  assert.equal(classifyIntent("Which recruitment opportunities need attention?"), "operational");
  assert.equal(classifyIntent("What should I do next with Accenture?"), "operational");
});

// ---- getAppGuideContext (check G: how-to gets App Guide context, bounded, never fabricated) ----

test("getAppGuideContext: matches the relevant section(s) via keywords, not the entire guide", () => {
  const result = getAppGuideContext("How do I move a prospect into Recruitment?");
  assert.ok(result.length > 0);
  assert.ok(result.length < APP_GUIDE.length, "expected a bounded subset, not a full dump for a specific question");
  assert.ok(result.some((e) => e.key === "recruitment"));
});

test("getAppGuideContext: an unmatched query still returns the (small, bounded) full guide rather than nothing", () => {
  const result = getAppGuideContext("asdkjfhaslkdjfh nonsense query");
  assert.deepEqual(result, APP_GUIDE);
});

test("getAppGuideContext: every entry has a real route and non-empty purpose -- never a placeholder", () => {
  for (const entry of APP_GUIDE) {
    assert.ok(entry.route.length > 0);
    assert.ok(entry.purpose.length > 0);
  }
});

// ---- isNeedingAttention (shared Portfolio/Copilot "needs attention" rule) ----

test("isNeedingAttention: active, no next action, never interacted -> true", () => {
  assert.equal(isNeedingAttention({ status: "active", nextAction: null, lastInteractionAt: null }), true);
});

test("isNeedingAttention: active, no next action, but interacted recently -> false", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const recent = new Date("2026-08-05T00:00:00.000Z");
  assert.equal(isNeedingAttention({ status: "active", nextAction: null, lastInteractionAt: recent }, now), false);
});

test("isNeedingAttention: active, no next action, interacted over 30 days ago -> true", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const stale = new Date("2026-06-01T00:00:00.000Z");
  assert.equal(isNeedingAttention({ status: "active", nextAction: null, lastInteractionAt: stale }, now), true);
});

test("isNeedingAttention: a next action is already set -> false, regardless of last interaction", () => {
  assert.equal(isNeedingAttention({ status: "active", nextAction: "Send proposal", lastInteractionAt: null }), false);
});

test("isNeedingAttention: dormant/closed relationships are never flagged, even if stale", () => {
  assert.equal(isNeedingAttention({ status: "dormant", nextAction: null, lastInteractionAt: null }), false);
  assert.equal(isNeedingAttention({ status: "closed", nextAction: null, lastInteractionAt: null }), false);
});

// ---- copilotProvider (DeepSeek boundary -- check J: clean failure, never a raw exception) ----

test("chatViaDeepSeek parses a valid reply, including bounded evidence/follow_ups", () => {
  process.env.AI_API_KEY = "test-key";
  const validReply = {
    answer: "You're currently 2 signed partners behind the Q3 target.",
    evidence: [{ label: "Q3 Signed Partners target", value: "5" }],
    suggested_route: "/recruitment",
    follow_ups: ["Which recruitments need attention?"],
  };
  mockFetchOnce(200, { choices: [{ message: { content: JSON.stringify(validReply) }, finish_reason: "stop" }] });

  return chatViaDeepSeek({ intent: "operational", question: "Why am I behind target?" }).then((result) => {
    assert.equal(result.answer, validReply.answer);
    assert.equal(result.suggested_route, "/recruitment");
    assert.deepEqual(result.evidence, validReply.evidence);
    assert.deepEqual(result.follow_ups, validReply.follow_ups);
  });
});

test("chatViaDeepSeek throws CopilotProviderError on malformed model output, never a raw exception", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, { choices: [{ message: { content: "not valid json" }, finish_reason: "stop" } ] });

  await assert.rejects(() => chatViaDeepSeek({ intent: "how_to", question: "How do I import my book?" }), CopilotProviderError);
});

test("chatViaDeepSeek throws CopilotProviderError on a non-2xx provider response", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(500, { error: "internal" });

  await assert.rejects(() => chatViaDeepSeek({ intent: "operational", question: "What should I focus on?" }), CopilotProviderError);
});

test("chatViaDeepSeek rejects a reply whose shape doesn't match the schema (e.g. missing required field)", async () => {
  process.env.AI_API_KEY = "test-key";
  mockFetchOnce(200, {
    choices: [{ message: { content: JSON.stringify({ answer: "ok" }) }, finish_reason: "stop" }],
  });

  await assert.rejects(() => chatViaDeepSeek({ intent: "operational", question: "What should I focus on?" }), CopilotProviderError);
});
