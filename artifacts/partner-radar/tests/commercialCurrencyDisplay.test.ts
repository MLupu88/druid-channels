// Phase 5B-1 currency-semantics fix: a structural regression guard proving
// commercial-performance.tsx never shows a cascade/target figure (annual
// target, allocated_to_pams, unallocated/overallocated, quarterly
// allocations, a PAM's own quarter target) as a bare unlabeled number or
// under the page's selected display currency. Those figures come from
// GET /metric-targets/annual-cascade and GET /team-targets, neither of
// which accepts a currency param or applies any FX conversion -- they are
// USD by the same established convention buildHeadOfChannelsData/
// getKpiDetails already use for a money metric's target_value (see
// kpiService.ts), and computeAnnualActual normalizes opportunity values to
// USD explicitly. Only weekly_commercial's `current`/`target` are actually
// converted to the page's selected currency server-side, so those two
// families of numbers can legitimately differ -- this test proves the UI
// never blurs that distinction.
//
// Same source-text-boundary style as tests/commercialPerformanceRoleScope
// .test.ts -- this project has no React rendering harness (see
// tests/metricTargetSelection.test.ts and siblings), so a deterministic,
// framework-free text check on the component source is the honest,
// consistent way to guard this without inventing new test infrastructure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatUsd } from "../src/lib/kpi-format";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, "../src/components/commercial-performance.tsx"), "utf-8");

test("commercial-performance.tsx imports and uses kpi-format.ts's formatUsd, never the old currency-blind formatPlain helper", () => {
  // formatPlain (the old, currency-blind helper) must be fully gone --
  // this is the exact regression this fix corrects.
  assert.ok(!source.includes("formatPlain"), "the old currency-blind formatPlain helper must no longer exist");
  assert.ok(source.includes("formatUsd"), "expected commercial-performance.tsx to use kpi-format.ts's formatUsd helper");
  assert.ok(!source.includes("function formatUsd"), "formatUsd should be imported from kpi-format.ts, not redefined locally");
});

test("the annual target, allocated-to-PAMs, and allocation table are all explicitly labeled USD in the UI text", () => {
  const requiredLabels = [
    "Annual target (USD)",
    "Allocated to PAMs (USD)",
    "Unallocated (USD)",
    "Annual allocation (USD)",
    "Quarter target (USD)", // PAM's own tile
  ];
  for (const label of requiredLabels) {
    assert.ok(source.includes(label), `expected commercial-performance.tsx to contain the explicit label "${label}"`);
  }
});

test("the currency-converted pipeline/revenue tiles are labeled with the page's selected currency, not a hardcoded one", () => {
  // Template-literal labels like `Sourced pipeline (${currency})` -- proves
  // these tiles are tied to the live selected-currency prop, distinct from
  // the hardcoded "(USD)" cascade/target labels above.
  assert.ok(source.includes("Sourced pipeline (${currency})"));
  assert.ok(source.includes("Influenced pipeline (${currency})"));
  assert.ok(source.includes("Closed revenue (${currency})"));
});

test("both the Head and PAM sections carry an explicit currency-disambiguation note distinguishing USD cascade/target figures from the selected-currency KPI tiles", () => {
  assert.ok(source.includes("data-testid=\"text-annual-target-currency-note\""));
  assert.ok(source.includes("data-testid=\"text-pam-target-currency-note\""));
  assert.ok(source.includes("data-testid=\"text-allocation-table-currency-note\""));
});

test("formatUsd (kpi-format.ts) always renders with the USD symbol regardless of any other selected currency", () => {
  assert.equal(formatUsd(1_200_000), "$1,200,000");
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(null), "--");
});
