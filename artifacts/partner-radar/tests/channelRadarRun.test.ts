// 5B-R hotfix: Channel Radar's Run Radar button used to disappear entirely
// whenever a global user (Head/Admin) had "All territories" selected --
// previously the button's very presence in the DOM was gated on
// `!isGlobalUser || territory !== 'all'`. Pure unit tests for the replacement
// decision function -- no React rendering, no network.
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

test("check: PAM (non-global user) always sees and can run Radar for their own territory", () => {
  const state = computeRunRadarButtonState({ isGlobalUser: false, territory: "all", runTargetTerritoryId: "own-territory-1", isPending: false });
  assert.equal(state.visible, true, "a PAM's Run Radar must never be gated on the territory filter selector");
  assert.equal(state.disabled, false);
});

test("PAM with no territory assigned at all is disabled with an explanation, but still visible", () => {
  const state = computeRunRadarButtonState({ isGlobalUser: false, territory: "all", runTargetTerritoryId: null, isPending: false });
  assert.equal(state.visible, true);
  assert.equal(state.disabled, true);
  assert.ok(state.title && state.title.length > 0);
});

test("visible is true in every case -- the button is never conditionally omitted from the page", () => {
  const scenarios = [
    { isGlobalUser: true, territory: "all", runTargetTerritoryId: null, isPending: false },
    { isGlobalUser: true, territory: "t1", runTargetTerritoryId: "t1", isPending: false },
    { isGlobalUser: false, territory: "all", runTargetTerritoryId: "own", isPending: false },
    { isGlobalUser: false, territory: "all", runTargetTerritoryId: null, isPending: true },
  ];
  for (const scenario of scenarios) {
    assert.equal(computeRunRadarButtonState(scenario).visible, true, JSON.stringify(scenario));
  }
});
