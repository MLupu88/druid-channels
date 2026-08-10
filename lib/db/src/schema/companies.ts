import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companiesTable = pgTable("companies", {
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
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
