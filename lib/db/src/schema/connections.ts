import { pgTable, text, uuid, timestamp, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A configured integration boundary (HubSpot, web search, web reader, AI).
// Credentials themselves are never stored here -- only the name of the
// environment variable that holds them (`credentialEnvVar`). `configJson`
// must only ever contain non-secret settings (provider choice, default
// result limits, etc).
export const connectionsTable = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerType: text("provider_type", {
    enum: ["hubspot", "web_search", "web_reader", "ai"],
  }).notNull().unique(),
  providerName: text("provider_name").notNull(),
  status: text("status", { enum: ["not_configured", "unverified", "connected", "error"] }).notNull().default("not_configured"),
  configJson: json("config_json").$type<Record<string, unknown>>().notNull().default({}),
  credentialEnvVar: text("credential_env_var"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertConnectionSchema = createInsertSchema(connectionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertConnection = z.infer<typeof insertConnectionSchema>;
export type Connection = typeof connectionsTable.$inferSelect;
