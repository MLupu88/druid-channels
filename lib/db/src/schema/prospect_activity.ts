import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { prospectsTable } from "./prospects";
import { usersTable } from "./users";

export const prospectActivityTable = pgTable("prospect_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  prospectId: uuid("prospect_id").notNull().references(() => prospectsTable.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id),
  eventType: text("event_type", {
    enum: ["discovered", "reviewed", "accepted", "rejected", "deferred", "hubspot_pushed", "note_added"],
  }).notNull(),
  note: text("note"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProspectActivitySchema = createInsertSchema(prospectActivityTable).omit({ id: true });
export type InsertProspectActivity = z.infer<typeof insertProspectActivitySchema>;
export type ProspectActivity = typeof prospectActivityTable.$inferSelect;
