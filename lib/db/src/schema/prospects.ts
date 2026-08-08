import { pgTable, text, uuid, boolean, timestamp, numeric, date } from "drizzle-orm/pg-core";
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
  // Fields used once a prospect becomes an existing "Partner" (status accepted/pushed_to_hubspot).
  helpNeededType: text("help_needed_type", {
    enum: ["none", "intro_to_customer", "pricing_support", "legal_review", "exec_sponsorship", "other"],
  }).notNull().default("none"),
  helpNeededNote: text("help_needed_note"),
  lastResearchedAt: timestamp("last_researched_at", { withTimezone: true }),
  // Provenance of the discovery run that created this prospect: "demo" when
  // no live search/reader/AI provider was connected at discovery time,
  // "connected" once a live provider chain produced it. Never fabricated --
  // mirrors the DataStatus convention used for KPIs (see kpi-honesty memory).
  discoverySourceStatus: text("discovery_source_status", { enum: ["demo", "connected"] }).notNull().default("demo"),
  // The literal spec-section-10 rule that produced this prospect's priority
  // at discovery time (e.g. "3 of 5 checks passed..."). Stored rather than
  // re-derived, since re-deriving would need the originating scan config's
  // min_checks_required and prospects don't carry a scan-config link.
  priorityRationale: text("priority_rationale"),
  pipelineSourced: numeric("pipeline_sourced"),
  pipelineInfluenced: numeric("pipeline_influenced"),
  revenueClosed: numeric("revenue_closed"),
  renewalDate: date("renewal_date", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProspectSchema = createInsertSchema(prospectsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProspect = z.infer<typeof insertProspectSchema>;
export type Prospect = typeof prospectsTable.$inferSelect;
