import { pgTable, text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companiesTable = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name"),
    // Nullable as of Stage 6.1 -- Manual Add / PAM Portfolio import may create
    // a company with no known domain. Never fabricate a placeholder here
    // (e.g. "unknown-<timestamp>.example"); Discovery/Recruitment continue to
    // always resolve a real domain before creating a company, so this stays
    // non-null in practice for those paths.
    domain: text("domain"),
    websiteUrl: text("website_url"),
    country: text("country").notNull(),
    headquarters: text("headquarters"),
    employeeBand: text("employee_band"),
    description: text("description"),
    linkedinUrl: text("linkedin_url"),
    hubspotCompanyId: text("hubspot_company_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Phase 3B: at most one company row per canonical registrable domain.
    // Plain `domain`, not `LOWER(domain)` -- every write path (Discovery's
    // resolveOrCreateCanonicalCompany, Portfolio manual-add, PAM book
    // import) already stores the lowercased, PSL-canonicalized value via
    // services/companyIdentity.ts's toRegistrableDomain before this column
    // is ever written, so a case-folding expression index would be
    // redundant defense for a property application code already
    // guarantees at every insert site. NULL domains are excluded (many
    // companies legitimately have none) and never collide with each other
    // under a partial index. This does NOT retroactively deduplicate any
    // pre-existing non-canonical row -- see the Phase 3B audit tool's
    // NON_CANONICAL_ROWS section for that.
    uniqueIndex("companies_domain_unique").on(table.domain).where(sql`${table.domain} is not null`),
  ],
);

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
