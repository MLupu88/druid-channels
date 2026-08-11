// Stage 6 PAM Portfolio book import: orchestrates the three-layer pipeline
// (source -> deterministic extraction + DeepSeek normalization ->
// deterministic company matching -> PAM review -> canonical
// partner_relationships). No scheduler/job queue exists in this app (by
// design, see the Stage 6 non-goals) so a batch is processed synchronously
// inside the creating request -- bounded by MAX_IMPORT_ROWS and chunked
// DeepSeek calls (see normalization.ts) to keep that request's cost and
// duration reasonable.
import { db } from "@workspace/db";
import {
  portfolioImportBatchesTable,
  portfolioImportRowsTable,
  companiesTable,
  PORTFOLIO_IMPORT_MATCH_STATUSES,
  type PortfolioImportBatch,
  type PortfolioImportRow,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import * as normalizationProvider from "./portfolioImportProviders/normalization";
import { classifyDatePhrase, resolveCompanyMatch, normalizeCompanyName } from "./companyMatchingService";
import { toRegistrableDomain } from "./companyIdentity";
import { createRelationshipIfMissing, findRelationshipByCompanyAndTerritory } from "./partnerRelationshipService";
import { backfillRadarSignalsForCompany } from "./radarCompanyBridge";
import { logger } from "../lib/logger";

export type PortfolioImportMatchStatus = (typeof PORTFOLIO_IMPORT_MATCH_STATUSES)[number];

// v1 hard cap -- a PAM book realistically has tens to low hundreds of
// partners, never a full CRM export. Chosen with headroom over a typical
// book (a few hundred rows) while still refusing anything CRM-export-sized.
export const MAX_IMPORT_ROWS = 300;

export class ImportEmptyBatchError extends Error {}
export class ImportRowLimitExceededError extends Error {}
export class ImportPastedTextScopeError extends Error {}
export class ImportNormalizationUnavailableError extends Error {}
export class ImportRowNotConfirmableError extends Error {}

const HEADER_ALIASES: Record<string, string[]> = {
  companyName: ["partner", "account", "company", "company name", "partner name", "organization"],
  country: ["country", "region", "location"],
  partnerType: ["partner type", "type", "technology", "tech", "tier"],
  domain: ["domain", "website", "url", "web"],
  nextAction: ["opportunity", "next action", "next step", "follow up"],
  startedAt: ["partner since", "since", "start date", "relationship since"],
  summary: ["comments", "notes", "summary", "description", "context"],
};

function lookupHeader(row: Record<string, string>, aliases: string[]): string | null {
  const lowerEntries = Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v] as const);
  for (const alias of aliases) {
    const hit = lowerEntries.find(([k]) => k === alias);
    if (hit && hit[1]?.trim()) return hit[1].trim();
  }
  return null;
}

export interface DeterministicHints {
  companyName: string | null;
  domain: string | null;
  country: string | null;
  partnerType: string | null;
  nextAction: string | null;
  startedAtRaw: string | null;
  summaryRaw: string | null;
}

// Deterministic only -- no LLM call. For pasted_text rows (a single "text"
// key, no real headers), nothing maps cleanly so every field stays null;
// DeepSeek does the actual extraction from the free text in that case.
export function extractDeterministicHints(row: Record<string, string>): DeterministicHints {
  return {
    companyName: lookupHeader(row, HEADER_ALIASES.companyName!),
    domain: lookupHeader(row, HEADER_ALIASES.domain!),
    country: lookupHeader(row, HEADER_ALIASES.country!),
    partnerType: lookupHeader(row, HEADER_ALIASES.partnerType!),
    nextAction: lookupHeader(row, HEADER_ALIASES.nextAction!),
    startedAtRaw: lookupHeader(row, HEADER_ALIASES.startedAt!),
    summaryRaw: lookupHeader(row, HEADER_ALIASES.summary!),
  };
}

export interface NormalizedProposal {
  [key: string]: unknown;
  company_name: string | null;
  domain: string | null;
  country: string | null;
  partner_type: string | null;
  relationship_summary: string | null;
  status_hint: "active" | "dormant" | "unknown";
  relationship_started_at: string | null;
  started_at_precision: string;
  next_action: string | null;
  confidence: string;
  needs_review: boolean;
  reasons: string[];
}

// Priority order when several conditions could apply to the same row --
// the most specific/blocking issue always wins, and ambiguity always beats
// a confident-looking auto-match (never silently merge).
export function resolveMatchStatus(opts: {
  hasCompanyName: boolean;
  deterministicStatus: "matched_existing_company" | "possible_duplicate" | "ready" | "invalid";
  hasExistingRelationship: boolean;
  needsReview: boolean;
}): PortfolioImportMatchStatus {
  if (!opts.hasCompanyName || opts.deterministicStatus === "invalid") return "invalid";
  if (opts.hasExistingRelationship) return "existing_relationship";
  if (opts.deterministicStatus === "possible_duplicate") return "possible_duplicate";
  if (opts.needsReview) return "needs_review";
  return opts.deterministicStatus;
}

async function buildNormalizedProposal(
  sourceRaw: Record<string, string>,
  hints: DeterministicHints,
  normalized: normalizationProvider.NormalizationRowOutput | null,
): Promise<{ proposal: NormalizedProposal; matchStatus: PortfolioImportMatchStatus; matchedCompanyId: string | null }> {
  const companyName = normalized?.companyName ?? hints.companyName;
  const domain = normalized?.domain ?? hints.domain;
  const country = normalized?.country ?? hints.country;
  const partnerType = normalized?.partnerType ?? hints.partnerType;
  const summary = normalized?.relationshipSummary ?? hints.summaryRaw;
  const nextAction = normalized?.nextAction ?? hints.nextAction;
  const startedAtRaw = normalized?.relationshipStartedAtRawText ?? hints.startedAtRaw;
  const dateClassification = classifyDatePhrase(startedAtRaw);
  const statusHint = normalized?.statusHint ?? "unknown";
  const needsReview = normalized?.needsReview ?? true; // no normalization output at all is itself a review case

  const proposal: NormalizedProposal = {
    company_name: companyName,
    domain,
    country,
    partner_type: partnerType,
    relationship_summary: summary,
    status_hint: statusHint,
    relationship_started_at: dateClassification.value,
    started_at_precision: dateClassification.precision,
    next_action: nextAction,
    confidence: normalized?.confidence ?? "low",
    needs_review: needsReview,
    reasons: normalized?.reasons ?? [],
  };

  return { proposal, matchStatus: "invalid", matchedCompanyId: null }; // matching resolved by caller (needs territoryId)
}

export interface CreateImportBatchInput {
  territoryId: string;
  sourceFormat: "excel" | "csv" | "pasted_text";
  originalFilename: string | null;
  rows: Record<string, string>[];
}

export async function createImportBatch(
  input: CreateImportBatchInput,
  actingUserId: string,
): Promise<{ batch: PortfolioImportBatch; rows: PortfolioImportRow[] }> {
  if (input.rows.length === 0) throw new ImportEmptyBatchError("No rows to import.");
  if (input.rows.length > MAX_IMPORT_ROWS) {
    throw new ImportRowLimitExceededError(`Import is limited to ${MAX_IMPORT_ROWS} rows per batch (received ${input.rows.length}).`);
  }
  if (input.sourceFormat === "pasted_text" && input.rows.length > 1) {
    throw new ImportPastedTextScopeError("Pasted-text import supports one partner relationship description per import in v1.");
  }
  if (!(await normalizationProvider.isConfigured())) {
    throw new ImportNormalizationUnavailableError("AI normalization is not connected. Configure a connection before importing a Portfolio book.");
  }

  const [batch] = await db
    .insert(portfolioImportBatchesTable)
    .values({
      territoryId: input.territoryId,
      createdByUserId: actingUserId,
      sourceFormat: input.sourceFormat,
      originalFilename: input.originalFilename,
      rowCount: input.rows.length,
      status: "processing",
    })
    .returning();

  const hintsByIndex = input.rows.map((row) => extractDeterministicHints(row));

  // Chunked, bounded DeepSeek calls -- never one call per row.
  const normalizedByIndex = new Map<number, normalizationProvider.NormalizationRowOutput>();
  try {
    for (let start = 0; start < input.rows.length; start += normalizationProvider.MAX_ROWS_PER_NORMALIZATION_CALL) {
      const chunk = input.rows.slice(start, start + normalizationProvider.MAX_ROWS_PER_NORMALIZATION_CALL);
      const chunkHints = hintsByIndex.slice(start, start + normalizationProvider.MAX_ROWS_PER_NORMALIZATION_CALL);
      const results = await normalizationProvider.normalizeRows(
        chunk.map((sourceRaw, i) => ({
          rowIndex: start + i,
          sourceRaw,
          deterministicHints: {
            companyName: chunkHints[i]!.companyName,
            domain: chunkHints[i]!.domain,
            country: chunkHints[i]!.country,
            partnerType: chunkHints[i]!.partnerType,
          },
        })),
      );
      for (const r of results) normalizedByIndex.set(r.rowIndex, r);
    }
  } catch (err) {
    await db
      .update(portfolioImportBatchesTable)
      .set({ status: "failed", errorMessage: "Normalization failed. Please try again.", completedAt: new Date() })
      .where(eq(portfolioImportBatchesTable.id, batch!.id));
    logger.error({ batchId: batch!.id, errorName: err instanceof Error ? err.name : typeof err }, "Portfolio import normalization failed");
    throw err;
  }

  const rowsToInsert = [];
  for (let i = 0; i < input.rows.length; i++) {
    const hints = hintsByIndex[i]!;
    const normalized = normalizedByIndex.get(i) ?? null;
    const { proposal } = await buildNormalizedProposal(input.rows[i]!, hints, normalized);

    const hasCompanyName = !!proposal.company_name?.trim();
    let matchedCompanyId: string | null = null;
    let deterministicStatus: "matched_existing_company" | "possible_duplicate" | "ready" | "invalid" = "invalid";
    let hasExistingRelationship = false;

    if (hasCompanyName) {
      const match = await resolveCompanyMatch({ name: proposal.company_name, domain: proposal.domain, country: proposal.country }, input.territoryId);
      matchedCompanyId = match.matchedCompanyId;
      deterministicStatus = match.status;
      hasExistingRelationship = match.hasExistingRelationshipInTerritory;
    }

    const matchStatus = resolveMatchStatus({
      hasCompanyName,
      deterministicStatus,
      hasExistingRelationship,
      needsReview: proposal.needs_review,
    });

    rowsToInsert.push({
      batchId: batch!.id,
      rowIndex: i,
      sourceRaw: input.rows[i]!,
      normalizedProposal: proposal,
      matchStatus,
      matchedCompanyId,
    });
  }

  const insertedRows = rowsToInsert.length
    ? await db.insert(portfolioImportRowsTable).values(rowsToInsert).returning()
    : [];

  await db
    .update(portfolioImportBatchesTable)
    .set({ status: "ready_for_review", completedAt: new Date() })
    .where(eq(portfolioImportBatchesTable.id, batch!.id));

  const [finalBatch] = await db.select().from(portfolioImportBatchesTable).where(eq(portfolioImportBatchesTable.id, batch!.id));
  return { batch: finalBatch!, rows: insertedRows };
}

export function computeBatchCounts(rows: { matchStatus: string }[]): Record<PortfolioImportMatchStatus, number> {
  const counts: Record<PortfolioImportMatchStatus, number> = {
    ready: 0,
    matched_existing_company: 0,
    possible_duplicate: 0,
    existing_relationship: 0,
    needs_review: 0,
    invalid: 0,
  };
  for (const r of rows) {
    if (r.matchStatus in counts) counts[r.matchStatus as PortfolioImportMatchStatus]++;
  }
  return counts;
}

const CONFIRMABLE_STATUSES: PortfolioImportMatchStatus[] = ["ready", "matched_existing_company", "existing_relationship"];

// Confirms one row into the canonical model. Idempotent: re-confirming an
// already-resolved row just returns its existing resulting_relationship_id
// rather than creating a second one.
export async function confirmImportRow(row: PortfolioImportRow, territoryId: string, actingUserId: string): Promise<PortfolioImportRow> {
  if (row.resultingRelationshipId) return row; // already confirmed -- idempotent no-op

  if (!CONFIRMABLE_STATUSES.includes(row.matchStatus as PortfolioImportMatchStatus)) {
    throw new ImportRowNotConfirmableError(
      `Row is "${row.matchStatus}" and must be resolved (pick/clear a matched company) before it can be confirmed.`,
    );
  }

  const proposal = (row.normalizedProposal ?? {}) as Partial<NormalizedProposal>;

  return db.transaction(async (tx) => {
    if (row.matchStatus === "existing_relationship" && row.matchedCompanyId) {
      const existing = await findRelationshipByCompanyAndTerritory(row.matchedCompanyId, territoryId);
      if (!existing) throw new ImportRowNotConfirmableError("Expected an existing relationship but none was found.");
      const [updated] = await tx
        .update(portfolioImportRowsTable)
        .set({ resultingRelationshipId: existing.id, resolvedAt: new Date(), resolvedByUserId: actingUserId })
        .where(eq(portfolioImportRowsTable.id, row.id))
        .returning();
      return updated!;
    }

    let companyId = row.matchedCompanyId;
    if (!companyId) {
      if (!proposal.company_name?.trim()) throw new ImportRowNotConfirmableError("Row has no company name.");
      if (!proposal.country?.trim()) {
        throw new ImportRowNotConfirmableError("A country is required before a new company can be created. Edit the row to add one.");
      }
      const [newCompany] = await tx
        .insert(companiesTable)
        .values({
          name: proposal.company_name.trim(),
          normalizedName: normalizeCompanyName(proposal.company_name),
          // Phase 3A: canonical registrable domain, same helper as Discovery
          // (see companyIdentity.ts) -- never a fabricated placeholder, and
          // never a raw import-sheet value (e.g. "www.example.com" or a
          // full profile URL) stored verbatim.
          domain: toRegistrableDomain(proposal.domain),
          country: proposal.country.trim(),
        })
        .returning();
      companyId = newCompany!.id;
      backfillRadarSignalsForCompany(companyId, proposal.company_name.trim()).catch(() => {});
    }

    const { relationship } = await createRelationshipIfMissing(
      {
        companyId,
        territoryId,
        status: proposal.status_hint === "dormant" ? "dormant" : "active",
        partnerType: proposal.partner_type ?? null,
        relationshipSummary: proposal.relationship_summary ?? null,
        relationshipStartedAt: proposal.relationship_started_at ?? null,
        startedAtPrecision: (proposal.started_at_precision as any) ?? "unknown",
        startedAtProvenance: "inferred",
        nextAction: proposal.next_action ?? null,
        originType: "pam_import",
        importedAt: new Date(),
      },
      actingUserId,
      tx,
    );

    const [updated] = await tx
      .update(portfolioImportRowsTable)
      .set({ matchedCompanyId: companyId, resultingRelationshipId: relationship.id, resolvedAt: new Date(), resolvedByUserId: actingUserId })
      .where(eq(portfolioImportRowsTable.id, row.id))
      .returning();
    return updated!;
  });
}

export async function confirmReadyRows(batchId: string, territoryId: string, actingUserId: string): Promise<{ confirmedCount: number; skippedCount: number }> {
  const rows = await db
    .select()
    .from(portfolioImportRowsTable)
    .where(
      and(
        eq(portfolioImportRowsTable.batchId, batchId),
        inArray(portfolioImportRowsTable.matchStatus, ["ready", "matched_existing_company"]),
      ),
    );

  let confirmedCount = 0;
  let skippedCount = 0;
  for (const row of rows) {
    try {
      await confirmImportRow(row, territoryId, actingUserId);
      confirmedCount++;
    } catch (err) {
      skippedCount++;
      logger.warn({ rowId: row.id, errorName: err instanceof Error ? err.name : typeof err }, "Portfolio import: bulk confirm skipped a row");
    }
  }
  return { confirmedCount, skippedCount };
}
