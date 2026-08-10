import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db";
import { SearchCompaniesQueryParams, SearchCompaniesResponse } from "@workspace/api-zod";
import { requireAuth } from "../middleware/auth";

const router: IRouter = Router();

const MAX_RESULTS = 20;

// Lightweight lookup used by Portfolio manual add / import review's company
// picker. Prefix/substring match only -- no fuzzy search infrastructure
// (matches the deterministic-only convention in companyMatchingService).
router.get("/companies/search", requireAuth, async (req, res): Promise<void> => {
  const parsed = SearchCompaniesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const q = parsed.data.q.trim().toLowerCase();
  if (q.length < 2) {
    res.json(SearchCompaniesResponse.parse([]));
    return;
  }

  const all = await db.select().from(companiesTable);
  const matches = all
    .filter((c) => c.name.toLowerCase().includes(q) || (c.domain ?? "").toLowerCase().includes(q))
    .slice(0, MAX_RESULTS)
    .map((c) => ({ id: c.id, name: c.name, domain: c.domain, country: c.country }));

  res.json(SearchCompaniesResponse.parse(matches));
});

export default router;
