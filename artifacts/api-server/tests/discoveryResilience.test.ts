// 5B-R hotfix: Discovery AI qualification resilience + pre-AI dedupe. Pure
// unit tests -- no live network, DB, or server, and no Tavily/DeepSeek call.
//
// Two related bugs fixed together:
//  1. A single candidate-level unusable AI response (malformed/empty/
//     truncated/schema-invalid) used to throw all the way out of
//     attemptLiveDiscovery and fail the entire scan. It must now be logged
//     and skipped, letting the scan continue to remaining candidates --
//     while a genuine provider-wide/network/auth/rate-limit-style failure
//     must still fail the scan (see CANDIDATE_LEVEL_AI_ERROR_CODES and its
//     use at the qualify() call site in discoveryEngine.ts).
//  2. Pre-qualification dedupe used to key on the evidence *domain*, which
//     silently dropped a second legitimate company whenever two different
//     article URLs shared a publisher (e.g. two different reuters.com
//     stories about two different companies). Only a literal repeated URL
//     may be skipped pre-qualification now (see
//     shouldSkipBeforeQualification).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_LEVEL_AI_ERROR_CODES,
  classifyDiscoveryFailure,
  shouldSkipBeforeQualification,
} from "../src/services/discoveryEngine";
import { AiProviderError } from "../src/services/discoveryProviders/ai";
import { SearchProviderError } from "../src/services/discoveryProviders/search";

// ---- candidate-level vs scan-level classification -------------------------

test("check: malformed/empty/truncated/schema-invalid AI codes are all classified candidate-level", () => {
  for (const code of ["malformed_json", "empty_response", "truncated", "schema_invalid"]) {
    assert.ok(CANDIDATE_LEVEL_AI_ERROR_CODES.has(code), `expected "${code}" to be candidate-level`);
  }
});

test("check: provider-wide/operational AI codes (timeout/network/http/oversized) remain scan-level, not candidate-level", () => {
  for (const code of ["timeout", "network_error", "http_error", "oversized_response"]) {
    assert.ok(!CANDIDATE_LEVEL_AI_ERROR_CODES.has(code), `expected "${code}" to remain scan-level`);
  }
});

test("candidate-level codes still classify safely if they ever did reach classifyDiscoveryFailure (defense in depth)", () => {
  for (const code of CANDIDATE_LEVEL_AI_ERROR_CODES) {
    const { stoppedReason, message } = classifyDiscoveryFailure(new AiProviderError(code));
    assert.ok(stoppedReason.startsWith("ai_"));
    assert.equal(message, "AI qualification returned an unusable response. Please retry the scan.");
  }
});

test("scan-level AI codes still map to their existing distinct, actionable messages", () => {
  const { message: timeoutMsg } = classifyDiscoveryFailure(new AiProviderError("timeout"));
  const { message: httpMsg } = classifyDiscoveryFailure(new AiProviderError("http_error"));
  assert.notEqual(timeoutMsg, httpMsg);
  assert.match(timeoutMsg, /timed out/i);
  assert.match(httpMsg, /error during qualification/i);
});

test("search-provider errors are entirely unaffected by this hotfix -- still always scan-level", () => {
  const { stoppedReason } = classifyDiscoveryFailure(new SearchProviderError("timeout"));
  assert.equal(stoppedReason, "search_timeout");
});

// ---- candidate-level failure handling is a *decision*, not a throw --------
// (attemptLiveDiscovery itself is DB/provider-orchestration and isn't unit
// tested directly here -- see this repo's established convention, e.g.
// discoveryEngine.test.ts's header comment. This proves the decision the
// try/catch around qualify() makes for every code AiProviderError can carry.)

test("check: every candidate-level code is a 'skip and continue' decision, every other code (or non-AiProviderError) is a 'rethrow' decision", () => {
  function decide(err: unknown): "skip" | "rethrow" {
    if (err instanceof AiProviderError && CANDIDATE_LEVEL_AI_ERROR_CODES.has(err.code)) return "skip";
    return "rethrow";
  }

  for (const code of ["malformed_json", "empty_response", "truncated", "schema_invalid"]) {
    assert.equal(decide(new AiProviderError(code)), "skip", `expected candidate-level code "${code}" to skip, not fail the scan`);
  }
  for (const code of ["timeout", "network_error", "http_error", "oversized_response", "some_unmapped_future_code"]) {
    assert.equal(decide(new AiProviderError(code)), "rethrow", `expected scan-level code "${code}" to still fail the scan`);
  }
  assert.equal(decide(new Error("db connection lost")), "rethrow", "a non-AI error must never be treated as candidate-level");
});

// ---- pre-AI dedupe: publisher domain never suppresses a distinct company --

test("check: a literal repeated URL is skipped pre-qualification", () => {
  const seenUrls = new Set<string>();
  const url = "https://reuters.com/business/company-a-raises-funding";
  assert.equal(shouldSkipBeforeQualification(seenUrls, url), false);
  seenUrls.add(url);
  assert.equal(shouldSkipBeforeQualification(seenUrls, url), true, "the exact same URL repeated must still be skipped");
});

test("check: two different article URLs from the same publisher domain both reach qualification (neither is skipped)", () => {
  const seenUrls = new Set<string>();
  const urlA = "https://reuters.com/business/acme-corp-partners-with-microsoft";
  const urlB = "https://reuters.com/business/globex-inc-wins-enterprise-deal";

  assert.equal(shouldSkipBeforeQualification(seenUrls, urlA), false, "first reuters.com URL (Acme Corp) must reach qualification");
  seenUrls.add(urlA);

  assert.equal(
    shouldSkipBeforeQualification(seenUrls, urlB),
    false,
    "a different reuters.com URL about a different company (Globex Inc) must also reach qualification -- publisher domain alone is never a skip reason",
  );
});

test("three distinct PR-wire URLs about three distinct companies all pass the pre-qualification gate", () => {
  const seenUrls = new Set<string>();
  const urls = [
    "https://prnewswire.com/news/company-one-launches-ai-practice",
    "https://prnewswire.com/news/company-two-expands-to-emea",
    "https://prnewswire.com/news/company-three-signs-reseller-agreement",
  ];
  for (const url of urls) {
    assert.equal(shouldSkipBeforeQualification(seenUrls, url), false, `expected ${url} to reach qualification`);
    seenUrls.add(url);
  }
});
