import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";
import { scanRunsTable } from "./scan_runs";

// Partner Radar recall fix (novelty prioritization): a durable, append-only
// ledger of every AI qualification call that produced a VALID decision --
// pass or fail. Before this table existed, a candidate that failed
// qualifyChecks (or was later found archetype-ineligible) had NO durable
// representation anywhere: no companies row, no signals row, no prospects
// row -- only an ephemeral logger.warn/info line. That meant every repeat
// scan re-spent a full AI qualification call on the exact same
// already-rejected evidence, forever, crowding out genuinely unseen
// companies from the bounded MAX_CANDIDATES_TO_LLM pool.
//
// Global by domain, deliberately NOT territory-scoped -- this mirrors
// discoveryEngine.ts's existing companies/prospects "known domain" freshness
// cache (knownDomainRecords), not discovery_exclusions' territory scoping.
// The two existing precedents encode two different kinds of fact:
//   - discovery_exclusions is a RELEVANCE judgment ("not a fit for this
//     territory") -- a company excluded in one territory can be legitimate
//     in another, so it's territory-scoped on purpose.
//   - knownDomainRecords is a COST-CONTROL judgment ("we already spent an AI
//     call assessing this evidence recently") -- a property of the company's
//     evidence itself, not of which territory happened to run the scan. This
//     table extends that exact existing mechanism, so it follows the same
//     global scoping for internal consistency.
// territoryId/scanRunId below are informational/traceability only -- never
// part of the freshness lookup key (see discoveryEvaluations.ts).
export const DISCOVERY_EVALUATION_OUTCOMES = ["qualified", "rejected"] as const;

export const discoveryEvaluationsTable = pgTable(
  "discovery_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The registrable domain (companyIdentity.ts's toRegistrableDomain, same
    // canonicalization as companies.domain) -- the sole freshness lookup
    // key. Never companyId-only: a rejected candidate never gets a
    // companies row created for it (see discoveryEngine.ts), so domain must
    // stand alone here, same reasoning as discovery_exclusions.domain.
    domain: text("domain").notNull(),
    // "qualified" = this evidence cleared qualifyChecks (regardless of what
    // happened after -- recruitment-archetype eligibility, territory
    // suppression, etc. are separate, later business rules, not re-litigated
    // here). "rejected" = qualifyChecks returned no priority. Never written
    // for a transient provider failure, timeout, or malformed/truncated AI
    // response -- see discoveryEvaluations.ts's recordDiscoveryEvaluation
    // doc comment: only a VALID AI decision reaches this table.
    outcome: text("outcome", { enum: DISCOVERY_EVALUATION_OUTCOMES }).notNull(),
    territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
    scanRunId: uuid("scan_run_id").notNull().references(() => scanRunsTable.id),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Lookup is always "most recent row for this domain" -- see
    // loadRecentEvaluationRecords. Not unique: this is an append-only
    // ledger, many rows per domain over time are expected and desired.
    index("discovery_evaluations_domain_idx").on(table.domain),
  ],
);

export const insertDiscoveryEvaluationSchema = createInsertSchema(discoveryEvaluationsTable).omit({ id: true, evaluatedAt: true });
export type InsertDiscoveryEvaluation = z.infer<typeof insertDiscoveryEvaluationSchema>;
export type DiscoveryEvaluation = typeof discoveryEvaluationsTable.$inferSelect;
