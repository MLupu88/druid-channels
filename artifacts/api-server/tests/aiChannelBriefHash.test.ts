// Pure unit test for the AI Channel Brief generation-input hash -- no live
// server or database needed. @workspace/db throws at import time if
// DATABASE_URL is unset (see lib/db/src/index.ts), but pg.Pool construction
// doesn't actually connect until a query runs, and none of the functions
// under test here ever query. ESM hoists imports before any of this file's
// own top-level code runs, so the placeholder DATABASE_URL can't be set
// here -- it's set by the "test:ai-brief-hash" script instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toMetricSnapshot, computeGenerationInputHash } from "../src/services/aiChannelBriefService";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    metric_key: "signed_partners",
    metric: "Signed Partners",
    current: 3,
    target: 5,
    status: "green",
    trend: "up",
    data_status: "CONNECTED",
    data_source: "Live: prospects table",
    last_updated: "2026-08-09T12:00:00.000Z",
    last_updated_is_synthetic: false,
    ...overrides,
  };
}

test("two connected-but-empty snapshots at different wall-clock times hash identically", () => {
  const rowA = baseRow({ current: 0, last_updated: "2026-08-09T12:00:00.000Z", last_updated_is_synthetic: true });
  const rowB = baseRow({ current: 0, last_updated: "2026-08-09T12:00:05.000Z", last_updated_is_synthetic: true });

  const snapA = toMetricSnapshot("channel_kpi", rowA);
  const snapB = toMetricSnapshot("channel_kpi", rowB);

  assert.equal(snapA.last_updated, null);
  assert.equal(snapB.last_updated, null);

  const hashA = computeGenerationInputHash("q3", null, "USD", [snapA]);
  const hashB = computeGenerationInputHash("q3", null, "USD", [snapB]);
  assert.equal(hashA, hashB);
});

test("a genuine source timestamp change changes the hash", () => {
  const rowA = baseRow({ last_updated: "2026-08-09T12:00:00.000Z", last_updated_is_synthetic: false });
  const rowB = baseRow({ last_updated: "2026-08-09T13:00:00.000Z", last_updated_is_synthetic: false });

  const snapA = toMetricSnapshot("channel_kpi", rowA);
  const snapB = toMetricSnapshot("channel_kpi", rowB);
  assert.notEqual(snapA.last_updated, null);
  assert.notEqual(snapA.last_updated, snapB.last_updated);

  const hashA = computeGenerationInputHash("q3", null, "USD", [snapA]);
  const hashB = computeGenerationInputHash("q3", null, "USD", [snapB]);
  assert.notEqual(hashA, hashB);
});

test("changing current/target/status/trend/data_status/data_source each changes the hash", () => {
  const base = toMetricSnapshot("channel_kpi", baseRow());
  const baseline = computeGenerationInputHash("q3", null, "USD", [base]);

  const variants: Record<string, unknown>[] = [
    { current: 99 },
    { target: 99 },
    { status: "red" },
    { trend: "down" },
    { data_status: "MANUAL" },
    { data_source: "Manual entry (Admin > Connections & data > Metric setup)" },
  ];

  for (const overrides of variants) {
    const variantSnap = toMetricSnapshot("channel_kpi", baseRow(overrides));
    const variantHash = computeGenerationInputHash("q3", null, "USD", [variantSnap]);
    assert.notEqual(variantHash, baseline, `expected hash to change for ${JSON.stringify(overrides)}`);
  }
});
