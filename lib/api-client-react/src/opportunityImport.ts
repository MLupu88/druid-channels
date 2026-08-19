import { customFetch } from "./custom-fetch";

export interface OpportunityImportReconcileInput {
  row_number: number;
  partner_domain: string;
  opportunity_name: string;
}

export interface OpportunityImportReconcileResult {
  provider_warning: string | null;
  rows: Array<{
    row_number: number;
    company_source: "local" | "hubspot" | "none" | "ambiguous";
    company: { id: string; name: string; domain: string | null; country: string } | null;
    hubspot_company_id: string | null;
    hubspot_company_name: string | null;
    hubspot_company_domain: string | null;
    hubspot_company_country: string | null;
    deal: {
      id: string;
      dealName: string | null;
      amount: string | null;
      closeDate: string | null;
      createDate: string | null;
    } | null;
    deal_ambiguous: boolean;
  }>;
}

export interface OpportunityImportEnsureCompanyInput {
  domain: string;
  name: string;
  country?: string;
  hubspot_company_id?: string | null;
}

export interface OpportunityImportEnsuredCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string;
}

export function reconcileOpportunityImport(rows: OpportunityImportReconcileInput[], options?: Parameters<typeof customFetch>[1]): Promise<OpportunityImportReconcileResult> {
  return customFetch<OpportunityImportReconcileResult>("/api/opportunities/import/reconcile", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
    body: JSON.stringify({ rows }),
  });
}

export function ensureOpportunityImportCompany(input: OpportunityImportEnsureCompanyInput, options?: Parameters<typeof customFetch>[1]): Promise<OpportunityImportEnsuredCompany> {
  return customFetch<OpportunityImportEnsuredCompany>("/api/opportunities/import/ensure-company", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
    body: JSON.stringify(input),
  });
}
