// Partner Radar recall fix (first slice): pure unit tests for
// resolveMaxCandidatesToLlm/MAX_CANDIDATES_TO_LLM (discoveryBudget.ts). No
// live search, DB, or AI call -- discoveryBudget.ts has zero external
// imports, so this file needs no DATABASE_URL at all.
//
// Production evidence this fix responds to: a real run had
// unique_companies_seen=195, candidates_sent_to_llm=20 (the old hard cap),
// candidates_qualified=7 -- i.e. 7/20 (35%) of what was actually evaluated,
// not 7/195. This file proves the new pool size defaults to 50, is
// configurable, and stays bounded by a hard ceiling -- it does not touch
// qualifyChecks or any other qualification logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMaxCandidatesToLlm,
  DEFAULT_MAX_CANDIDATES_TO_LLM,
  MAX_CANDIDATES_TO_LLM_CEILING,
  MAX_CANDIDATES_TO_LLM,
} from "../src/services/discoveryBudget";

// ---- default ---------------------------------------------------------------

test("default pool size is 50", () => {
  assert.equal(DEFAULT_MAX_CANDIDATES_TO_LLM, 50);
});

test("resolveMaxCandidatesToLlm(undefined) falls back to the default", () => {
  assert.equal(resolveMaxCandidatesToLlm(undefined), DEFAULT_MAX_CANDIDATES_TO_LLM);
});

test("resolveMaxCandidatesToLlm('') (empty string, e.g. an unset compose env var) falls back to the default", () => {
  assert.equal(resolveMaxCandidatesToLlm(""), DEFAULT_MAX_CANDIDATES_TO_LLM);
});

test("MAX_CANDIDATES_TO_LLM (the value every call site actually uses) is the default when no override is configured in this test process", () => {
  assert.equal(MAX_CANDIDATES_TO_LLM, DEFAULT_MAX_CANDIDATES_TO_LLM);
});

// ---- valid override ---------------------------------------------------------

test("resolveMaxCandidatesToLlm('30') honors a valid, smaller override", () => {
  assert.equal(resolveMaxCandidatesToLlm("30"), 30);
});

test("resolveMaxCandidatesToLlm('75') honors a valid override between the default and the ceiling", () => {
  assert.equal(resolveMaxCandidatesToLlm("75"), 75);
});

// ---- invalid input falls back to the default, never throws ----------------

test("resolveMaxCandidatesToLlm('0') falls back to the default -- zero is not a usable pool size", () => {
  assert.equal(resolveMaxCandidatesToLlm("0"), DEFAULT_MAX_CANDIDATES_TO_LLM);
});

test("resolveMaxCandidatesToLlm('-10') falls back to the default -- a negative pool size must never propagate", () => {
  assert.equal(resolveMaxCandidatesToLlm("-10"), DEFAULT_MAX_CANDIDATES_TO_LLM);
});

test("resolveMaxCandidatesToLlm('20.5') falls back to the default -- a non-integer count is invalid, not rounded", () => {
  assert.equal(resolveMaxCandidatesToLlm("20.5"), DEFAULT_MAX_CANDIDATES_TO_LLM);
});

test("resolveMaxCandidatesToLlm('not-a-number') falls back to the default -- a malformed env var must never crash a scan", () => {
  assert.equal(resolveMaxCandidatesToLlm("not-a-number"), DEFAULT_MAX_CANDIDATES_TO_LLM);
});

// ---- upper safety bound -----------------------------------------------------

test("hard ceiling is 100", () => {
  assert.equal(MAX_CANDIDATES_TO_LLM_CEILING, 100);
});

test("resolveMaxCandidatesToLlm('9999') clamps to the ceiling -- a bad/huge config value can never create unbounded LLM fan-out", () => {
  assert.equal(resolveMaxCandidatesToLlm("9999"), MAX_CANDIDATES_TO_LLM_CEILING);
});

test("resolveMaxCandidatesToLlm(String(ceiling)) at exactly the ceiling is honored as-is (boundary, not clamped down further)", () => {
  assert.equal(resolveMaxCandidatesToLlm(String(MAX_CANDIDATES_TO_LLM_CEILING)), MAX_CANDIDATES_TO_LLM_CEILING);
});

test("resolveMaxCandidatesToLlm(String(ceiling + 1)) just above the ceiling clamps down to the ceiling", () => {
  assert.equal(resolveMaxCandidatesToLlm(String(MAX_CANDIDATES_TO_LLM_CEILING + 1)), MAX_CANDIDATES_TO_LLM_CEILING);
});

test("the default itself is safely under the ceiling (sanity check on the two constants' relationship)", () => {
  assert.ok(DEFAULT_MAX_CANDIDATES_TO_LLM < MAX_CANDIDATES_TO_LLM_CEILING);
});
