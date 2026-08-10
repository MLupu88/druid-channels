import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { portfolioImportBatchesTable, portfolioImportRowsTable, territoriesTable, companiesTable, type PortfolioImportRow } from "@workspace/db";
import {
  ListPortfolioImportsQueryParams,
  ListPortfolioImportsResponse,
  CreatePortfolioImportBody,
  CreatePortfolioImportResponse,
  GetPortfolioImportResponse,
  UpdatePortfolioImportRowBody,
  UpdatePortfolioImportRowResponse,
  ConfirmPortfolioImportRowResponse,
  ConfirmPortfolioImportReadyResponse,
} from "@workspace/api-zod";
import { eq, inArray } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory, assertRecordTerritoryAccess, ForbiddenScopeError } from "../services/authz";
import {
  createImportBatch,
  computeBatchCounts,
  confirmImportRow,
  confirmReadyRows,
  ImportEmptyBatchError,
  ImportRowLimitExceededError,
  ImportPastedTextScopeError,
  ImportNormalizationUnavailableError,
  ImportRowNotConfirmableError,
} from "../services/portfolioImportEngine";
import { resolveCompanyMatch } from "../services/companyMatchingService";

const router: IRouter = Router();

function shapeImportRow(row: PortfolioImportRow, matchedCompany: typeof companiesTable.$inferSelect | null) {
  return {
    id: row.id,
    row_index: row.rowIndex,
    source_raw: row.sourceRaw,
    normalized_proposal: row.normalizedProposal,
    match_status: row.matchStatus,
    matched_company: matchedCompany
      ? { id: matchedCompany.id, name: matchedCompany.name, domain: matchedCompany.domain, country: matchedCompany.country }
      : null,
    review_note: row.reviewNote,
    resulting_relationship_id: row.resultingRelationshipId,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

async function loadCompaniesByIds(ids: string[]): Promise<Map<string, typeof companiesTable.$inferSelect>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db.select().from(companiesTable).where(inArray(companiesTable.id, uniqueIds));
  return new Map(rows.map((c) => [c.id, c]));
}

async function shapeBatchDetail(batchId: string) {
  const [batch] = await db.select().from(portfolioImportBatchesTable).where(eq(portfolioImportBatchesTable.id, batchId));
  if (!batch) return null;
  const [territory, rows] = await Promise.all([
    db
      .select()
      .from(territoriesTable)
      .where(eq(territoriesTable.id, batch.territoryId))
      .then((r) => r[0] ?? null),
    db.select().from(portfolioImportRowsTable).where(eq(portfolioImportRowsTable.batchId, batchId)).orderBy(portfolioImportRowsTable.rowIndex),
  ]);
  const companyById = await loadCompaniesByIds(rows.map((r) => r.matchedCompanyId).filter((id): id is string => !!id));
  const counts = computeBatchCounts(rows);

  return {
    id: batch.id,
    territory_id: batch.territoryId,
    territory_name: territory?.name ?? null,
    source_format: batch.sourceFormat,
    original_filename: batch.originalFilename,
    row_count: batch.rowCount,
    status: batch.status,
    error_message: batch.errorMessage,
    counts,
    created_at: batch.createdAt.toISOString(),
    completed_at: batch.completedAt ? batch.completedAt.toISOString() : null,
    rows: rows.map((r) => shapeImportRow(r, r.matchedCompanyId ? companyById.get(r.matchedCompanyId) ?? null : null)),
  };
}

async function assertBatchAccess(actingUser: Express.Request["actingUser"], territoryId: string) {
  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, territoryId));
  await assertRecordTerritoryAccess(actingUser!, territoryId, territory?.name ?? null);
}

router.get("/portfolio/imports", requireAuth, async (req, res): Promise<void> => {
  const parsedQuery = ListPortfolioImportsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const actingUser = req.actingUser!;
  const { territory } = parsedQuery.data;

  let scopedTerritoryId: string | null = null;
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    if (territory && territory !== own.territoryId && territory !== own.territoryName) {
      res.status(403).json({ error: "You do not have access to that territory." });
      return;
    }
    scopedTerritoryId = own.territoryId;
  }

  const batches = await db.select().from(portfolioImportBatchesTable);
  const territories = await db.select().from(territoriesTable);
  const territoryById = new Map(territories.map((t) => [t.id, t]));

  let filtered = batches;
  if (scopedTerritoryId) {
    filtered = filtered.filter((b) => b.territoryId === scopedTerritoryId);
  } else if (territory) {
    filtered = filtered.filter((b) => b.territoryId === territory || territoryById.get(b.territoryId)?.name === territory);
  }

  const allRows = filtered.length
    ? await db.select().from(portfolioImportRowsTable).where(inArray(portfolioImportRowsTable.batchId, filtered.map((b) => b.id)))
    : [];
  const rowsByBatch = new Map<string, typeof allRows>();
  for (const r of allRows) {
    if (!rowsByBatch.has(r.batchId)) rowsByBatch.set(r.batchId, []);
    rowsByBatch.get(r.batchId)!.push(r);
  }

  const shaped = filtered.map((b) => ({
    id: b.id,
    territory_id: b.territoryId,
    territory_name: territoryById.get(b.territoryId)?.name ?? null,
    source_format: b.sourceFormat,
    original_filename: b.originalFilename,
    row_count: b.rowCount,
    status: b.status,
    error_message: b.errorMessage,
    counts: computeBatchCounts(rowsByBatch.get(b.id) ?? []),
    created_at: b.createdAt.toISOString(),
    completed_at: b.completedAt ? b.completedAt.toISOString() : null,
  }));

  res.json(ListPortfolioImportsResponse.parse(shaped));
});

router.post("/portfolio/imports", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreatePortfolioImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const actingUser = req.actingUser!;

  try {
    await assertBatchAccess(actingUser, data.territory_id);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  let result;
  try {
    result = await createImportBatch(
      { territoryId: data.territory_id, sourceFormat: data.source_format, originalFilename: data.original_filename ?? null, rows: data.rows },
      actingUser.id,
    );
  } catch (err) {
    if (err instanceof ImportEmptyBatchError || err instanceof ImportRowLimitExceededError || err instanceof ImportPastedTextScopeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ImportNormalizationUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }

  const detail = await shapeBatchDetail(result.batch.id);
  res.json(CreatePortfolioImportResponse.parse(detail));
});

router.get("/portfolio/imports/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [batch] = await db.select().from(portfolioImportBatchesTable).where(eq(portfolioImportBatchesTable.id, id));
  if (!batch) {
    res.status(404).json({ error: "Import batch not found" });
    return;
  }

  try {
    await assertBatchAccess(req.actingUser!, batch.territoryId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const detail = await shapeBatchDetail(id);
  res.json(GetPortfolioImportResponse.parse(detail));
});

router.patch("/portfolio/imports/:id/rows/:rowId", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rowId = Array.isArray(req.params.rowId) ? req.params.rowId[0] : req.params.rowId;

  const parsed = UpdatePortfolioImportRowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [batch] = await db.select().from(portfolioImportBatchesTable).where(eq(portfolioImportBatchesTable.id, id));
  if (!batch) {
    res.status(404).json({ error: "Import batch not found" });
    return;
  }
  const [row] = await db.select().from(portfolioImportRowsTable).where(eq(portfolioImportRowsTable.id, rowId));
  if (!row || row.batchId !== id) {
    res.status(404).json({ error: "Import row not found" });
    return;
  }

  try {
    await assertBatchAccess(req.actingUser!, batch.territoryId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const data = parsed.data;
  const updates: Partial<typeof portfolioImportRowsTable.$inferInsert> = {};
  if (data.review_note !== undefined) updates.reviewNote = data.review_note;
  if (data.normalized_proposal !== undefined) updates.normalizedProposal = data.normalized_proposal as Record<string, unknown> | null;

  // A PAM explicitly picking/clearing the matched company is itself the
  // resolution of ambiguity -- recompute match_status from that decision
  // rather than leaving the batch's original (now-stale) classification.
  if (data.matched_company_id !== undefined) {
    if (data.matched_company_id === null) {
      updates.matchedCompanyId = null;
      updates.matchStatus = "ready";
    } else {
      const proposal = (data.normalized_proposal ?? row.normalizedProposal ?? {}) as { company_name?: string | null; domain?: string | null; country?: string | null };
      const match = await resolveCompanyMatch(
        { name: proposal.company_name ?? null, domain: proposal.domain ?? null, country: proposal.country ?? null },
        batch.territoryId,
      );
      updates.matchedCompanyId = data.matched_company_id;
      updates.matchStatus =
        match.matchedCompanyId === data.matched_company_id && match.hasExistingRelationshipInTerritory ? "existing_relationship" : "matched_existing_company";
    }
  }

  const [updated] = await db.update(portfolioImportRowsTable).set(updates).where(eq(portfolioImportRowsTable.id, rowId)).returning();
  const companyById = await loadCompaniesByIds(updated!.matchedCompanyId ? [updated!.matchedCompanyId] : []);
  res.json(UpdatePortfolioImportRowResponse.parse(shapeImportRow(updated!, updated!.matchedCompanyId ? companyById.get(updated!.matchedCompanyId) ?? null : null)));
});

router.post("/portfolio/imports/:id/rows/:rowId/confirm", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rowId = Array.isArray(req.params.rowId) ? req.params.rowId[0] : req.params.rowId;

  const [batch] = await db.select().from(portfolioImportBatchesTable).where(eq(portfolioImportBatchesTable.id, id));
  if (!batch) {
    res.status(404).json({ error: "Import batch not found" });
    return;
  }
  const [row] = await db.select().from(portfolioImportRowsTable).where(eq(portfolioImportRowsTable.id, rowId));
  if (!row || row.batchId !== id) {
    res.status(404).json({ error: "Import row not found" });
    return;
  }

  try {
    await assertBatchAccess(req.actingUser!, batch.territoryId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  let confirmed: PortfolioImportRow;
  try {
    confirmed = await confirmImportRow(row, batch.territoryId, req.actingUser!.id);
  } catch (err) {
    if (err instanceof ImportRowNotConfirmableError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  const companyById = await loadCompaniesByIds(confirmed.matchedCompanyId ? [confirmed.matchedCompanyId] : []);
  res.json(
    ConfirmPortfolioImportRowResponse.parse(
      shapeImportRow(confirmed, confirmed.matchedCompanyId ? companyById.get(confirmed.matchedCompanyId) ?? null : null),
    ),
  );
});

router.post("/portfolio/imports/:id/confirm-ready", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [batch] = await db.select().from(portfolioImportBatchesTable).where(eq(portfolioImportBatchesTable.id, id));
  if (!batch) {
    res.status(404).json({ error: "Import batch not found" });
    return;
  }

  try {
    await assertBatchAccess(req.actingUser!, batch.territoryId);
  } catch (err) {
    if (err instanceof ForbiddenScopeError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const result = await confirmReadyRows(id, batch.territoryId, req.actingUser!.id);
  res.json(ConfirmPortfolioImportReadyResponse.parse({ confirmed_count: result.confirmedCount, skipped_count: result.skippedCount }));
});

export default router;
