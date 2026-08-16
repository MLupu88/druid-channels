import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "./encryption";

type ProviderType = typeof connectionsTable.$inferSelect.providerType;

// Provider defaults are seeded once (see ensureConnectionsSeeded). Each
// provider is checked against the env var *currently* configured on its row
// (credential_env_var), so an admin can point at a different env var name
// without redeploying code. No secret value is ever read into config_json,
// only whether the named env var is present.
const DEFAULT_PROVIDERS: Array<{
  providerType: ProviderType;
  providerName: string;
  credentialEnvVar: string;
}> = [
  { providerType: "hubspot", providerName: "HubSpot", credentialEnvVar: "HUBSPOT_ACCESS_TOKEN" },
  { providerType: "web_search", providerName: "Web Search", credentialEnvVar: "SEARCH_API_KEY" },
  { providerType: "web_reader", providerName: "Web Reader", credentialEnvVar: "EXTRACTION_API_KEY" },
  { providerType: "ai", providerName: "AI", credentialEnvVar: "AI_API_KEY" },
];

export async function ensureConnectionsSeeded(): Promise<void> {
  const existing = await db.select().from(connectionsTable);
  const existingTypes = new Set(existing.map((c) => c.providerType));
  const missing = DEFAULT_PROVIDERS.filter((p) => !existingTypes.has(p.providerType));
  if (missing.length === 0) return;
  await db.insert(connectionsTable).values(
    missing.map((p) => ({
      providerType: p.providerType,
      providerName: p.providerName,
      credentialEnvVar: p.credentialEnvVar,
      status: "not_configured" as const,
      configJson: {},
    })),
  );
}

export function hasCredential(envVarName: string | null): boolean {
  if (!envVarName) return false;
  const value = process.env[envVarName];
  return typeof value === "string" && value.trim().length > 0;
}

// Phase 11.5B: DB secret (only when enabled) -> credentialEnvVar (only when
// enabled) -> null. This is the single resolution path -- production calls
// (discoveryProviders/search.ts, ai.ts) and the admin Test Connection
// action both go through this, never a separate hardcoded env read.
//
// enabled=false returns null unconditionally: it means "this integration is
// off", not "prefer env" -- a disabled connection with a perfectly valid
// env var configured must still resolve to nothing.
//
// Throws (never silently substitutes a different credential or degrades to
// plaintext) if a DB secret exists but the encryption key is missing/
// malformed or decryption otherwise fails -- see hasResolvableCredential
// for the safe-boolean wrapper background gates use instead.
export async function resolveProviderSecret(providerType: ProviderType): Promise<string | null> {
  const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.providerType, providerType));
  if (!conn || !conn.enabled) return null;
  if (conn.secretCiphertext && conn.encryptionKeyVersion != null) {
    return decryptSecret(conn.secretCiphertext, conn.encryptionKeyVersion);
  }
  if (hasCredential(conn.credentialEnvVar)) {
    return process.env[conn.credentialEnvVar!]!;
  }
  return null;
}

// Safe wrapper for lightweight "is this provider usable" gates (Discovery's
// isConfigured() checks, run on every scan). A broken/malformed encryption
// key must never crash a scan mid-run -- it's treated the same as "not
// configured" here. The admin-facing Test Connection action (routes/
// connections.ts) calls resolveProviderSecret directly instead, so a
// misconfigured key is still surfaced loudly there, just not deep inside a
// background scan loop.
export async function hasResolvableCredential(providerType: ProviderType): Promise<boolean> {
  try {
    return (await resolveProviderSecret(providerType)) !== null;
  } catch {
    return false;
  }
}

// Encrypts and stores a new secret, replacing any existing one. Resets
// status to "unverified" (a newly-entered credential hasn't been tested
// yet) -- mirrors the existing "changing credential_env_var invalidates the
// last test result" behavior in routes/connections.ts's PATCH handler.
export async function setConnectionSecret(id: string, plaintext: string, updatedByUserId: string) {
  const encrypted = encryptSecret(plaintext);
  const [updated] = await db
    .update(connectionsTable)
    .set({
      secretCiphertext: encrypted.ciphertext,
      secretLast4: encrypted.last4,
      encryptionKeyVersion: encrypted.keyVersion,
      updatedByUserId,
      status: "unverified",
      lastError: null,
      lastTestedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(connectionsTable.id, id))
    .returning();
  return updated ?? null;
}

// Removes the stored DB secret. Resolution then falls through to
// credentialEnvVar (if enabled) exactly as if no DB secret had ever been
// set -- this is what "cleanly revert to env fallback" means in practice:
// resolveProviderSecret's own if/else chain, not a separate code path.
export async function clearConnectionSecret(id: string, updatedByUserId: string) {
  const [updated] = await db
    .update(connectionsTable)
    .set({
      secretCiphertext: null,
      secretLast4: null,
      encryptionKeyVersion: null,
      updatedByUserId,
      status: "not_configured",
      lastError: null,
      lastTestedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(connectionsTable.id, id))
    .returning();
  return updated ?? null;
}

export async function setConnectionEnabled(id: string, enabled: boolean, updatedByUserId: string) {
  const [updated] = await db
    .update(connectionsTable)
    .set({
      enabled,
      updatedByUserId,
      status: "not_configured",
      lastError: null,
      lastTestedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(connectionsTable.id, id))
    .returning();
  return updated ?? null;
}

export interface TestOutcome {
  status: "connected" | "error" | "not_configured" | "unverified";
  error: string | null;
}

export async function recordTestResult(id: string, outcome: TestOutcome) {
  const [updated] = await db
    .update(connectionsTable)
    .set({ status: outcome.status, lastError: outcome.error, lastTestedAt: new Date(), updatedAt: new Date() })
    .where(eq(connectionsTable.id, id))
    .returning();
  return updated ?? null;
}

// secret_ciphertext, encryption_key_version, and any decrypted plaintext
// are never included here -- only secret_last4 (masking) and has_db_secret
// (a boolean derived from presence, not the value).
export function toConnectionResponse(conn: typeof connectionsTable.$inferSelect) {
  return {
    id: conn.id,
    provider_type: conn.providerType,
    provider_name: conn.providerName,
    status: conn.status,
    config_json: conn.configJson ?? {},
    credential_env_var: conn.credentialEnvVar,
    has_credential: hasCredential(conn.credentialEnvVar),
    enabled: conn.enabled,
    has_db_secret: !!conn.secretCiphertext,
    secret_last4: conn.secretLast4,
    last_tested_at: conn.lastTestedAt ? conn.lastTestedAt.toISOString() : null,
    last_error: conn.lastError,
  };
}
