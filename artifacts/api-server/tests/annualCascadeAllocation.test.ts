// Phase 11.6.1 P0 fix: getAnnualCascade's DB-backed allocation-row
// construction -- DB-backed (needs real territory/user/metric_targets rows),
// so this runs against a live disposable Postgres, same pattern as
// tests/discoveryDedupe.test.ts. Deliberately separate from
// tests/annualCascade.test.ts, which stays pure and only exercises
// computeAnnualCascade (the aggregation math) with a hand-built allocations
// array -- this file exercises the row-construction step that array
// actually comes from in production.
//
//   DATABASE_URL=... tsx --test tests/annualCascadeAllocation.test.ts
// or `pnpm run test:annual-cascade-allocation` from artifacts/api-server
// with DATABASE_URL exported.
//
// Confirmed bug (Phase 11.6.1 forensic audit): getAnnualCascade used to
// build its allocations map ONLY from existing metric_targets quarter rows,
// never from territories.owner_user_id directly -- so a PAM who canonically
// owns a territory but has never had a quarter target row saved for the
// selected metric+year was invisible to the cascade/allocation dialog,
// producing the false "No PAMs own a territory yet" empty state even though
// Settings > Team correctly shows ownership. The fix seeds one allocation
// entry per canonically-owned territory (same enumeration getTeamTargets
// already uses) and overlays existing quarter rows on top.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, territoriesTable, usersTable, metricTargetsTable, type Territory, type User } from "@workspace/db";
import { getAnnualCascade } from "../src/services/targetService";

const TEST_METRIC_KEY = "new_partner_prospects"; // a count metric -- keeps this file's fixtures away from closed_revenue's credit-date special case
const TEST_YEAR = 2031; // far enough from any real annual target that a real one could never collide with these assertions

const createdTerritoryIds: string[] = [];
const createdUserIds: string[] = [];

async function makePam(namePrefix: string): Promise<User> {
  const [user] = await db
    .insert(usersTable)
    .values({ name: `${namePrefix} ${Date.now()}`, email: `${namePrefix.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}@test.example`, role: "pam" })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

async function makeTerritory(namePrefix: string, ownerUserId: string | null): Promise<Territory> {
  const [territory] = await db
    .insert(territoriesTable)
    .values({ name: `${namePrefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ownerUserId })
    .returning();
  createdTerritoryIds.push(territory!.id);
  return territory!;
}

function findAllocation(
  allocations: ReadonlyArray<{ pamUserId: string; territoryId: string }>,
  pamUserId: string,
  territoryId: string,
) {
  return allocations.find((a) => a.pamUserId === pamUserId && a.territoryId === territoryId);
}

after(async () => {
  // Best-effort cleanup, in FK-safe order -- this DB is disposable, but
  // each test suite still cleans up what it created (same convention as
  // tests/discoveryDedupe.test.ts).
  for (const territoryId of createdTerritoryIds) {
    await db.delete(metricTargetsTable).where(eq(metricTargetsTable.territoryId, territoryId));
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  for (const userId of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
  await pool.end();
});

// ---- Case A: owned territory, zero metric_targets rows for this metric/year ----

test("A: a PAM who owns a territory but has zero saved quarter targets for this metric/year still appears, with all four quarters null", async () => {
  const pam = await makePam("Cascade-Test-A-Pam");
  const territory = await makeTerritory("Cascade-Test-A-Territory", pam.id);

  const cascade = await getAnnualCascade(TEST_METRIC_KEY, TEST_YEAR);

  const entry = findAllocation(cascade.allocations, pam.id, territory.id);
  assert.ok(entry, "expected the owning PAM/territory pair to appear in allocations even with zero saved quarter targets");
  assert.equal(entry!.pamName, pam.name);
  assert.equal(entry!.territoryName, territory.name);
  assert.equal(entry!.q1, null);
  assert.equal(entry!.q2, null);
  assert.equal(entry!.q3, null);
  assert.equal(entry!.q4, null);
});

// ---- Case B: owned territory, some quarter rows exist -- overlay + missing quarters stay null ----

test("B: existing quarter rows overlay onto the seeded allocation; quarters with no saved row stay null", async () => {
  const pam = await makePam("Cascade-Test-B-Pam");
  const territory = await makeTerritory("Cascade-Test-B-Territory", pam.id);

  await db.insert(metricTargetsTable).values([
    { metricKey: TEST_METRIC_KEY, year: TEST_YEAR, period: "q1", territoryId: territory.id, pamUserId: pam.id, targetValue: "5" },
    { metricKey: TEST_METRIC_KEY, year: TEST_YEAR, period: "q3", territoryId: territory.id, pamUserId: pam.id, targetValue: "7" },
  ]);

  const cascade = await getAnnualCascade(TEST_METRIC_KEY, TEST_YEAR);

  const entry = findAllocation(cascade.allocations, pam.id, territory.id);
  assert.ok(entry, "expected the owning PAM/territory pair to appear");
  assert.equal(entry!.q1, 5, "Q1's saved target must overlay onto the seeded entry");
  assert.equal(entry!.q2, null, "Q2 has no saved row and must stay null, never fabricated as 0");
  assert.equal(entry!.q3, 7, "Q3's saved target must overlay onto the seeded entry");
  assert.equal(entry!.q4, null, "Q4 has no saved row and must stay null, never fabricated as 0");
});

// ---- Case C: multiple owned territories/PAMs -- all appear even if only one has saved targets ----

test("C: multiple owned territories all appear in the cascade, even when only one PAM has ever saved a quarter target", async () => {
  const pamWithTargets = await makePam("Cascade-Test-C-Pam-WithTargets");
  const territoryWithTargets = await makeTerritory("Cascade-Test-C-Territory-WithTargets", pamWithTargets.id);
  const pamWithoutTargets = await makePam("Cascade-Test-C-Pam-WithoutTargets");
  const territoryWithoutTargets = await makeTerritory("Cascade-Test-C-Territory-WithoutTargets", pamWithoutTargets.id);

  await db.insert(metricTargetsTable).values([
    { metricKey: TEST_METRIC_KEY, year: TEST_YEAR, period: "q2", territoryId: territoryWithTargets.id, pamUserId: pamWithTargets.id, targetValue: "3" },
  ]);

  const cascade = await getAnnualCascade(TEST_METRIC_KEY, TEST_YEAR);

  const entryWithTargets = findAllocation(cascade.allocations, pamWithTargets.id, territoryWithTargets.id);
  assert.ok(entryWithTargets, "expected the PAM with a saved target to appear");
  assert.equal(entryWithTargets!.q2, 3);

  const entryWithoutTargets = findAllocation(cascade.allocations, pamWithoutTargets.id, territoryWithoutTargets.id);
  assert.ok(entryWithoutTargets, "expected the PAM with zero saved targets to appear too -- this is the confirmed bug this fix addresses");
  assert.equal(entryWithoutTargets!.q1, null);
  assert.equal(entryWithoutTargets!.q2, null);
  assert.equal(entryWithoutTargets!.q3, null);
  assert.equal(entryWithoutTargets!.q4, null);
});

// ---- Case D: an unowned territory never produces an allocation entry ----
//
// getAnnualCascade has no territory/scope filter -- it enumerates every
// owned territory in the whole database for the given metric+year, so a
// global "allocations is entirely empty" assertion is not safely testable
// against a shared disposable Postgres that may carry other seed/test data.
// What IS safely, deterministically testable -- and is the exact code path
// responsible for the "genuinely zero owned territories -> empty
// allocations" guarantee -- is that a territory with no owner is never
// seeded into allocations in the first place. A territory with ownerUserId
// null is exactly what the empty-state message means when it fires.
test("D: a territory with no owner never appears in allocations", async () => {
  const territory = await makeTerritory("Cascade-Test-D-Unowned-Territory", null);

  const cascade = await getAnnualCascade(TEST_METRIC_KEY, TEST_YEAR);

  assert.ok(
    !cascade.allocations.some((a) => a.territoryId === territory.id),
    "an unowned territory must never produce an allocation entry",
  );
});
