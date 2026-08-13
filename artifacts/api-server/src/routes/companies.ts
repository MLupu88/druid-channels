import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { companiesTable } from "@workspace/db";
import { SearchCompaniesQueryParams, SearchCompaniesResponse } from "@workspace/api-zod";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { toRegistrableDomain } from "../services/companyIdentity";

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

interface CompanyByDomainResponse {
  match: { id: string; name: string; domain: string | null; country: string } | null;
  ambiguous: boolean;
}

// Phase 5B-3 blocker A2: an EXACT canonical-domain lookup, deliberately
// separate from /companies/search above. That endpoint is fuzzy (substring
// match on name OR domain) and capped at MAX_RESULTS=20 with no ordering --
// an existing company's exact domain can be pushed out of the truncated
// result set once enough OTHER companies also substring-match the query,
// silently causing a real match to be reported as "not found" by an exact
// -match caller. This route instead filters the companies table directly
// for an exact (case-insensitive) match on the canonicalized domain
// column, so it can never be affected by that cap or by unrelated name
// matches.
//
// Runs the input through toRegistrableDomain -- the SAME canonical
// registrable-domain helper every other company-identity write/match path
// in this app already uses (see services/companyIdentity.ts) -- so a
// caller passing a bare domain, a full URL, or a "www." host all resolve
// identically, and this never fuzzy-matches by company name.
//
// If more than one row shares the same canonical domain under
// case-insensitive comparison (a legacy/corrupt duplicate -- the DB's
// companies_domain_unique index is case-SENSITIVE, see schema/companies.ts,
// so two rows differing only by case can coexist even though every write
// path is supposed to store an already-lowercased value), this
// deliberately returns ambiguous:true with match:null rather than silently
// picking an arbitrary one of them.
//
// Not part of the orval/openapi-generated contract (see lib/api-spec) --
// a narrowly-scoped, additive-only server change for one specific caller
// (the historical opportunity importer) doesn't warrant a full client
// regeneration. The frontend calls it via a small hand-authored client
// helper (lib/api-client-react/src/companyByDomain.ts) instead.
router.get("/companies/by-domain", requireAuth, async (req, res): Promise<void> => {
  const rawDomain = typeof req.query.domain === "string" ? req.query.domain : "";
  const canonical = toRegistrableDomain(rawDomain);
  if (!canonical) {
    const body: CompanyByDomainResponse = { match: null, ambiguous: false };
    res.json(body);
    return;
  }

  const matches = await db
    .select()
    .from(companiesTable)
    .where(sql`lower(${companiesTable.domain}) = ${canonical}`);

  if (matches.length === 0) {
    const body: CompanyByDomainResponse = { match: null, ambiguous: false };
    res.json(body);
    return;
  }
  if (matches.length > 1) {
    const body: CompanyByDomainResponse = { match: null, ambiguous: true };
    res.json(body);
    return;
  }

  const c = matches[0]!;
  const body: CompanyByDomainResponse = { match: { id: c.id, name: c.name, domain: c.domain, country: c.country }, ambiguous: false };
  res.json(body);
});

export default router;
