// Phase 12 Aniri PAM-level intelligence: DB-backed tests for
// getPamDirectory -- direct @workspace/db + service-layer calls against a
// disposable Postgres, no HTTP server (route-level auth is covered
// separately in tests/pamDirectoryRoute.test.ts, which needs a live seeded
// server). Same pattern as tests/pamOverviewService.test.ts.
//
//   DATABASE_URL=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... tsx --test tests/pamDirectory.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, usersTable, territoriesTable } from "@workspace/db";
import { getPamDirectory } from "../src/services/pamDirectoryService";

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `Phase12Dir-${label}-${Date.now()}-${counter}`;
}

const createdUserIds: string[] = [];
const createdTerritoryIds: string[] = [];

after(async () => {
  for (const id of createdTerritoryIds) await db.delete(territoriesTable).where(eq(territoriesTable.id, id));
  for (const id of createdUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  await pool.end();
});

async function makeUser(overrides: Partial<typeof usersTable.$inferInsert> = {}) {
  const [user] = await db
    .insert(usersTable)
    .values({ name: uniq("User"), email: `${uniq("user")}@example.test`, passwordHash: "test-fixture-hash", role: "pam", active: true, ...overrides })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

async function makeTerritory(overrides: Partial<typeof territoriesTable.$inferInsert> = {}) {
  const [territory] = await db.insert(territoriesTable).values({ name: uniq("Territory"), ...overrides }).returning();
  createdTerritoryIds.push(territory!.id);
  return territory!;
}

test("an active PAM who owns a territory appears with that territory listed", async () => {
  const pam = await makeUser({ name: uniq("Denny-like") });
  const territory = await makeTerritory({ ownerUserId: pam.id, countries: ["Portugal"] });

  const directory = await getPamDirectory();
  const entry = directory.find((e) => e.pam_user_id === pam.id);
  assert.ok(entry, "expected the fixture PAM to appear in the directory");
  assert.equal(entry!.pam_name, pam.name);
  assert.equal(entry!.pam_email, pam.email);
  assert.deepEqual(entry!.territories, [{ territory_id: territory.id, territory_name: territory.name, countries: ["Portugal"] }]);
  assert.equal(entry!.active, true);
});

test("an active PAM with no owned territory appears with territories: [], never invented", async () => {
  const pam = await makeUser();

  const directory = await getPamDirectory();
  const entry = directory.find((e) => e.pam_user_id === pam.id);
  assert.ok(entry);
  assert.deepEqual(entry!.territories, []);
});

test("an inactive PAM never appears in the directory", async () => {
  const pam = await makeUser({ active: false });

  const directory = await getPamDirectory();
  assert.equal(directory.some((e) => e.pam_user_id === pam.id), false, "an inactive PAM must never be listed");
});

test("a non-PAM role (head_of_channels/admin) never appears in the directory, even when active", async () => {
  const head = await makeUser({ role: "head_of_channels", active: true });
  const admin = await makeUser({ role: "admin", active: true });

  const directory = await getPamDirectory();
  assert.equal(directory.some((e) => e.pam_user_id === head.id), false, "head_of_channels must never be listed as a PAM");
  assert.equal(directory.some((e) => e.pam_user_id === admin.id), false, "admin must never be listed as a PAM");
});

test("no performance/portfolio/pipeline fields are present on a directory entry -- identity only", async () => {
  const pam = await makeUser();
  const directory = await getPamDirectory();
  const entry = directory.find((e) => e.pam_user_id === pam.id)!;
  const allowedKeys = new Set(["pam_user_id", "pam_name", "pam_email", "territories", "active"]);
  for (const key of Object.keys(entry)) {
    assert.ok(allowedKeys.has(key), `unexpected field "${key}" on a PAM directory entry -- this endpoint must stay identity-only`);
  }
});

test("ordering is deterministic: alphabetical by pam_name, with id as a stable tie-breaker for identical names", async () => {
  const sameName = uniq("SameName");
  const a = await makeUser({ name: sameName });
  const b = await makeUser({ name: sameName });
  const [lowerId, higherId] = [a.id, b.id].sort();

  const run1 = await getPamDirectory();
  const run2 = await getPamDirectory();

  const idx1 = run1.findIndex((e) => e.pam_user_id === lowerId);
  const idx2 = run1.findIndex((e) => e.pam_user_id === higherId);
  assert.ok(idx1 < idx2, "among two PAMs with the identical name, the lexicographically smaller id must sort first");

  // Re-running must produce the exact same order -- never arbitrary/
  // Postgres-default row order.
  assert.deepEqual(
    run1.map((e) => e.pam_user_id),
    run2.map((e) => e.pam_user_id),
  );

  // Full-list ordering is non-decreasing by name.
  for (let i = 1; i < run1.length; i++) {
    assert.ok(run1[i - 1]!.pam_name.localeCompare(run1[i]!.pam_name) <= 0, "directory must be name-ascending throughout");
  }
});

test("a PAM owning several territories appears exactly once with every territory, ordered by name then id", async () => {
  const pam = await makeUser();
  const territoryZ = await makeTerritory({ name: uniq("ZZZ-Territory"), ownerUserId: pam.id });
  const territoryA = await makeTerritory({ name: uniq("AAA-Territory"), ownerUserId: pam.id });
  const otherPam = await makeUser();
  await makeTerritory({ name: uniq("MMM-Territory"), ownerUserId: otherPam.id });

  const run1 = await getPamDirectory();
  const run2 = await getPamDirectory();
  const entries = run1.filter((e) => e.pam_user_id === pam.id);
  assert.equal(entries.length, 1, "a PAM must never appear twice, however many territories they own");
  assert.deepEqual(
    entries[0]!.territories.map((t) => t.territory_id),
    [territoryA.id, territoryZ.id],
    "every owned territory is listed (none silently dropped), name-ascending",
  );
  assert.deepEqual(
    run1.find((e) => e.pam_user_id === pam.id),
    run2.find((e) => e.pam_user_id === pam.id),
    "territory ordering must be deterministic across calls",
  );
});
