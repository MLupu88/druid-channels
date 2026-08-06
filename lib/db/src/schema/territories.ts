import { pgTable, text, uuid, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const territoriesTable = pgTable("territories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  ownerUserId: uuid("owner_user_id"),
  countries: json("countries").$type<string[]>().notNull().default([]),
  languages: json("languages").$type<string[]>().notNull().default([]),
});

export const insertTerritorySchema = createInsertSchema(territoriesTable).omit({ id: true });
export type InsertTerritory = z.infer<typeof insertTerritorySchema>;
export type Territory = typeof territoriesTable.$inferSelect;
