// Phase 5B-1: a structural regression guard for the Head/PAM authz boundary
// in commercial-performance.tsx. The actual enforcement is server-side
// (GET /metric-targets/annual-cascade and PUT /metric-targets/annual are
// requireAdmin-gated -- see artifacts/api-server/tests/opportunitiesAuthz
// .test.ts) and GET /team-targets self-scopes a PAM caller regardless of
// what the frontend sends. This test's job is narrower: catch a regression
// where a future edit accidentally wires a Head/Admin-only hook (annual
// cascade read, annual target write, or the allocation-edit mutation) into
// CommercialPerformancePam. There is no React rendering harness in this
// project (see tests/metricTargetSelection.test.ts and siblings -- every
// existing frontend test here is a plain node:test pure-logic import, never
// a rendered-component test), so this is a source-text boundary check
// rather than a rendered-DOM assertion -- deliberately cheap, deterministic,
// and framework-free, matching the project's existing test conventions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, "../src/components/commercial-performance.tsx"), "utf-8");

const pamSplitMarker = "export function CommercialPerformancePam(";
const splitIndex = source.indexOf(pamSplitMarker);

test("commercial-performance.tsx defines CommercialPerformancePam as a distinct, later section of the file", () => {
  assert.notEqual(splitIndex, -1, "expected to find CommercialPerformancePam's export in commercial-performance.tsx");
});

const headAndSharedSection = source.slice(0, splitIndex);
const pamSection = source.slice(splitIndex);

const HEAD_ONLY_HOOKS = ["useGetAnnualCascade", "useUpsertAnnualTarget", "useUpsertMetricTarget", "EditAnnualTargetDialog", "EditAllocationDialog"];

test("CommercialPerformanceHead's section does use the Head/Admin-only cascade hooks (sanity check on the split point)", () => {
  for (const hook of HEAD_ONLY_HOOKS) {
    assert.ok(headAndSharedSection.includes(hook), `expected the Head/shared section to reference ${hook}`);
  }
});

test("CommercialPerformancePam never references the annual-cascade read, the annual-target write, or the per-PAM allocation-edit mutation/dialogs", () => {
  for (const hook of HEAD_ONLY_HOOKS) {
    assert.ok(!pamSection.includes(hook), `CommercialPerformancePam must never reference ${hook} -- that is a Head/Admin-only surface (GET /metric-targets/annual-cascade and PUT /metric-targets/annual are both requireAdmin-gated server-side)`);
  }
});

test("CommercialPerformancePam reads its own target/attainment only from useListTeamTargets, which the backend self-scopes to the caller", () => {
  assert.ok(pamSection.includes("useListTeamTargets"), "expected CommercialPerformancePam to use the self-scoped team-targets endpoint for its own quarter target/attainment");
});

test("CommercialPerformancePam never accepts a pamUserId/territoryId prop that could be used to view another PAM's data", () => {
  // Only weeklyCommercial and currency are accepted -- no id/scope override
  // parameter exists for a PAM caller to widen with.
  const signatureMatch = pamSection.match(/export function CommercialPerformancePam\(\{([^}]*)\}/);
  assert.ok(signatureMatch, "expected to parse CommercialPerformancePam's prop signature");
  const props = signatureMatch![1];
  assert.ok(!/pam_user_id|pamUserId|territory_id|territoryId/.test(props), `CommercialPerformancePam's props must never include a scope-widening id, got: ${props}`);
});
