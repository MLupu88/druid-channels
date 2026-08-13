// Phase 5B-3: pure parsing/validation for the historical opportunity CSV
// cutover (Head/Admin-only, /opportunities/import). No React, no network
// calls here -- all resolution inputs (matched companies, active PAMs,
// their canonical territories, already-imported external ids) are fetched
// by the page via the EXISTING GET /companies/search, /users, /territories,
// /opportunities contracts and handed in. This intentionally reuses
// POST /opportunities (source_system='import') rather than adding a new
// bulk backend endpoint -- see routes/opportunities.ts's Phase 5B-3 comment
// on the one supporting change that route needed (a clean 409 on a repeat
// external_id instead of a raw 500).
import type { CompanyRef, Opportunity, OpportunityAttributionType, OpportunityCurrency, OpportunityInput, OpportunityStatus, Territory, User } from '@workspace/api-client-react';

export const IMPORT_CSV_COLUMNS = [
  'external_id',
  'partner_domain',
  'opportunity_name',
  'customer_name',
  'pam_email',
  'attribution_type',
  'status',
  'deal_value',
  'currency',
  'opportunity_date',
  'expected_close_date',
  'closed_at',
  'credit_value',
  'credit_date',
  'note',
] as const;

export type ImportCsvColumn = (typeof IMPORT_CSV_COLUMNS)[number];
export type ImportCsvRow = Record<ImportCsvColumn, string>;

const ATTRIBUTION_TYPES = new Set<string>(['partner_sourced', 'partner_influenced']);
const STATUSES = new Set<string>(['open', 'won', 'lost']);
const CURRENCIES = new Set<string>(['USD', 'EUR', 'GBP']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same hostname-normalization primitives as the API server's
// services/companyIdentity.ts's toHostname (scheme/path/port stripped via
// URL, lowercased, trailing dot removed), minus PSL eTLD+1 reduction -- the
// frontend has no tldts dependency, and the CSV contract asks for an
// already-canonical registrable domain (see the import page's helper
// copy). A leading "www." is also stripped -- that never merges two
// distinct companies. The result is matched against the existing,
// already-canonicalized companies.domain column by exact string equality
// only -- this never fuzzy-matches by company name.
export function normalizeDomainForLookup(input: string | null | undefined): string | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  if (!hostname) return null;
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

// No longer called by the live import page (Phase 5B-3 blocker A2 replaced
// GET /companies/search-based resolution with the exact GET
// /companies/by-domain lookup -- see opportunities-import.tsx), but kept
// and still tested as a small, correct, exact-match utility over a search
// -results array in case a future caller needs it.
export function findExactDomainMatch(searchResults: CompanyRef[], normalizedDomain: string): CompanyRef | undefined {
  return searchResults.find((c) => normalizeDomainForLookup(c.domain) === normalizedDomain);
}

export function buildActivePamsByEmail(users: User[]): Map<string, User> {
  const map = new Map<string, User>();
  for (const u of users) {
    if (u.role === 'pam' && u.active) map.set(u.email.trim().toLowerCase(), u);
  }
  return map;
}

// Canonical PAM-territory link is territories.owner_user_id, never
// users.territory free text -- same rule authz.ts's getOwnTerritory and
// every other territory-scoped page in this app already follows.
export function buildTerritoriesByOwnerUserId(territories: Territory[]): Map<string, Territory> {
  const map = new Map<string, Territory>();
  for (const t of territories) {
    if (t.owner_user_id) map.set(t.owner_user_id, t);
  }
  return map;
}

// GET /opportunities (Head/Admin, unfiltered) already returns every row
// including source_system/external_id -- enough to pre-detect "already
// imported" duplicates client-side without a new backend query param.
export function buildAlreadyImportedExternalIds(opportunities: Opportunity[]): Set<string> {
  const set = new Set<string>();
  for (const o of opportunities) {
    if (o.source_system === 'import' && o.external_id) set.add(o.external_id);
  }
  return set;
}

export interface ImportReferenceData {
  companiesByDomain: Map<string, CompanyRef>;
  // Populated by GET /companies/by-domain (Phase 5B-3 blocker A2) when a
  // domain matches more than one company row under case-insensitive
  // comparison (a legacy/corrupt duplicate) -- never silently resolved to
  // an arbitrary one of them.
  ambiguousDomains: Set<string>;
  activePamsByEmail: Map<string, User>;
  territoriesByOwnerUserId: Map<string, Territory>;
  alreadyImportedExternalIds: Set<string>;
}

export type ImportRowStatus = 'ready' | 'duplicate' | 'error';

export interface ValidatedImportRow {
  rowNumber: number;
  raw: ImportCsvRow;
  status: ImportRowStatus;
  errors: string[];
  resolved?: { companyId: string; companyName: string; userId: string; userName: string; territoryId: string; territoryName: string };
  input?: OpportunityInput;
}

function normalizeRawRow(raw: Record<string, string>): ImportCsvRow {
  const lower = new Map(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), (v ?? '').toString().trim()]));
  const result = {} as ImportCsvRow;
  for (const col of IMPORT_CSV_COLUMNS) {
    result[col] = lower.get(col) ?? '';
  }
  return result;
}

// Phase 5B-3 blocker A1: the page must call this ONCE, immediately after
// XLSX.sheet_to_json produces raw rows and before ANY field-specific read
// (including the partner-domain pre-fetch loop) -- never read a raw row's
// field by a hardcoded-case key. Uses the exact same trim/lowercase
// semantics validateHeaders already tolerates for the header row itself
// (normalizeRawRow), so a header like "Partner_Domain" or "PARTNER_DOMAIN"
// or " partner_domain " normalizes to the same canonical `partner_domain`
// key as a file that already used the lowercase spelling -- previously,
// validateHeaders accepted such a header but a later direct r.partner_domain
// property access on the un-normalized row silently returned undefined,
// breaking domain resolution for the entire file. Normalizes KEYS only;
// values are preserved verbatim (trimmed, per normalizeRawRow).
export function normalizeImportRows(rawRows: Record<string, string>[]): ImportCsvRow[] {
  return rawRows.map(normalizeRawRow);
}

// Every required column must be present in the header row (case/whitespace
// -insensitive); extra columns are ignored. Returns an empty array when the
// header is usable.
export function validateHeaders(headerKeys: string[]): string[] {
  const normalized = new Set(headerKeys.map((h) => h.trim().toLowerCase()));
  return IMPORT_CSV_COLUMNS.filter((c) => !normalized.has(c)).map((c) => `Missing required column "${c}".`);
}

export function validateImportRow(rawInput: Record<string, string>, rowNumber: number, ref: ImportReferenceData, seenExternalIds: Set<string>): ValidatedImportRow {
  const raw = normalizeRawRow(rawInput);
  const errors: string[] = [];

  const externalId = raw.external_id;
  if (!externalId) errors.push('external_id is required.');

  const opportunityName = raw.opportunity_name;
  if (!opportunityName) errors.push('opportunity_name is required.');

  let company: CompanyRef | undefined;
  if (!raw.partner_domain) {
    errors.push('partner_domain is required.');
  } else {
    const normalized = normalizeDomainForLookup(raw.partner_domain);
    if (normalized && ref.ambiguousDomains.has(normalized)) {
      errors.push(`Partner domain "${raw.partner_domain}" matches more than one existing company and cannot be resolved automatically.`);
    } else {
      company = normalized ? ref.companiesByDomain.get(normalized) : undefined;
      if (!company) errors.push(`Partner domain "${raw.partner_domain}" not found among existing companies.`);
    }
  }

  let pam: User | undefined;
  if (!raw.pam_email) {
    errors.push('pam_email is required.');
  } else {
    pam = ref.activePamsByEmail.get(raw.pam_email.toLowerCase());
    if (!pam) errors.push(`PAM email "${raw.pam_email}" does not match an active PAM.`);
  }

  let territory: Territory | undefined;
  if (pam) {
    territory = ref.territoriesByOwnerUserId.get(pam.id);
    if (!territory) errors.push(`PAM "${pam.email}" has no canonical territory assigned.`);
  }

  if (!ATTRIBUTION_TYPES.has(raw.attribution_type)) errors.push('attribution_type must be partner_sourced or partner_influenced.');

  const status = raw.status || 'open';
  if (!STATUSES.has(status)) errors.push('status must be open, won, or lost.');

  const currency = raw.currency || 'USD';
  if (!CURRENCIES.has(currency)) errors.push('currency must be USD, EUR, or GBP.');

  const dealValue = Number(raw.deal_value);
  if (!raw.deal_value || !Number.isFinite(dealValue) || dealValue <= 0) errors.push('deal_value must be a positive number.');

  if (!raw.opportunity_date || !ISO_DATE_RE.test(raw.opportunity_date)) errors.push('opportunity_date must be an ISO date (YYYY-MM-DD).');

  if (raw.expected_close_date && !ISO_DATE_RE.test(raw.expected_close_date)) errors.push('expected_close_date must be an ISO date (YYYY-MM-DD) when present.');

  if (raw.closed_at && !ISO_DATE_RE.test(raw.closed_at)) errors.push('closed_at must be an ISO date (YYYY-MM-DD) when present.');
  if (status === 'won' && !raw.closed_at) errors.push('Won opportunity requires closed_at.');

  let creditValue: number | null = null;
  if (raw.credit_value) {
    creditValue = Number(raw.credit_value);
    if (!Number.isFinite(creditValue) || creditValue <= 0) errors.push('credit_value must be a positive number when present.');
  }

  if (raw.credit_date && !ISO_DATE_RE.test(raw.credit_date)) errors.push('credit_date must be an ISO date (YYYY-MM-DD) when present.');

  if (externalId) {
    if (seenExternalIds.has(externalId)) {
      errors.push(`Duplicate external_id "${externalId}" within this file.`);
    } else {
      seenExternalIds.add(externalId);
    }
  }

  if (errors.length > 0) {
    return { rowNumber, raw, status: 'error', errors };
  }

  // Only reachable once every required field validated cleanly, so
  // external_id/company/pam/territory are guaranteed non-null below.
  if (ref.alreadyImportedExternalIds.has(externalId)) {
    return { rowNumber, raw, status: 'duplicate', errors: [`external_id "${externalId}" was already imported.`] };
  }

  const input: OpportunityInput = {
    name: opportunityName,
    company_id: company!.id,
    territory_id: territory!.id,
    assigned_user_id: pam!.id,
    attribution_type: raw.attribution_type as OpportunityAttributionType,
    status: status as OpportunityStatus,
    deal_value: dealValue,
    currency: currency as OpportunityCurrency,
    opportunity_date: raw.opportunity_date,
    expected_close_date: raw.expected_close_date || null,
    // Sent as the bare YYYY-MM-DD string, same as the manual Add Opportunity
    // form (see OpportunityFormDialog) -- the backend's `new Date(...)`
    // parses it identically either way. Never defaulted to today; blank
    // stays null so the backend's credit_date ?? closed_at fallback applies
    // naturally (see partner_opportunities.creditDate).
    closed_at: raw.closed_at || null,
    credit_value: creditValue,
    credit_date: raw.credit_date || null,
    customer_name: raw.customer_name || null,
    note: raw.note || null,
    source_system: 'import',
    external_id: externalId,
  };

  return {
    rowNumber,
    raw,
    status: 'ready',
    errors: [],
    resolved: { companyId: company!.id, companyName: company!.name, userId: pam!.id, userName: pam!.name, territoryId: territory!.id, territoryName: territory!.name },
    input,
  };
}

export function validateImportRows(rawRows: Record<string, string>[], ref: ImportReferenceData): ValidatedImportRow[] {
  const seenExternalIds = new Set<string>();
  return rawRows.map((raw, idx) => validateImportRow(raw, idx + 1, ref, seenExternalIds));
}

export interface ImportRowOutcome {
  rowNumber: number;
  externalId: string;
  outcome: 'imported' | 'duplicate' | 'failed';
  reason?: string;
}

export function buildCsvTemplate(): string {
  const header = IMPORT_CSV_COLUMNS.join(',');
  const example = [
    'HS-10234',
    'uipath.com',
    'UiPath - RPA renewal',
    'Globex Corp',
    'denny.morais@druidai.com',
    'partner_sourced',
    'won',
    '45000',
    'USD',
    '2025-11-03',
    '',
    '2025-12-18',
    '',
    '',
    'Historical cutover row',
  ].join(',');
  return `${header}\n${example}\n`;
}
