import { pgTable, text, uuid, timestamp, json, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// A configured integration boundary (HubSpot, web search, web reader, AI).
// `configJson` must only ever contain non-secret settings (provider choice,
// default result limits, etc).
//
// Phase 11.5B: a secret CAN now be stored here too, encrypted
// (services/encryption.ts, AES-256-GCM, server-only INTEGRATION_ENCRYPTION_KEY).
// secretCiphertext is never returned by any API response -- only
// secretLast4 (masked display) is. Resolution order (services/connections.ts's
// resolveProviderSecret): DB secret (only when enabled) -> credentialEnvVar
// (only when enabled) -> unavailable. enabled=false disables BOTH, not just
// the DB secret -- it means "this integration is off", not "prefer env".
export const connectionsTable = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerType: text("provider_type", {
    enum: ["hubspot", "web_search", "web_reader", "ai"],
  }).notNull().unique(),
  providerName: text("provider_name").notNull(),
  status: text("status", { enum: ["not_configured", "unverified", "connected", "error"] }).notNull().default("not_configured"),
  configJson: json("config_json").$type<Record<string, unknown>>().notNull().default({}),
  credentialEnvVar: text("credential_env_var"),
  enabled: boolean("enabled").notNull().default(true),
  // AES-256-GCM ciphertext, packed as ivBase64:authTagBase64:ciphertextBase64
  // by services/encryption.ts. Never serialized in any API response.
  secretCiphertext: text("secret_ciphertext"),
  // Last 4 characters of the plaintext, stored alongside the ciphertext at
  // write time -- masked display never requires decrypting the secret.
  secretLast4: text("secret_last4"),
  // Present from day one so a future encryption-key rotation needs no new
  // migration, even though v1 only ever writes version 1.
  encryptionKeyVersion: integer("encryption_key_version"),
  updatedByUserId: uuid("updated_by_user_id").references(() => usersTable.id),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertConnectionSchema = createInsertSchema(connectionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertConnection = z.infer<typeof insertConnectionSchema>;
export type Connection = typeof connectionsTable.$inferSelect;
