// Stage 6: activates the channel_radar_signals.company_id bridge Stage 5
// added but never populated. Deterministic only -- no LLM, no fuzzy match:
// an exact normalized-name match against the companies table, and only
// when it resolves to exactly one company. Ambiguous or no match always
// stays null; this never invents a link.
import { db } from "@workspace/db";
import { companiesTable, channelRadarSignalsTable, type Company } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { normalizeCompanyName } from "./companyMatchingService";

// Pure, DB-free -- takes an already-fetched candidate set so it can be unit
// tested directly (see resolveSafeCompanyIdForEntityName below for the
// DB-backed wrapper). Returns the single unambiguous match's id, or null on
// zero or multiple matches -- ambiguity always stays unlinked, never a
// best-effort guess.
export function pickSafeCompanyMatch(entityName: string, candidates: Company[]): string | null {
  const normalized = normalizeCompanyName(entityName);
  if (!normalized) return null;
  const matches = candidates.filter((c) => normalizeCompanyName(c.name) === normalized);
  return matches.length === 1 ? matches[0]!.id : null;
}

// Called at Radar-signal-insert time (see channelRadarEngine.ts). A fresh
// company lookup per signal is acceptable here -- Radar runs are already
// bounded (MAX_RADAR_QUERIES) and manual (no schedulers), so this never
// runs at a volume that matters.
export async function resolveSafeCompanyIdForEntityName(entityName: string): Promise<string | null> {
  const allCompanies = await db.select().from(companiesTable);
  return pickSafeCompanyMatch(entityName, allCompanies);
}

// Called once a company is confirmed into the canonical Portfolio (manual
// add or import row confirm) -- resolves any previously-unresolved Radar
// signals for that same company, now that its canonical name is known to
// exist. Skipped entirely if the name is ambiguous (more than one company
// shares it), same safety rule as resolveSafeCompanyIdForEntityName.
export async function backfillRadarSignalsForCompany(companyId: string, companyName: string): Promise<number> {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return 0;

  const allCompanies = await db.select().from(companiesTable);
  const matchingCompanies = allCompanies.filter((c) => normalizeCompanyName(c.name) === normalized);
  if (matchingCompanies.length !== 1 || matchingCompanies[0]!.id !== companyId) return 0;

  const unresolvedSignals = await db.select().from(channelRadarSignalsTable).where(isNull(channelRadarSignalsTable.companyId));
  const toBackfill = unresolvedSignals.filter((s) => normalizeCompanyName(s.entityName) === normalized);
  if (toBackfill.length === 0) return 0;

  await Promise.all(
    toBackfill.map((s) => db.update(channelRadarSignalsTable).set({ companyId }).where(eq(channelRadarSignalsTable.id, s.id))),
  );
  return toBackfill.length;
}
