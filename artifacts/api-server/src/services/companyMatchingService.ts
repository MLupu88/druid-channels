// Stage 6 deterministic company identity resolution -- shared by Portfolio
// manual add, PAM book import matching, and the Radar->company bridge. No
// fuzzy-match library, no LLM: exact domain/name equality only, with
// country as the one disambiguating signal. Ambiguity always falls back to
// a review state rather than guessing -- prefer a false negative (PAM
// re-confirms a real match) over a false positive (two different
// companies silently merged).
import { db } from "@workspace/db";
import { companiesTable, partnerRelationshipsTable, type Company } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { StartedAtPrecision } from "./partnerRelationshipService";
import { toRegistrableDomain } from "./companyIdentity";

const LEGAL_SUFFIXES = [
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "llc",
  "gmbh",
  "srl",
  "sa",
  "sas",
  "spa",
  "bv",
  "ag",
  "plc",
  "co",
  "corp",
  "corporation",
  "company",
];

export function normalizeCompanyName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.includes(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return tokens.join(" ").trim();
}

export function normalizeCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  const trimmed = country.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

// Phase 3A: delegates to the same PSL-aware canonical helper Discovery uses
// (see companyIdentity.ts) -- this used to be its own www/protocol-only
// strip, which (like Discovery's old extractDomain) treated
// "ir.uipath.com" and "uipath.com" as different domains. Kept as a named
// export here since it's this module's established public API and other
// files already import it by this name.
export function normalizeDomain(domain: string | null | undefined): string | null {
  return toRegistrableDomain(domain);
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

export interface DateClassification {
  value: string | null;
  precision: StartedAtPrecision;
}

// Deterministic only -- DeepSeek's job (see portfolioImportProviders) is to
// extract the raw phrase from free text; classifying its precision is a
// pattern-matching task, not a semantic one. Never invents a date for an
// unrecognized phrase -- returns unknown/null instead.
export function classifyDatePhrase(raw: string | null | undefined): DateClassification {
  if (!raw) return { value: null, precision: "unknown" };
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, precision: "unknown" };

  let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { value: trimmed, precision: "exact_date" };

  m = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month) return { value: `${m[2]}-${String(month).padStart(2, "0")}-01`, precision: "month" };
  }

  m = trimmed.match(/^Q([1-4])[\s-]?(\d{4})$/i);
  if (m) {
    const quarter = Number(m[1]);
    const month = (quarter - 1) * 3 + 1;
    return { value: `${m[2]}-${String(month).padStart(2, "0")}-01`, precision: "quarter" };
  }

  m = trimmed.match(/(?:since|in|from)?\s*(\d{4})\s*$/i);
  if (m) return { value: `${m[1]}-01-01`, precision: "year" };

  return { value: null, precision: "unknown" };
}

export type DeterministicMatchStatus = "matched_existing_company" | "possible_duplicate" | "ready" | "invalid";

export interface MatchCompanyInput {
  name: string | null;
  domain: string | null;
  country: string | null;
}

export interface DeterministicMatchResult {
  status: DeterministicMatchStatus;
  matchedCompanyId: string | null;
}

// Pure, DB-free -- takes already-fetched candidate sets so it can be unit
// tested directly. See resolveCompanyMatch below for the DB-backed wrapper.
export function matchCompanyDeterministic(
  input: MatchCompanyInput,
  domainCandidates: Company[],
  nameCandidates: Company[],
): DeterministicMatchResult {
  if (!input.name || input.name.trim() === "") {
    return { status: "invalid", matchedCompanyId: null };
  }

  const seen = new Map<string, Company>();
  for (const c of domainCandidates) seen.set(c.id, c);
  for (const c of nameCandidates) seen.set(c.id, c);

  const normalizedCountry = normalizeCountry(input.country);

  if (input.domain && domainCandidates.length > 0) {
    if (normalizedCountry) {
      const countryFiltered = domainCandidates.filter((c) => normalizeCountry(c.country) === normalizedCountry);
      if (countryFiltered.length === 1) return { status: "matched_existing_company", matchedCompanyId: countryFiltered[0]!.id };
    }
    if (domainCandidates.length === 1) return { status: "matched_existing_company", matchedCompanyId: domainCandidates[0]!.id };
  }

  if (nameCandidates.length > 0) {
    if (normalizedCountry) {
      const countryFiltered = nameCandidates.filter((c) => normalizeCountry(c.country) === normalizedCountry);
      if (countryFiltered.length === 1) return { status: "matched_existing_company", matchedCompanyId: countryFiltered[0]!.id };
    }
    if (nameCandidates.length === 1) return { status: "matched_existing_company", matchedCompanyId: nameCandidates[0]!.id };
  }

  if (seen.size > 0) return { status: "possible_duplicate", matchedCompanyId: null };
  return { status: "ready", matchedCompanyId: null };
}

export interface ResolvedCompanyMatch extends DeterministicMatchResult {
  // true when matchedCompanyId already owns a partner_relationships row for
  // the given territory -- overrides matched_existing_company/ready at the
  // call site (see portfolioImportEngine.ts), since Stage 6 relationships
  // are canonical per (company, territory).
  hasExistingRelationshipInTerritory: boolean;
}

// Fetches every company and matches in memory (same convention already
// used throughout this codebase -- e.g. routes/recruitment.ts's list
// endpoint -- rather than relying on the not-always-populated
// companies.normalizedName column or introducing a fuzzy-search index).
export async function resolveCompanyMatch(input: MatchCompanyInput, territoryId: string): Promise<ResolvedCompanyMatch> {
  const normalizedDomain = normalizeDomain(input.domain);
  const normalizedName = input.name ? normalizeCompanyName(input.name) : null;

  const allCompanies = normalizedDomain || normalizedName ? await db.select().from(companiesTable) : [];
  const domainCandidates = normalizedDomain ? allCompanies.filter((c) => normalizeDomain(c.domain) === normalizedDomain) : [];
  const nameCandidates = normalizedName ? allCompanies.filter((c) => normalizeCompanyName(c.name) === normalizedName) : [];

  const result = matchCompanyDeterministic(input, domainCandidates, nameCandidates);

  if (result.status === "matched_existing_company" && result.matchedCompanyId) {
    const [existingRelationship] = await db
      .select({ id: partnerRelationshipsTable.id })
      .from(partnerRelationshipsTable)
      .where(and(eq(partnerRelationshipsTable.companyId, result.matchedCompanyId), eq(partnerRelationshipsTable.territoryId, territoryId)));
    return { ...result, hasExistingRelationshipInTerritory: !!existingRelationship };
  }

  return { ...result, hasExistingRelationshipInTerritory: false };
}
