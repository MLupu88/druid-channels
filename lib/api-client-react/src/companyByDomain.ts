import { customFetch } from "./custom-fetch";
import type { CompanyRef } from "./generated/api.schemas";

// Phase 5B-3 blocker A2: hand-authored (not orval-generated -- see
// generated/api.ts and lib/api-spec/openapi.yaml) client for
// GET /companies/by-domain, the exact canonical-domain lookup added
// specifically because GET /companies/search (searchCompanies below is
// generated) is a fuzzy, 20-result-capped substring search unsuitable for
// exact-match resolution at scale. A narrowly-scoped, additive-only server
// change for one caller (the historical opportunity importer) doesn't
// warrant a full client regeneration; if a second real caller emerges,
// promote this into openapi.yaml properly.
export interface CompanyByDomainResult {
  match: CompanyRef | null;
  ambiguous: boolean;
}

export async function getCompanyByDomain(domain: string, options?: Parameters<typeof customFetch>[1]): Promise<CompanyByDomainResult> {
  const params = new URLSearchParams({ domain });
  return customFetch<CompanyByDomainResult>(`/api/companies/by-domain?${params.toString()}`, {
    ...options,
    method: "GET",
  });
}
