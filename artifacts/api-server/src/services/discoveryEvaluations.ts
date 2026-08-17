import { db } from "@workspace/db";
import { discoveryEvaluationsTable, DISCOVERY_EVALUATION_OUTCOMES } from "@workspace/db";
import { desc } from "drizzle-orm";
import type { ExistingQualificationRecord } from "./discoveryBudget";

// Partner Radar recall fix (novelty prioritization): the durable evaluation
// ledger's read/write service, alongside discoveryEngine.ts's own
// knownDomainRecords cache -- see discovery_evaluations.ts's schema comment
// for why this is global-by-domain, not territory-scoped.

export type DiscoveryEvaluationOutcome = (typeof DISCOVERY_EVALUATION_OUTCOMES)[number];

export interface RecordDiscoveryEvaluationInput {
  domain: string;
  outcome: DiscoveryEvaluationOutcome;
  territoryId: string;
  scanRunId: string;
}

// Always inserts -- append-only ledger, never an upsert. Caller (see
// discoveryEngine.ts's Stage 4 loop) is responsible for only calling this
// once a real AI qualification has produced a valid decision: a transient
// provider failure, timeout, or malformed/truncated response must never
// reach here, so those paths in discoveryEngine.ts `continue`/`throw`
// before this function is ever invoked -- this function itself does not
// (and cannot) distinguish "a valid rejection" from "a failed call", it
// simply trusts the caller's contract, exactly like persistCandidate trusts
// its own caller for the equivalent qualified-path guarantee.
export async function recordDiscoveryEvaluation(input: RecordDiscoveryEvaluationInput): Promise<void> {
  await db.insert(discoveryEvaluationsTable).values({
    domain: input.domain,
    outcome: input.outcome,
    territoryId: input.territoryId,
    scanRunId: input.scanRunId,
  });
}

// Loads the single most-recent evaluation row per domain, across ALL
// territories/scan runs (global -- see schema comment), shaped as
// ExistingQualificationRecord so callers can feed it directly into the
// exact same shouldReuseExistingQualification/recencyWindowDays freshness
// check discoveryEngine.ts's companies/prospects "known domain" cache
// already uses -- one freshness rule, two data sources merged into one map,
// not two competing freshness concepts. lastResearchedAt and createdAt are
// both set to evaluatedAt (there is no separate "re-touched" timestamp for
// a ledger row the way a prospect has); shouldReuseExistingQualification
// only ever reads whichever of the two is present, so this is harmless.
//
// Unbounded by design, same as the existing companies/prospects query it's
// merged with in discoveryEngine.ts -- this table is expected to stay small
// relative to companies/prospects for the foreseeable future; revisit with
// a DISTINCT ON / date-bounded query if it ever doesn't.
export async function loadRecentEvaluationRecords(): Promise<Map<string, ExistingQualificationRecord>> {
  const rows = await db
    .select({ domain: discoveryEvaluationsTable.domain, evaluatedAt: discoveryEvaluationsTable.evaluatedAt })
    .from(discoveryEvaluationsTable)
    .orderBy(desc(discoveryEvaluationsTable.evaluatedAt));

  const records = new Map<string, ExistingQualificationRecord>();
  for (const row of rows) {
    // Rows are ordered newest-first, so the first row seen for a domain is
    // already its most recent -- never overwritten by an older one.
    if (!records.has(row.domain)) {
      records.set(row.domain, { lastResearchedAt: row.evaluatedAt, createdAt: row.evaluatedAt });
    }
  }
  return records;
}
