// Pure unit tests for Channel Chief's deterministic tie-breaking comparators
// (channelChiefContextService.ts's compareRecruitmentRank/
// comparePortfolioAttentionRank) and a structural guard for the
// FX-unavailable error contract. No live DB, no live server -- see
// tests/channelChiefAuth.test.ts for the auth unit tests and
// tests/channelChief.test.ts for the full live-server suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareRecruitmentRank, comparePortfolioAttentionRank } from "../src/services/channelChiefContextService";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

// ---- compareRecruitmentRank ------------------------------------------------

test("compareRecruitmentRank: stalled items always rank before non-stalled, regardless of days_in_stage", () => {
  const stalled = { is_stalled: true, days_in_stage: 1, recruitment_id: "b" };
  const notStalled = { is_stalled: false, days_in_stage: 100, recruitment_id: "a" };
  assert.ok(compareRecruitmentRank(stalled, notStalled) < 0);
  assert.ok(compareRecruitmentRank(notStalled, stalled) > 0);
});

test("compareRecruitmentRank: among equally-stalled items, longer days_in_stage ranks first", () => {
  const longer = { is_stalled: true, days_in_stage: 40, recruitment_id: "b" };
  const shorter = { is_stalled: true, days_in_stage: 20, recruitment_id: "a" };
  assert.ok(compareRecruitmentRank(longer, shorter) < 0);
});

test("compareRecruitmentRank: exact ties (same is_stalled and same days_in_stage) break deterministically by id ascending, regardless of input order", () => {
  const first = { is_stalled: true, days_in_stage: 20, recruitment_id: "aaa" };
  const second = { is_stalled: true, days_in_stage: 20, recruitment_id: "bbb" };
  const forward = [second, first].sort(compareRecruitmentRank);
  const backward = [first, second].sort(compareRecruitmentRank);
  assert.deepEqual(forward.map((r) => r.recruitment_id), ["aaa", "bbb"]);
  assert.deepEqual(backward.map((r) => r.recruitment_id), ["aaa", "bbb"]);
});

// ---- comparePortfolioAttentionRank ------------------------------------------

test("comparePortfolioAttentionRank: never-contacted (null) sorts before any real last_interaction_at", () => {
  const neverContacted = { last_interaction_at: null, relationship_id: "b" };
  const contacted = { last_interaction_at: "2026-01-01T00:00:00.000Z", relationship_id: "a" };
  assert.ok(comparePortfolioAttentionRank(neverContacted, contacted) < 0);
});

test("comparePortfolioAttentionRank: older last_interaction_at sorts first", () => {
  const older = { last_interaction_at: "2026-01-01T00:00:00.000Z", relationship_id: "b" };
  const newer = { last_interaction_at: "2026-06-01T00:00:00.000Z", relationship_id: "a" };
  assert.ok(comparePortfolioAttentionRank(older, newer) < 0);
});

test("comparePortfolioAttentionRank: exact ties (both null, or same real timestamp) break deterministically by id ascending, regardless of input order", () => {
  const firstNull = { last_interaction_at: null, relationship_id: "aaa" };
  const secondNull = { last_interaction_at: null, relationship_id: "bbb" };
  assert.deepEqual([secondNull, firstNull].sort(comparePortfolioAttentionRank).map((r) => r.relationship_id), ["aaa", "bbb"]);
  assert.deepEqual([firstNull, secondNull].sort(comparePortfolioAttentionRank).map((r) => r.relationship_id), ["aaa", "bbb"]);

  const timestamp = "2026-01-01T00:00:00.000Z";
  const tiedA = { last_interaction_at: timestamp, relationship_id: "ccc" };
  const tiedB = { last_interaction_at: timestamp, relationship_id: "ddd" };
  assert.deepEqual([tiedB, tiedA].sort(comparePortfolioAttentionRank).map((r) => r.relationship_id), ["ccc", "ddd"]);
});

// ---- structural guard: FX-unavailable must map to the same 503 contract routes/kpis.ts uses ----

test("routes/channel_chief.ts imports FxUnavailableError from services/fx and maps it to a 503 response, matching routes/kpis.ts's contract", () => {
  const source = readFileSync(path.join(SRC_DIR, "routes/channel_chief.ts"), "utf8");
  assert.ok(
    /import\s*\{[^}]*FxUnavailableError[^}]*\}\s*from\s*["']\.\.\/services\/fx["']/.test(source),
    "must import FxUnavailableError from ../services/fx",
  );
  assert.ok(/err instanceof FxUnavailableError/.test(source), "must branch on FxUnavailableError specifically");
  assert.ok(/res\.status\(503\)/.test(source), "must respond 503, matching routes/kpis.ts's FxUnavailableError handling");
});
