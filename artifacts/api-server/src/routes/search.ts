import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  companiesTable,
  partnerRelationshipsTable,
  partnerRecruitmentsTable,
  prospectsTable,
  channelRadarSignalsTable,
  territoriesTable,
} from "@workspace/db";
import { SearchQueryParams, SearchResponse } from "@workspace/api-zod";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory } from "../services/authz";

const router: IRouter = Router();

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS_PER_MODULE = 5;

// Stage 6.3: internal application search. Deterministic, case-insensitive
// substring matching only -- no external search provider, no fuzzy/AI
// matching (matches the exact convention already established by
// GET /companies/search and companyMatchingService.ts). One aggregate
// endpoint rather than four frontend waterfalls, so there is exactly one
// place authz scoping and result-shaping happen.
router.get("/search", requireAuth, async (req, res): Promise<void> => {
  const parsed = SearchQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const q = parsed.data.q.trim().toLowerCase();
  if (q.length < MIN_QUERY_LENGTH) {
    res.status(400).json({ error: `Search query must be at least ${MIN_QUERY_LENGTH} characters.` });
    return;
  }

  const actingUser = req.actingUser!;
  let scopedTerritoryId: string | null = null;
  if (!isGlobalUser(actingUser)) {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    scopedTerritoryId = own.territoryId;
  }

  const [companies, territories] = await Promise.all([db.select().from(companiesTable), db.select().from(territoriesTable)]);
  const matchedCompanyIds = new Set(
    companies.filter((c) => c.name.toLowerCase().includes(q) || (c.domain ?? "").toLowerCase().includes(q)).map((c) => c.id),
  );
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const territoryNameById = new Map(territories.map((t) => [t.id, t.name]));

  // Every module query below is authorization-scoped server-side (never
  // just hidden client-side) -- a PAM's rows are filtered to their own
  // territory_id here, before shaping, not after.
  const inScope = (territoryId: string | null) => !scopedTerritoryId || territoryId === scopedTerritoryId;

  const results: Array<{
    id: string;
    module: "portfolio" | "recruitment" | "discovery" | "radar";
    company_name: string;
    domain: string | null;
    context_label: string;
    territory_name: string | null;
    href: string;
  }> = [];

  if (matchedCompanyIds.size > 0) {
    const relationships = await db.select().from(partnerRelationshipsTable);
    for (const r of relationships) {
      if (!matchedCompanyIds.has(r.companyId) || !inScope(r.territoryId)) continue;
      const company = companyById.get(r.companyId);
      if (!company) continue;
      results.push({
        id: r.id,
        module: "portfolio",
        company_name: company.name,
        domain: company.domain,
        context_label: `Portfolio Partner · ${r.status[0]!.toUpperCase()}${r.status.slice(1)}`,
        territory_name: territoryNameById.get(r.territoryId) ?? null,
        href: "/portfolio",
      });
      if (results.filter((x) => x.module === "portfolio").length >= MAX_RESULTS_PER_MODULE) break;
    }

    const recruitments = await db.select().from(partnerRecruitmentsTable);
    for (const r of recruitments) {
      if (!matchedCompanyIds.has(r.companyId) || !inScope(r.territoryId)) continue;
      const company = companyById.get(r.companyId);
      if (!company) continue;
      results.push({
        id: r.id,
        module: "recruitment",
        company_name: company.name,
        domain: company.domain,
        context_label: `Recruitment · ${r.stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
        territory_name: territoryNameById.get(r.territoryId) ?? null,
        href: "/recruitment",
      });
      if (results.filter((x) => x.module === "recruitment").length >= MAX_RESULTS_PER_MODULE) break;
    }

    const prospects = await db.select().from(prospectsTable);
    for (const p of prospects) {
      if (!matchedCompanyIds.has(p.companyId) || !inScope(p.territoryId)) continue;
      const company = companyById.get(p.companyId);
      if (!company) continue;
      results.push({
        id: p.id,
        module: "discovery",
        company_name: company.name,
        domain: company.domain,
        context_label: `Discovery Prospect · Priority ${p.priority}`,
        territory_name: territoryNameById.get(p.territoryId) ?? null,
        href: "/new-partners",
      });
      if (results.filter((x) => x.module === "discovery").length >= MAX_RESULTS_PER_MODULE) break;
    }
  }

  // Channel Radar: entity_name is free text (Stage 5's own admin-curated
  // monitoring list), matched directly -- company_id is nullable and
  // usually unresolved (see radarCompanyBridge.ts), so a name match here
  // does not require it.
  const radarSignals = await db.select().from(channelRadarSignalsTable);
  for (const s of radarSignals) {
    if (!s.entityName.toLowerCase().includes(q)) continue;
    if (!inScope(s.territoryId)) continue;
    results.push({
      id: s.id,
      module: "radar",
      company_name: s.entityName,
      domain: null,
      context_label: `Radar Signal · ${s.signalType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
      territory_name: territoryNameById.get(s.territoryId) ?? null,
      href: "/channel-radar",
    });
    if (results.filter((x) => x.module === "radar").length >= MAX_RESULTS_PER_MODULE) break;
  }

  res.json(SearchResponse.parse(results));
});

export default router;
