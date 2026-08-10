// Pure unit tests for Stage 6 import row match-status prioritization and
// batch count aggregation -- no live network, DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMatchStatus, computeBatchCounts } from "../src/services/portfolioImportEngine";

test("no company name at all -> invalid, regardless of everything else", () => {
  const status = resolveMatchStatus({ hasCompanyName: false, deterministicStatus: "ready", hasExistingRelationship: true, needsReview: true });
  assert.equal(status, "invalid");
});

test("existing_relationship beats a clean matched_existing_company classification", () => {
  const status = resolveMatchStatus({ hasCompanyName: true, deterministicStatus: "matched_existing_company", hasExistingRelationship: true, needsReview: false });
  assert.equal(status, "existing_relationship");
});

test("possible_duplicate is never silently resolved by a low-confidence DeepSeek pass", () => {
  const status = resolveMatchStatus({ hasCompanyName: true, deterministicStatus: "possible_duplicate", hasExistingRelationship: false, needsReview: false });
  assert.equal(status, "possible_duplicate");
});

test("needs_review (DeepSeek-flagged ambiguity) surfaces even when company matching itself was clean", () => {
  const status = resolveMatchStatus({ hasCompanyName: true, deterministicStatus: "ready", hasExistingRelationship: false, needsReview: true });
  assert.equal(status, "needs_review");
});

test("clean match with no ambiguity passes through as-is", () => {
  assert.equal(
    resolveMatchStatus({ hasCompanyName: true, deterministicStatus: "matched_existing_company", hasExistingRelationship: false, needsReview: false }),
    "matched_existing_company",
  );
  assert.equal(resolveMatchStatus({ hasCompanyName: true, deterministicStatus: "ready", hasExistingRelationship: false, needsReview: false }), "ready");
});

test("computeBatchCounts tallies every match_status bucket, including zero counts", () => {
  const counts = computeBatchCounts([
    { matchStatus: "ready" },
    { matchStatus: "ready" },
    { matchStatus: "needs_review" },
    { matchStatus: "existing_relationship" },
  ]);
  assert.deepEqual(counts, {
    ready: 2,
    matched_existing_company: 0,
    possible_duplicate: 0,
    existing_relationship: 1,
    needs_review: 1,
    invalid: 0,
  });
});
