import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import {
  ListConnectionsResponse,
  UpdateConnectionBody,
  UpdateConnectionResponse,
  TestConnectionResponse,
  SetConnectionSecretBody,
  SetConnectionSecretResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import {
  toConnectionResponse,
  hasCredential,
  resolveProviderSecret,
  setConnectionSecret,
  clearConnectionSecret,
  recordTestResult,
  type TestOutcome,
} from "../services/connections";
import * as searchProvider from "../services/discoveryProviders/search";
import * as aiProvider from "../services/discoveryProviders/ai";
import { SearchProviderError } from "../services/discoveryProviders/search";
import { AiProviderError } from "../services/discoveryProviders/ai";
import { EncryptionKeyMissingError, EncryptionKeyMalformedError, SecretDecryptionError } from "../services/encryption";
import { requireAdmin } from "../middleware/auth";

const router: IRouter = Router();

router.get("/connections", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(connectionsTable);
  res.json(ListConnectionsResponse.parse(rows.map(toConnectionResponse)));
});

router.patch("/connections/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = UpdateConnectionBody.parse(req.body);
  const [existing] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  // Any change that affects which credential resolves (credential_env_var
  // or enabled) invalidates the last test result -- an untested state is
  // more honest than carrying forward a stale "connected" status.
  const invalidatesTestResult = body.credential_env_var !== undefined || body.enabled !== undefined;

  const [updated] = await db
    .update(connectionsTable)
    .set({
      ...(body.provider_name !== undefined ? { providerName: body.provider_name } : {}),
      ...(body.config_json !== undefined ? { configJson: body.config_json } : {}),
      ...(body.credential_env_var !== undefined ? { credentialEnvVar: body.credential_env_var } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled, updatedByUserId: req.actingUser!.id } : {}),
      ...(invalidatesTestResult ? { status: "not_configured" as const, lastError: null, lastTestedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(connectionsTable.id, id))
    .returning();

  res.json(UpdateConnectionResponse.parse(toConnectionResponse(updated!)));
});

router.post("/connections/:id/secret", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = SetConnectionSecretBody.parse(req.body);
  const [existing] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  const updated =
    body.secret === null
      ? await clearConnectionSecret(id, req.actingUser!.id)
      : await setConnectionSecret(id, body.secret, req.actingUser!.id);

  res.json(SetConnectionSecretResponse.parse(toConnectionResponse(updated!)));
});

// A small closed set of internal failure classifications -- never the raw
// provider error text (matches the SearchProviderError/AiProviderError
// convention already established in the provider modules themselves).
function classifyTestError(err: unknown): string {
  if (err instanceof SearchProviderError || err instanceof AiProviderError) return err.code;
  if (err instanceof EncryptionKeyMissingError || err instanceof EncryptionKeyMalformedError) return "encryption_key_invalid";
  if (err instanceof SecretDecryptionError) return "secret_decryption_failed";
  return "unknown_error";
}

router.post("/connections/:id/test", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [existing] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  let outcome: TestOutcome;

  if (existing.providerType === "web_search" || existing.providerType === "ai") {
    // Real bounded provider verification -- resolves through the exact same
    // DB secret -> env fallback -> unavailable path production requests use
    // (resolveProviderSecret), then makes one minimal, bounded live call.
    try {
      const apiKey = await resolveProviderSecret(existing.providerType);
      if (!apiKey) {
        outcome = {
          status: "not_configured",
          error: existing.enabled ? "No credential is configured (checked DB secret and environment variable fallback)." : "This connection is disabled.",
        };
      } else if (existing.providerType === "web_search") {
        await searchProvider.testConnection(apiKey);
        outcome = { status: "connected", error: null };
      } else {
        await aiProvider.testConnection(apiKey);
        outcome = { status: "connected", error: null };
      }
    } catch (err) {
      outcome = { status: "error", error: classifyTestError(err) };
    }
  } else {
    // hubspot / web_reader: no live provider call is implemented yet (out
    // of scope for this slice -- see Phase 11.5B/11.5C) -- presence of a
    // usable credential is as far as this endpoint can honestly confirm.
    const credentialUsable = existing.enabled && hasCredential(existing.credentialEnvVar);
    outcome = credentialUsable
      ? { status: "unverified", error: "Credential is present, but live verification is not implemented for this provider yet." }
      : {
          status: "not_configured",
          error: !existing.enabled
            ? "This connection is disabled."
            : existing.credentialEnvVar
              ? `Environment variable ${existing.credentialEnvVar} is not set.`
              : "No credential environment variable is configured for this connection.",
        };
  }

  const updated = await recordTestResult(id, outcome);
  res.json(TestConnectionResponse.parse(toConnectionResponse(updated!)));
});

export default router;
