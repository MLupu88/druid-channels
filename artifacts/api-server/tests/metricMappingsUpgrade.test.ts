// Phase 5A follow-up: DB-backed regression test proving
// ensureMetricMappingsSeeded's narrowly-scoped stale-mapping upgrade --
// opportunities_created moves off its pre-Phase-5A DEMO default, while
// metric_mappings otherwise stays purely insert-missing/never-overwrite
// (it's user-configurable via Admin > Connections & data, see
// services/kpiService.ts's comment on ensureMetricMappingsSeeded).
//
//   DATABASE_URL=... tsx --test tests/metricMappingsUpgrade.test.ts
//
// No Tavily/DeepSeek/HubSpot/live-FX calls -- this only touches
// metric_mappings rows directly.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, metricMappingsTable } from "@workspace/db";
import { ensureMetricMappingsSeeded } from "../src/services/kpiService";

const createdMetricKeys: string[] = [];

async function insertMapping(metricKey: string, sourceType: string) {
  await db.insert(metricMappingsTable).values({ metricKey, sourceType: sourceType as any, active: true, mappingJson: null });
  createdMetricKeys.push(metricKey);
}

async function sourceTypeOf(metricKey: string): Promise<string | undefined> {
  const [row] = await db.select().from(metricMappingsTable).where(eq(metricMappingsTable.metricKey, metricKey));
  return row?.sourceType;
}

after(async () => {
  for (const key of createdMetricKeys) {
    await db.delete(metricMappingsTable).where(eq(metricMappingsTable.metricKey, key));
  }
  await pool.end();
});

test("a stale pre-Phase-5A opportunities_created=DEMO row is upgraded to PARTNER_RADAR", async () => {
  await db.delete(metricMappingsTable).where(eq(metricMappingsTable.metricKey, "opportunities_created"));
  await insertMapping("opportunities_created", "DEMO");

  await ensureMetricMappingsSeeded();

  assert.equal(await sourceTypeOf("opportunities_created"), "PARTNER_RADAR");
});

test("an already-correct opportunities_created=PARTNER_RADAR row stays correct (idempotent)", async () => {
  await db.delete(metricMappingsTable).where(eq(metricMappingsTable.metricKey, "opportunities_created"));
  await insertMapping("opportunities_created", "PARTNER_RADAR");

  await ensureMetricMappingsSeeded();
  await ensureMetricMappingsSeeded(); // twice, to prove no flip-flopping

  assert.equal(await sourceTypeOf("opportunities_created"), "PARTNER_RADAR");
});

test("an admin's deliberate customization of opportunities_created (e.g. MANUAL) is left untouched -- only the known legacy DEMO value is upgraded", async () => {
  await db.delete(metricMappingsTable).where(eq(metricMappingsTable.metricKey, "opportunities_created"));
  await insertMapping("opportunities_created", "MANUAL");

  await ensureMetricMappingsSeeded();

  assert.equal(await sourceTypeOf("opportunities_created"), "MANUAL", "a source_type other than the known stale DEMO default must never be overwritten");
});

test("an unrelated metric's DEMO mapping is never touched by opportunities_created's upgrade", async () => {
  // active_onboarding's own canonical default really is DEMO (see
  // kpiRegistry.ts) -- this proves the upgrade path is scoped to the exact
  // (metric_key, stale source_type) pair, not "any DEMO row in the table."
  await db.delete(metricMappingsTable).where(eq(metricMappingsTable.metricKey, "active_onboarding"));
  await insertMapping("active_onboarding", "DEMO");

  await ensureMetricMappingsSeeded();

  assert.equal(await sourceTypeOf("active_onboarding"), "DEMO", "an unrelated metric's mapping must never be modified by this upgrade path");
});

test("a fresh database with no opportunities_created row yet gets the correct PARTNER_RADAR default from normal seeding, not the legacy upgrade path", async () => {
  await db.delete(metricMappingsTable).where(eq(metricMappingsTable.metricKey, "opportunities_created"));

  await ensureMetricMappingsSeeded();

  assert.equal(await sourceTypeOf("opportunities_created"), "PARTNER_RADAR");
});
