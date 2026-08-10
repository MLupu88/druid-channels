// Pure unit tests for Stage 6.2 Team/My Targets progress/status boundary
// logic -- no live network, DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTargetProgress } from "../src/services/targetService";

test("no target configured -> no_target status, never treated as a target of zero", () => {
  const result = computeTargetProgress(11, null);
  assert.equal(result.status, "no_target");
  assert.equal(result.progress_percent, null);
});

test("actual exactly meeting target is ahead, not behind", () => {
  assert.equal(computeTargetProgress(5, 5).status, "ahead");
});

test("actual exceeding target is ahead", () => {
  const result = computeTargetProgress(22, 20);
  assert.equal(result.status, "ahead");
  assert.equal(result.progress_percent, 110);
});

test("actual below target is behind, with rounded progress_percent", () => {
  const result = computeTargetProgress(11, 15);
  assert.equal(result.status, "behind");
  assert.equal(result.progress_percent, 73);
});

test("null actual (no live data) is treated as zero for status, but progress_percent stays null", () => {
  const result = computeTargetProgress(null, 5);
  assert.equal(result.status, "behind");
  assert.equal(result.progress_percent, null);
});

test("zero target never divides by zero -- progress_percent stays null even with a target row present", () => {
  const result = computeTargetProgress(3, 0);
  assert.equal(result.progress_percent, null);
  assert.equal(result.status, "ahead"); // 3 >= 0
});
