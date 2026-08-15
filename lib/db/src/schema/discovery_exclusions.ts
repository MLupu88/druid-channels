import { pgTable, text, uuid, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Phase 11.5A: a PAM's "don't suggest this company again" is a narrow,
// domain-scoped exclusion -- deliberately NOT a generic archive concept
// (see the Phase 11 audit: not_pursuing/closed/dismissed are each their own
// domain-specific state, and this is a fourth, equally narrow one, not a
// reusable archived_at column). Scope matches the existing
// scan_configs.excludedDomains precedent (one scan config per territory,
// already checked in discoveryEngine.ts): a company irrelevant in one
// territory's search may be legitimate in another, so exclusions are
// territory-scoped, never global.
export const DISCOVERY_EXCLUSION_REASONS = [
  "not_relevant",
  "wrong_match",
  "bad_source",
  "other",
] as const;
// "duplicate" is deliberately NOT in this list -- a duplicate RESULT does
// not mean the underlying company is illegitimate (see
// services/discoveryExclusions.ts). Removing a duplicate prospect uses the
// existing safe prospect delete alone, never this table.

export const discoveryExclusionsTable = pgTable("discovery_exclusions", {
  id: uuid("id").primaryKey().defaultRandom(),
  territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
  // The registrable domain (companyIdentity.ts's toRegistrableDomain,
  // matching how companies.domain itself is canonicalized) -- the primary
  // match key. Matching must work before a canonical company row even
  // exists for a re-discovered candidate, so this is never keyed solely on
  // companyId.
  domain: text("domain").notNull(),
  // Optional, set when a canonical company already existed at exclusion
  // time -- display/reference only, never the sole match key (see above).
  companyId: uuid("company_id").references(() => companiesTable.id),
  reason: text("reason", { enum: DISCOVERY_EXCLUSION_REASONS }).notNull(),
  note: text("note"),
  createdByUserId: uuid("created_by_user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // true = currently blocking future Discovery candidates for this domain
  // in this territory. false = restored (kept, not deleted, so who
  // excluded/restored it and why remains visible in Admin).
  active: boolean("active").notNull().default(true),
  restoredAt: timestamp("restored_at", { withTimezone: true }),
  restoredByUserId: uuid("restored_by_user_id").references(() => usersTable.id),
});

export const insertDiscoveryExclusionSchema = createInsertSchema(discoveryExclusionsTable).omit({ id: true, createdAt: true });
export type InsertDiscoveryExclusion = z.infer<typeof insertDiscoveryExclusionSchema>;
export type DiscoveryExclusion = typeof discoveryExclusionsTable.$inferSelect;
