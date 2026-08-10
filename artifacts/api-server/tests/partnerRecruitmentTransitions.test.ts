// Pure unit tests for Stage 4 recruitment stage-transition validation --
// no live network, DB, or server. isValidTransition/computeDaysInStage/
// isStalled/getNextStageAction are pure functions (plain objects/dates in,
// booleans/numbers out), so these are tested directly. This is the
// highest-risk logic in Stage 4: it's the only thing standing between the
// API and an arbitrary/invalid stage mutation from the frontend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidTransition, computeDaysInStage, isStalled, getNextStageAction } from "../src/services/partnerRecruitmentService";

test("the forward funnel is valid one step at a time", () => {
  assert.equal(isValidTransition({ stage: "accepted", previousStage: null }, "contacting"), true);
  assert.equal(isValidTransition({ stage: "contacting", previousStage: null }, "engaged"), true);
  assert.equal(isValidTransition({ stage: "engaged", previousStage: null }, "agreement"), true);
  assert.equal(isValidTransition({ stage: "agreement", previousStage: null }, "signed"), true);
});

test("skipping stages forward is rejected", () => {
  assert.equal(isValidTransition({ stage: "accepted", previousStage: null }, "engaged"), false);
  assert.equal(isValidTransition({ stage: "accepted", previousStage: null }, "agreement"), false);
  assert.equal(isValidTransition({ stage: "accepted", previousStage: null }, "signed"), false);
  assert.equal(isValidTransition({ stage: "contacting", previousStage: null }, "signed"), false);
});

test("moving backward through the funnel is rejected", () => {
  assert.equal(isValidTransition({ stage: "engaged", previousStage: null }, "contacting"), false);
  assert.equal(isValidTransition({ stage: "agreement", previousStage: null }, "accepted"), false);
});

test("any active stage can go on_hold or not_pursuing", () => {
  for (const stage of ["accepted", "contacting", "engaged", "agreement"] as const) {
    assert.equal(isValidTransition({ stage, previousStage: null }, "on_hold"), true, `${stage} -> on_hold`);
    assert.equal(isValidTransition({ stage, previousStage: null }, "not_pursuing"), true, `${stage} -> not_pursuing`);
  }
});

test("on_hold can only resume into its own previous_stage, never an arbitrary one", () => {
  const onHold = { stage: "on_hold", previousStage: "engaged" };
  assert.equal(isValidTransition(onHold, "engaged"), true);
  assert.equal(isValidTransition(onHold, "contacting"), false);
  assert.equal(isValidTransition(onHold, "signed"), false);
});

test("signed and not_pursuing are terminal -- no transition out of either", () => {
  for (const to of ["accepted", "contacting", "engaged", "agreement", "on_hold", "not_pursuing"] as const) {
    assert.equal(isValidTransition({ stage: "signed", previousStage: null }, to), false, `signed -> ${to}`);
  }
  for (const to of ["accepted", "contacting", "engaged", "agreement", "on_hold", "signed"] as const) {
    assert.equal(isValidTransition({ stage: "not_pursuing", previousStage: null }, to), false, `not_pursuing -> ${to}`);
  }
});

test("transitioning to the same stage is rejected", () => {
  assert.equal(isValidTransition({ stage: "contacting", previousStage: null }, "contacting"), false);
});

test("computeDaysInStage and isStalled agree on the > 14 day boundary", () => {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);

  assert.equal(isStalled("contacting", computeDaysInStage(fifteenDaysAgo)), true);
  assert.equal(isStalled("contacting", computeDaysInStage(fourteenDaysAgo)), false);
  // on_hold/signed/not_pursuing are never "stalled" regardless of days elapsed.
  assert.equal(isStalled("on_hold", computeDaysInStage(fifteenDaysAgo)), false);
  assert.equal(isStalled("signed", computeDaysInStage(fifteenDaysAgo)), false);
});

test("getNextStageAction returns the exact spec-labeled action per stage, and null for terminal/exception states", () => {
  assert.deepEqual(getNextStageAction("accepted"), { stage: "contacting", label: "Start outreach" });
  assert.deepEqual(getNextStageAction("contacting"), { stage: "engaged", label: "Mark engaged" });
  assert.deepEqual(getNextStageAction("engaged"), { stage: "agreement", label: "Start agreement" });
  assert.deepEqual(getNextStageAction("agreement"), { stage: "signed", label: "Mark signed" });
  assert.equal(getNextStageAction("signed"), null);
  assert.equal(getNextStageAction("on_hold"), null);
  assert.equal(getNextStageAction("not_pursuing"), null);
});
