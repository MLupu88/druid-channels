import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Provider defaults are seeded once (see ensureConnectionsSeeded). Each
// provider is checked against the env var *currently* configured on its row
// (credential_env_var), so an admin can point at a different env var name
// without redeploying code. No secret value is ever read into config_json,
// only whether the named env var is present.
const DEFAULT_PROVIDERS: Array<{
  providerType: "hubspot" | "web_search" | "web_reader" | "ai";
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

export async function testConnectionById(id: string) {
  const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, id));
  if (!conn) return null;

  const now = new Date();
  if (!hasCredential(conn.credentialEnvVar)) {
    const [updated] = await db
      .update(connectionsTable)
      .set({
        status: "not_configured",
        lastError: conn.credentialEnvVar
          ? `Environment variable ${conn.credentialEnvVar} is not set.`
          : "No credential environment variable is configured for this connection.",
        lastTestedAt: now,
        updatedAt: now,
      })
      .where(eq(connectionsTable.id, id))
      .returning();
    return updated;
  }

  // A credential is present, but no provider in this environment has a live
  // API call wired up yet (see services/hubspot.ts) -- so we can only
  // confirm the credential exists, not that it actually authenticates
  // against the provider. Reporting "connected" here would fabricate a
  // verification that never happened, so we use a distinct "unverified"
  // status instead. Once a provider's service module makes a real call,
  // route its success/failure into "connected" / "error" here.
  const [updated] = await db
    .update(connectionsTable)
    .set({
      status: "unverified",
      lastError: "Credential is present, but live verification is not implemented for this provider yet.",
      lastTestedAt: now,
      updatedAt: now,
    })
    .where(eq(connectionsTable.id, id))
    .returning();
  return updated;
}

export function toConnectionResponse(conn: typeof connectionsTable.$inferSelect) {
  return {
    id: conn.id,
    provider_type: conn.providerType,
    provider_name: conn.providerName,
    status: conn.status,
    config_json: conn.configJson ?? {},
    credential_env_var: conn.credentialEnvVar,
    has_credential: hasCredential(conn.credentialEnvVar),
    last_tested_at: conn.lastTestedAt ? conn.lastTestedAt.toISOString() : null,
    last_error: conn.lastError,
  };
}
