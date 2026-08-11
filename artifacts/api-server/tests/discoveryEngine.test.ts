// Pure unit tests for the Discovery reliability/diagnostics production
// hotfix: classifyDiscoveryFailure's safe (stoppedReason, message) mapping.
// No live server, database, or network call -- classifyDiscoveryFailure
// takes a plain Error instance, never a real provider response.
//
// Incremental progress persistence (writeScanRunProgress, and
// runDiscoveryForConfig's catch path never resetting counters) is DB-
// touching orchestration logic and, per this repo's established convention
// (see channelRadarEngine/discoveryBudget test file headers), is not
// unit-tested against a live DB here -- it's verified by code review (the
// catch path's .set() call structurally never includes the counter fields)
// and by the live release smoke pass, not by a second DB-mocking layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDiscoveryFailure, qualifyChecks } from "../src/services/discoveryEngine";
import { AiProviderError } from "../src/services/discoveryProviders/ai";
import { SearchProviderError, SearchNotImplementedError } from "../src/services/discoveryProviders/search";
import { ExtractionNotImplementedError } from "../src/services/discoveryProviders/extraction";
import { AiNotImplementedError } from "../src/services/discoveryProviders/ai";
import { SCAN_RUN_STOPPED_REASONS } from "@workspace/db";

// ---- check: all supported AI provider codes map to a bounded stopped_reason ----

const AI_CODE_TO_REASON: Record<string, string> = {
  timeout: "ai_timeout",
  network_error: "ai_network_error",
  http_error: "ai_http_error",
  oversized_response: "ai_oversized_response",
  malformed_json: "ai_malformed_response",
  empty_response: "ai_empty_response",
  truncated: "ai_truncated_response",
  schema_invalid: "ai_schema_invalid",
};

for (const [code, expectedReason] of Object.entries(AI_CODE_TO_REASON)) {
  test(`check: AiProviderError code "${code}" maps to stopped_reason "${expectedReason}"`, () => {
    const { stoppedReason } = classifyDiscoveryFailure(new AiProviderError(code));
    assert.equal(stoppedReason, expectedReason);
    assert.ok(SCAN_RUN_STOPPED_REASONS.includes(stoppedReason as any), "stoppedReason must be one of the bounded enum values");
  });
}

test("check: AI timeout produces the exact required user-facing message", () => {
  const { message } = classifyDiscoveryFailure(new AiProviderError("timeout"));
  assert.equal(
    message,
    "AI qualification timed out. Search work completed, but qualification did not finish in time. Please retry the scan.",
  );
});

test("check: AI http_error produces the exact required user-facing message", () => {
  const { message } = classifyDiscoveryFailure(new AiProviderError("http_error"));
  assert.equal(message, "The AI provider returned an error during qualification. Please retry or check the AI connection in Admin.");
});

test("check: schema_invalid/malformed/empty/truncated all share the required 'unusable response' message", () => {
  const sharedMessage = "AI qualification returned an unusable response. Please retry the scan.";
  for (const code of ["schema_invalid", "malformed_json", "empty_response", "truncated"]) {
    assert.equal(classifyDiscoveryFailure(new AiProviderError(code)).message, sharedMessage, `code=${code}`);
  }
});

// ---- search-provider equivalent mapping -----------------------------------

const SEARCH_CODE_TO_REASON: Record<string, string> = {
  timeout: "search_timeout",
  network_error: "search_network_error",
  http_error: "search_http_error",
  oversized_response: "search_oversized_response",
  malformed_json: "search_malformed_response",
  malformed_response: "search_malformed_response",
};

for (const [code, expectedReason] of Object.entries(SEARCH_CODE_TO_REASON)) {
  test(`check: SearchProviderError code "${code}" maps to a bounded stopped_reason "${expectedReason}"`, () => {
    const { stoppedReason } = classifyDiscoveryFailure(new SearchProviderError(code));
    assert.equal(stoppedReason, expectedReason);
    assert.ok(SCAN_RUN_STOPPED_REASONS.includes(stoppedReason as any));
  });
}

// ---- check: raw provider errors are never persisted ------------------------

test("check: an unrecognized AiProviderError code falls back to a safe generic message/reason, never the raw code text", () => {
  const weirdCode = "<script>DROP TABLE prospects; -- raw provider junk";
  const { stoppedReason, message } = classifyDiscoveryFailure(new AiProviderError(weirdCode));
  assert.equal(stoppedReason, "error");
  assert.equal(message, "AI qualification call failed. Please try again.");
  assert.ok(!message.includes(weirdCode));
});

test("check: an unrecognized SearchProviderError code falls back to a safe generic message/reason", () => {
  const { stoppedReason, message } = classifyDiscoveryFailure(new SearchProviderError("some_new_unmapped_code"));
  assert.equal(stoppedReason, "error");
  assert.equal(message, "Web search provider call failed. Please try again.");
});

test("check: a plain/unknown Error (e.g. a DB error) never leaks its raw message -- always the generic safe fallback", () => {
  const dbError = new Error("connection to server at \"prod-db-host\" failed: password authentication failed for user \"app\"");
  const { stoppedReason, message } = classifyDiscoveryFailure(dbError);
  assert.equal(stoppedReason, "error");
  assert.equal(message, "Discovery scan could not be completed. Please try again or contact an administrator.");
  assert.ok(!message.includes("prod-db-host"));
  assert.ok(!message.includes("password"));
});

test("*NotImplementedError classifications remain safe and unrelated to provider text", () => {
  assert.deepEqual(classifyDiscoveryFailure(new SearchNotImplementedError()), { stoppedReason: "error", message: "Search provider not connected." });
  assert.deepEqual(classifyDiscoveryFailure(new ExtractionNotImplementedError()), {
    stoppedReason: "error",
    message: "Page extraction provider not connected.",
  });
  assert.deepEqual(classifyDiscoveryFailure(new AiNotImplementedError()), { stoppedReason: "error", message: "AI qualification provider not connected." });
});

// ---- unchanged qualification bar (sanity check, not a new behavior) -------

test("qualifyChecks is untouched by this hotfix -- same verdict for the same evidence", () => {
  // 3 of 5 checks passed (enterprise_access, relevant_capability,
  // partnership_openness) -- Priority B per the existing, unchanged
  // qualifyChecks rule (4+ checks with openness/trigger is required for A).
  const checks = { enterpriseAccess: true, relevantCapability: true, technologyAdjacency: false, partnershipOpenness: true, recentTrigger: false };
  const a = qualifyChecks(checks, 3);
  const b = qualifyChecks(checks, 3);
  assert.deepEqual(a, b);
  assert.equal(a.priority, "B");
});
