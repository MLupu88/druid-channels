// 5B-R hotfix: Channel Radar's Run Radar button used to disappear entirely
// whenever a global user (Head/Admin) had "All territories" selected --
// previously the button's very presence in the DOM was gated on
// `!isGlobalUser || territory !== 'all'`. Pure unit tests for the replacement
// decision function -- no React rendering, no network.
//
// Phase 10: the authorization model changed -- triggering a Radar run
// spends paid provider credits, so a PAM (read-only Channel Radar access)
// must never see this button at all, regardless of territory. The
// global-user cases below are unchanged from 5B-R; the PAM cases were
// rewritten for the new contract (a PAM used to always see the button --
// that assumption no longer holds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRunRadarButtonState } from "../src/lib/channel-radar-run";

test("check: Head/Admin (global user) with 'All territories' selected still sees Run Radar, disabled with an explanation", () => {
  const state = computeRunRadarButtonState({ isGlobalUser: true, territory: "all", runTargetTerritoryId: null, isPending: false });
  assert.equal(state.visible, true, "the button must never disappear for a global user");
  assert.equal(state.disabled, true);
  assert.ok(state.title && state.title.length > 0, "a disabled button must explain why");
});

test("check: Head/Admin with a specific territory selected can run Radar normally", () => {
  const state = computeRunRadarButtonState({ isGlobalUser: true, territory: "territory-1", runTargetTerritoryId: "territory-1", isPending: false });
  assert.equal(state.visible, true);
  assert.equal(state.disabled, false);
  assert.equal(state.title, undefined);
});

test("check: Head/Admin's Run Radar disables (not hides) while a scan is already running", () => {
  const state = computeRunRadarButtonState({ isGlobalUser: true, territory: "territory-1", runTargetTerritoryId: "territory-1", isPending: true });
  assert.equal(state.visible, true);
  assert.equal(state.disabled, true);
});

// ---- Phase 10: PAM never sees the button ------------------------------

test("Phase 10: PAM never sees Run Radar, even with a resolved own-territory id", () => {
  const state = computeRunRadarButtonState({ isGlobalUser: false, territory: "all", runTargetTerritoryId: "own-territory-1", isPending: false });
  assert.equal(state.visible, false, "PAM Radar access is read-only in Phase 10 -- triggering a run spends paid provider credits");
});

test("Phase 10: PAM with no territory assigned still never sees Run Radar (not visible-but-disabled)", () => {
  const state = computeRunRadarButtonState({ isGlobalUser: false, territory: "all", runTargetTerritoryId: null, isPending: false });
  assert.equal(state.visible, false);
});

test("Phase 10: PAM never sees Run Radar regardless of the territory filter value or pending state", () => {
  const scenarios = [
    { isGlobalUser: false, territory: "all", runTargetTerritoryId: "own", isPending: false },
    { isGlobalUser: false, territory: "all", runTargetTerritoryId: "own", isPending: true },
    { isGlobalUser: false, territory: "own-territory-1", runTargetTerritoryId: "own-territory-1", isPending: false },
  ];
  for (const scenario of scenarios) {
    assert.equal(computeRunRadarButtonState(scenario).visible, false, JSON.stringify(scenario));
  }
});

test("visible is true only for a global user -- never for a PAM, in any scenario", () => {
  const globalScenarios = [
    { isGlobalUser: true, territory: "all", runTargetTerritoryId: null, isPending: false },
    { isGlobalUser: true, territory: "t1", runTargetTerritoryId: "t1", isPending: false },
  ];
  for (const scenario of globalScenarios) {
    assert.equal(computeRunRadarButtonState(scenario).visible, true, JSON.stringify(scenario));
  }

  const pamScenarios = [
    { isGlobalUser: false, territory: "all", runTargetTerritoryId: "own", isPending: false },
    { isGlobalUser: false, territory: "all", runTargetTerritoryId: null, isPending: true },
  ];
  for (const scenario of pamScenarios) {
    assert.equal(computeRunRadarButtonState(scenario).visible, false, JSON.stringify(scenario));
  }
});
