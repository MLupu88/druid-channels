import { pgTable, text, uuid, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";

export const prospectsTable = pgTable("prospects", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
  assignedUserId: uuid("assigned_user_id").references(() => usersTable.id),
  partnerType: text("partner_type").notNull(),
  priority: text("priority", { enum: ["A", "B"] }).notNull(),
  enterpriseAccess: boolean("enterprise_access").notNull().default(false),
  relevantCapability: boolean("relevant_capability").notNull().default(false),
  technologyAdjacency: boolean("technology_adjacency").notNull().default(false),
  partnershipOpenness: boolean("partnership_openness").notNull().default(false),
  recentTrigger: boolean("recent_trigger").notNull().default(false),
  whyItFits: text("why_it_fits").notNull(),
  whyNow: text("why_now").notNull(),
  suggestedAngle: text("suggested_angle"),
  suggestedTargetRole: text("suggested_target_role"),
  suggestedMessage: text("suggested_message"),
  status: text("status", {
    enum: ["new", "accepted", "rejected", "deferred", "pushed_to_hubspot"],
  }).notNull().default("new"),
  rejectionReason: text("rejection_reason"),
  pamNote: text("pam_note"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  hubspotCompanyId: text("hubspot_company_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProspectSchema = createInsertSchema(prospectsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProspect = z.infer<typeof insertProspectSchema>;
export type Prospect = typeof prospectsTable.$inferSelect;
