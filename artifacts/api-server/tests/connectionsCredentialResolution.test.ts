// Phase 11.5B: DB-backed coverage for resolveProviderSecret's precedence
// chain (DB secret -> credential_env_var -> unavailable) and the admin
// secret-management service functions. Requires a real local Postgres
// connection (via DATABASE_URL) and a real INTEGRATION_ENCRYPTION_KEY --
// same disposable-local-DB convention as discoveryExclusionsFlow.test.ts
// (Phase 11.1/11.5A), NOT the placeholder-DATABASE_URL pure-test pattern
// used elsewhere in this phase (encryption.test.ts, discoveryProviders.test.ts,
// etc.), because resolveProviderSecret genuinely queries the connections
// table.
//
// Mutates the DB's existing singleton "web_search" connections row directly
// (connections is a small admin-managed set seeded once by
// ensureConnectionsSeeded -- there is no per-test insert/delete of
// connections rows, unlike other fixture tables) and restores its exact
// original state in `after`, so this test never leaves the seeded
// web_search row's credential_env_var/secret/enabled state altered for any
// other test or manual run that follows it.
//
//   DATABASE_URL=... SESSION_SECRET=... INTEGRATION_ENCRYPTION_KEY=<64 hex chars> tsx --test tests/connectionsCredentialResolution.test.ts
// or `pnpm run test:connections-credential-resolution` with the same env exported.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, connectionsTable, usersTable } from "@workspace/db";
import {
  ensureConnectionsSeeded,
  resolveProviderSecret,
  hasResolvableCredential,
  setConnectionSecret,
  clearConnectionSecret,
  setConnectionEnabled,
} from "../src/services/connections";

const TEST_ENV_VAR_NAME = "SEARCH_API_KEY";
const TEST_ENV_VALUE = "env-fallback-key-value";
const TEST_DB_SECRET = "db-secret-key-value-9f8e7d6c";

let originalRow: typeof connectionsTable.$inferSelect;
let originalEnvValue: string | undefined;
let testUserId: string;

before(async () => {
  await ensureConnectionsSeeded();
  const [row] = await db.select().from(connectionsTable).where(eq(connectionsTable.providerType, "web_search"));
  if (!row) throw new Error("Expected the web_search connection row to already be seeded");
  originalRow = row;
  originalEnvValue = process.env[TEST_ENV_VAR_NAME];

  const [user] = await db
    .insert(usersTable)
    .values({
      name: "Phase115b Test Admin",
      email: `phase115b.${Date.now()}.${Math.random().toString(36).slice(2)}@phase11-test.example`,
      role: "head_of_channels",
      territory: null,
      active: true,
    })
    .returning();
  testUserId = user!.id;
});

// Every test starts from a clean, fully-reset web_search row: enabled=true,
// the real credential_env_var restored, no DB secret. Prevents any test
// order dependency.
beforeEach(async () => {
  process.env[TEST_ENV_VAR_NAME] = TEST_ENV_VALUE;
  await db
    .update(connectionsTable)
    .set({
      credentialEnvVar: TEST_ENV_VAR_NAME,
      enabled: true,
      secretCiphertext: null,
      secretLast4: null,
      encryptionKeyVersion: null,
      updatedByUserId: null,
      status: "not_configured",
      lastError: null,
      lastTestedAt: null,
    })
    .where(eq(connectionsTable.providerType, "web_search"));
});

after(async () => {
  // Restore the web_search row to its exact pre-test state, then remove the
  // throwaway admin user (only after the row no longer references it via
  // updated_by_user_id, since that FK has ON DELETE no action).
  await db
    .update(connectionsTable)
    .set({
      credentialEnvVar: originalRow.credentialEnvVar,
      enabled: originalRow.enabled,
      secretCiphertext: originalRow.secretCiphertext,
      secretLast4: originalRow.secretLast4,
      encryptionKeyVersion: originalRow.encryptionKeyVersion,
      updatedByUserId: null,
      status: originalRow.status,
      lastError: originalRow.lastError,
      lastTestedAt: originalRow.lastTestedAt,
    })
    .where(eq(connectionsTable.providerType, "web_search"));

  if (originalEnvValue === undefined) delete process.env[TEST_ENV_VAR_NAME];
  else process.env[TEST_ENV_VAR_NAME] = originalEnvValue;

  await db.delete(usersTable).where(eq(usersTable.id, testUserId));
});

test("env fallback: no DB secret, enabled, env var present -> resolves the env var's value", async () => {
  const resolved = await resolveProviderSecret("web_search");
  assert.equal(resolved, TEST_ENV_VALUE);
});

test("env fallback: no DB secret, enabled, env var absent -> resolves null", async () => {
  delete process.env[TEST_ENV_VAR_NAME];
  const resolved = await resolveProviderSecret("web_search");
  assert.equal(resolved, null);
});

test("DB-over-env precedence: a stored DB secret wins over a present env var", async () => {
  await setConnectionSecret(originalRow.id, TEST_DB_SECRET, testUserId);
  const resolved = await resolveProviderSecret("web_search");
  assert.equal(resolved, TEST_DB_SECRET);
  assert.notEqual(resolved, TEST_ENV_VALUE);
});

test("clear-secret fallback: clearing a DB secret cleanly reverts to the env var, not to unavailable", async () => {
  await setConnectionSecret(originalRow.id, TEST_DB_SECRET, testUserId);
  assert.equal(await resolveProviderSecret("web_search"), TEST_DB_SECRET);

  await clearConnectionSecret(originalRow.id, testUserId);
  const resolved = await resolveProviderSecret("web_search");
  assert.equal(resolved, TEST_ENV_VALUE);
});

test("disabled integration: enabled=false disables the DB secret path entirely", async () => {
  await setConnectionSecret(originalRow.id, TEST_DB_SECRET, testUserId);
  await setConnectionEnabled(originalRow.id, false, testUserId);
  const resolved = await resolveProviderSecret("web_search");
  assert.equal(resolved, null);
});

test("disabled integration: enabled=false disables the env-var fallback path too, even though the env var is present and valid", async () => {
  await setConnectionEnabled(originalRow.id, false, testUserId);
  const resolved = await resolveProviderSecret("web_search");
  assert.equal(resolved, null);
  // The env var itself is untouched/still valid -- disabling is a
  // connection-level decision, not a credential-availability one.
  assert.equal(process.env[TEST_ENV_VAR_NAME], TEST_ENV_VALUE);
});

test("re-enabling after disable restores whichever credential would otherwise resolve", async () => {
  await setConnectionEnabled(originalRow.id, false, testUserId);
  assert.equal(await resolveProviderSecret("web_search"), null);

  await setConnectionEnabled(originalRow.id, true, testUserId);
  assert.equal(await resolveProviderSecret("web_search"), TEST_ENV_VALUE);
});

test("hasResolvableCredential mirrors resolveProviderSecret as a safe boolean, never throwing", async () => {
  assert.equal(await hasResolvableCredential("web_search"), true);

  await setConnectionEnabled(originalRow.id, false, testUserId);
  assert.equal(await hasResolvableCredential("web_search"), false);
});

test("hasResolvableCredential fails closed (returns false, never throws) when a DB secret exists but INTEGRATION_ENCRYPTION_KEY is missing", async () => {
  await setConnectionSecret(originalRow.id, TEST_DB_SECRET, testUserId);
  const savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  try {
    assert.equal(await hasResolvableCredential("web_search"), false);
  } finally {
    if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
  }
});

test("resolveProviderSecret (the admin-facing path) throws loudly, rather than silently returning null, when a DB secret exists but the encryption key is missing", async () => {
  await setConnectionSecret(originalRow.id, TEST_DB_SECRET, testUserId);
  const savedKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  try {
    await assert.rejects(() => resolveProviderSecret("web_search"));
  } finally {
    if (savedKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = savedKey;
  }
});
