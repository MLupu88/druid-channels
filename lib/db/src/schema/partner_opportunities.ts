import { pgTable, text, uuid, numeric, timestamp, date, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";

// Phase 5A: the smallest coherent deal ledger -- NOT a CRM replacement and
// NOT a HubSpot sync target yet (see services/hubspot.ts, still a pure
// stub). company_id is the durable partner link -- deliberately no
// partner_relationship_id FK, since an opportunity can legitimately exist
// before a company has reached Portfolio (e.g. a deal sourced through a
// still-in-Recruitment partner). No onDelete cascade on company_id/
// territory_id/assigned_user_id -- same "commercial/history record, never
// silently destroyed by an unrelated deletion" convention already used by
// partner_recruitments/partner_relationships (this app has no user/company/
// territory hard-deletion capability in the first place).
export const OPPORTUNITY_ATTRIBUTION_TYPES = ["partner_sourced", "partner_influenced"] as const;
export const OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const;
// Matches services/fx.ts's SupportedCurrency exactly -- one shared currency
// vocabulary across the app, never a second one invented here.
export const OPPORTUNITY_CURRENCIES = ["USD", "EUR", "GBP"] as const;
// Source-neutral identity, added ahead of the actual HubSpot integration so
// manual/imported rows already live in the same shape a future sync will
// upsert into. "manual" is what a PAM creates by hand in this app; "import"
// is reserved for a future bulk-backfill path (e.g. a CSV cutover load);
// "hubspot" is reserved for the not-yet-built live sync (services/hubspot.ts
// is still a pure stub -- this enum value existing does NOT mean sync exists
// yet). No HubSpot-specific deal columns are added here.
export const OPPORTUNITY_SOURCE_SYSTEMS = ["manual", "import", "hubspot"] as const;

export const partnerOpportunitiesTable = pgTable(
  "partner_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    companyId: uuid("company_id").notNull().references(() => companiesTable.id),
    territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
    assignedUserId: uuid("assigned_user_id").notNull().references(() => usersTable.id),
    attributionType: text("attribution_type", { enum: OPPORTUNITY_ATTRIBUTION_TYPES }).notNull(),
    status: text("status", { enum: OPPORTUNITY_STATUSES }).notNull().default("open"),
    dealValue: numeric("deal_value").notNull(),
    currency: text("currency", { enum: OPPORTUNITY_CURRENCIES }).notNull().default("USD"),
    // The real business date the opportunity was created -- deliberately
    // NOT createdAt (a system/audit timestamp, see below). Drives
    // "Opportunities Created" reporting; a deal entered into the app late
    // must still report against the quarter it was actually opened in. Also
    // the field backfilled historical/pre-go-live opportunities must set
    // honestly (the real original open date), never today's date.
    opportunityDate: date("opportunity_date", { mode: "string" }).notNull(),
    expectedCloseDate: date("expected_close_date", { mode: "string" }),
    // The real business/CRM close date. Nullable at the schema level;
    // application validation (routes/opportunities.ts) requires this to be
    // set whenever status="won" -- never enforced as a DB CHECK, since a
    // not-yet-won deal legitimately has no close date at all. Historical
    // cutover: this must stay the TRUE close date (e.g. 2025-11-15) even
    // when the deal is being credited to a later target period -- see
    // creditDate below. Never falsified to make a historical deal look
    // like it closed inside the current target period.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Target-attainment override, independent of the closed-revenue report.
    // Most rows leave both null and fall back to dealValue/closedAt. Exists
    // for historical cutover: a contract that really closed in 2025 but is
    // legitimately being counted toward a 2026 channel target gets
    // creditDate = 2026-01-01 (or whenever it should land) and, if the
    // credited amount differs from the deal's own value (e.g. only a
    // renewal slice counts), creditValue holds that amount. closedAt is
    // NEVER edited to achieve this -- it must always stay the true date.
    creditValue: numeric("credit_value"),
    creditDate: date("credit_date", { mode: "string" }),
    // Free text, deliberately not a second customer/account entity -- see
    // the Phase 5A brief's explicit "do not build CRM complexity."
    customerName: text("customer_name"),
    note: text("note"),
    // Source-neutral identity (see OPPORTUNITY_SOURCE_SYSTEMS above).
    // externalId is null for every manually-created row; it's the foreign
    // record ID once an import or HubSpot sync populates a row, letting a
    // future sync upsert by (sourceSystem, externalId) instead of creating
    // duplicates. sourceUpdatedAt/lastSyncedAt are both null until a
    // non-manual source actually writes here -- no live provider call is
    // made by this schema change itself.
    sourceSystem: text("source_system", { enum: OPPORTUNITY_SOURCE_SYSTEMS }).notNull().default("manual"),
    externalId: text("external_id"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("partner_opportunities_deal_value_positive", sql`${table.dealValue} > 0`),
    // NULL satisfies a Postgres CHECK (unknown is treated as passing), so
    // this allows creditValue to stay unset while still rejecting a
    // non-positive value whenever one is provided.
    check("partner_opportunities_credit_value_positive", sql`${table.creditValue} is null or ${table.creditValue} > 0`),
    // Prevents a future import/HubSpot sync from ever inserting the same
    // foreign record twice under the same source. Deliberately scoped to
    // externalId IS NOT NULL so manual rows (always null) never collide with
    // each other, and scoped per sourceSystem so "hubspot" and "import" may
    // reuse the same externalId value without colliding with each other.
    uniqueIndex("partner_opportunities_source_external_unique")
      .on(table.sourceSystem, table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

export const insertPartnerOpportunitySchema = createInsertSchema(partnerOpportunitiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPartnerOpportunity = z.infer<typeof insertPartnerOpportunitySchema>;
export type PartnerOpportunity = typeof partnerOpportunitiesTable.$inferSelect;
