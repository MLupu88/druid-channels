import { pgTable, text, uuid, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { druidContextSourcesTable } from "./druid_context_sources";

// Phase 11.5C.1: a small, admin-curated set of facts about DRUID itself
// (product, positioning, ideal partner profile) -- grounds partner
// qualification in real DRUID context instead of an LLM's general
// knowledge. Deliberately NOT wired into Discovery/Channel Radar prompts
// yet (11.5C.3 -- see services/druidFacts.ts's listTrustedDruidFacts, which
// exists as the future read path but is called from nowhere in this
// slice).
//
// Phase 11.5C.2: sourceType now also supports "ingested" (a TS-level enum
// extension, not a migration, since this column is a constrained text
// field, not a native Postgres enum -- same convention as
// users.role/connections.providerType/discovery_exclusions.reason) --
// druidContextSources.ts's createIngestedDruidFact (via druidFacts.ts) is
// the only place that ever sets sourceType: "ingested". An ingested fact
// still starts verificationStatus: "unverified" exactly like a manual one --
// see verifyDruidFact below, the ONLY function that ever sets
// verificationStatus: "verified", unchanged by 11.5C.2.
export const DRUID_FACT_CATEGORIES = [
  "product",
  "positioning",
  "ideal_partner_profile",
  "technology_ecosystem",
  "proof_point",
  "other",
] as const;

export const DRUID_FACT_SOURCE_TYPES = ["manual", "ingested"] as const;

export const DRUID_FACT_VERIFICATION_STATUSES = ["unverified", "verified"] as const;

export const druidFactsTable = pgTable("druid_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  category: text("category", { enum: DRUID_FACT_CATEGORIES }).notNull(),
  factText: text("fact_text").notNull(),

  // Provenance. sourceUrl/sourceNote are both nullable at creation (some
  // facts -- e.g. an internal positioning statement -- have no single URL),
  // but services/druidFacts.ts's verifyDruidFact requires at least one of
  // them to be non-empty before verificationStatus can become "verified" --
  // a fact can never become trusted DRUID truth with zero provenance.
  sourceType: text("source_type", { enum: DRUID_FACT_SOURCE_TYPES }).notNull().default("manual"),
  sourceUrl: text("source_url"),
  sourceNote: text("source_note"),
  // Phase 11.5C.2: which extracted source version this fact was created
  // from, when sourceType is "ingested" -- null for manual facts. Never
  // client-settable (see DruidFactCreateInput/DruidFactUpdateInput in
  // routes/druid_facts.ts, which never accept it); set only by
  // createIngestedDruidFact.
  sourceContextId: uuid("source_context_id").references(() => druidContextSourcesTable.id),

  // Verification/approval state. Always starts "unverified" (server-set,
  // never client-supplied -- see routes/druid_facts.ts's narrow create
  // input). Reset to "unverified" by both updateDruidFact (any edit) and
  // reactivateDruidFact -- verification is never inherited across an edit
  // or a reactivation, only explicitly (re-)granted via verifyDruidFact.
  verificationStatus: text("verification_status", { enum: DRUID_FACT_VERIFICATION_STATUSES })
    .notNull()
    .default("unverified"),
  verifiedByUserId: uuid("verified_by_user_id").references(() => usersTable.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),

  // Lifecycle. Deactivation gets its own dedicated actor/timestamp pair,
  // distinct from updatedByUserId/updatedAt, because a later edit or
  // reactivation would otherwise overwrite "who deactivated this and when"
  // -- that history must survive subsequent mutations. Cleared (not
  // reinterpreted) on reactivation.
  active: boolean("active").notNull().default(true),
  deactivatedByUserId: uuid("deactivated_by_user_id").references(() => usersTable.id),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),

  createdByUserId: uuid("created_by_user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id").references(() => usersTable.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDruidFactSchema = createInsertSchema(druidFactsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDruidFact = z.infer<typeof insertDruidFactSchema>;
export type DruidFact = typeof druidFactsTable.$inferSelect;
