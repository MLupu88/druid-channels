// Pure normalization/validation for the historical opportunity CSV cutover
// (Head/Admin-only, /opportunities/import). Network reconciliation stays in
// the authenticated API route; this module only consumes its typed results.
// This intentionally reuses
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
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export interface ImportReconciliation {
  company: CompanyRef | null;
  companySource: 'local' | 'hubspot' | 'none' | 'ambiguous';
  hubspotCompanyId?: string | null;
  hubspotCompanyName?: string | null;
  hubspotCompanyCountry?: string | null;
  deal: {
    id: string;
    dealName: string | null;
    amount: string | null;
    closeDate: string | null;
    createDate: string | null;
  } | null;
  dealAmbiguous: boolean;
  notes: string[];
}

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

// Kept as a small exact-match utility for non-network callers/tests.
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
  reconciliationByRow?: Map<number, ImportReconciliation>;
}

export type ImportRowStatus = 'ready' | 'needs_review' | 'duplicate' | 'error';

export interface ValidatedImportRow {
  rowNumber: number;
  raw: ImportCsvRow;
  status: ImportRowStatus;
  errors: string[];
  notes: string[];
  resolved?: { companyId: string; companyName: string; userId: string; userName: string; territoryId: string; territoryName: string };
  pendingCompany?: { domain: string; name: string; country: string; hubspotCompanyId: string | null };
  input?: OpportunityInput;
}

export function normalizeStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  return STATUSES.has(normalized) ? normalized : normalized;
}

export function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeDash(value: string): string {
  return value.replace(/[‐‑‒–—―﹘﹣－]/g, '-').replace(/â(?:€”|€“)/g, '-').replace(/&(?:mdash|ndash);/gi, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeAttribution(value: string): string {
  const normalized = normalizeDash(value);
  if (ATTRIBUTION_TYPES.has(normalized)) return normalized;
  if (/^partner[ -]+originated(?:[ -]+the[ -]+deal)?$/.test(normalized)) return 'partner_sourced';
  if (/^druid[ -]+originated[ -]+partner[ -]+influenced$/.test(normalized)) return 'partner_influenced';
  return normalized;
}

export function extractSingleEmail(value: string): string | null {
  const matches = value.match(EMAIL_RE) ?? [];
  return matches.length === 1 ? matches[0]!.toLowerCase() : null;
}

function isCutoverPamDisplay(value: string): boolean {
  const email = extractSingleEmail(value);
  return !!email && value.replace(email, '').trim().length > 0;
}

function validDateParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return !!match && !!validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function normalizeImportDate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return validDateParts(Number(iso[1]), Number(iso[2]), Number(iso[3])) ?? trimmed;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed);
  if (slash) {
    const rawYear = Number(slash[3]);
    const year = slash[3]!.length === 2 ? (rawYear >= 50 ? 1900 + rawYear : 2000 + rawYear) : rawYear;
    return validDateParts(year, Number(slash[1]), Number(slash[2])) ?? trimmed;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    const wholeSerial = Math.floor(serial);
    if (Number.isFinite(serial) && serial >= 1 && serial <= 2958465 && wholeSerial !== 60) {
      // Excel's 1900 system includes the fictitious 1900-02-29 at serial 60.
      // Use the pre/post-cutover epochs so real dates map to their actual
      // calendar day, while the impossible serial remains unresolved.
      const epoch = wholeSerial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
      const date = new Date(epoch + wholeSerial * 86400000);
      return validDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()) ?? trimmed;
    }
  }
  return trimmed;
}

function normalizeRawRow(raw: Record<string, string>): ImportCsvRow {
  const lower = new Map(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), (v ?? '').toString().trim()]));
  const result = {} as ImportCsvRow;
  for (const col of IMPORT_CSV_COLUMNS) {
    result[col] = lower.get(col) ?? '';
  }
  const cutoverEmail = isCutoverPamDisplay(result.customer_name) ? extractSingleEmail(result.customer_name) : null;
  const cutoverAttribution = normalizeAttribution(result.pam_email);
  if (cutoverEmail && !result.attribution_type && ATTRIBUTION_TYPES.has(cutoverAttribution)) {
    result.pam_email = cutoverEmail;
    result.attribution_type = cutoverAttribution;
    result.customer_name = '';
  } else {
    result.pam_email = extractSingleEmail(result.pam_email) ?? result.pam_email;
    result.attribution_type = normalizeAttribution(result.attribution_type);
  }
  result.status = normalizeStatus(result.status);
  result.currency = normalizeCurrency(result.currency);
  for (const column of ['opportunity_date', 'expected_close_date', 'closed_at', 'credit_date'] as const) {
    result[column] = normalizeImportDate(result[column]);
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

function normalizeDealName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildCutoverExternalId(partnerDomain: string, opportunityName: string, pamEmail: string): string {
  const identity = [normalizeDomainForLookup(partnerDomain) ?? partnerDomain.trim().toLowerCase(), normalizeDealName(opportunityName), pamEmail.trim().toLowerCase()].join('|');
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `CUTOVER-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function validateImportRow(rawInput: Record<string, string>, rowNumber: number, ref: ImportReferenceData, seenExternalIds: Set<string>): ValidatedImportRow {
  const originalStatus = (rawInput.status ?? '').trim();
  const raw = normalizeRawRow(rawInput);
  const errors: string[] = [];
  const notes: string[] = [];
  const reconciliation = ref.reconciliationByRow?.get(rowNumber);

  const opportunityName = raw.opportunity_name;
  if (!opportunityName) errors.push('opportunity_name is required.');

  let company: CompanyRef | undefined;
  if (!raw.partner_domain) {
    notes.push('Partner domain is missing.');
  } else {
    const normalized = normalizeDomainForLookup(raw.partner_domain);
    if (normalized && ref.ambiguousDomains.has(normalized)) {
      notes.push(`Partner domain "${raw.partner_domain}" matches more than one existing company.`);
    } else {
      company = normalized ? ref.companiesByDomain.get(normalized) : undefined;
      if (!company && reconciliation?.companySource === 'local') company = reconciliation.company ?? undefined;
      if (!company && reconciliation?.companySource === 'hubspot' && reconciliation.company) notes.push('Found company in HubSpot.');
      if (!company && reconciliation?.companySource === 'hubspot' && !reconciliation.company) notes.push('HubSpot found a company without a usable name; manual review is required.');
      if (!company && reconciliation?.companySource === 'ambiguous') notes.push('HubSpot returned multiple exact company matches.');
      if (!company && reconciliation?.companySource === 'none') notes.push('Partner domain not found locally or in HubSpot.');
      if (!company && !reconciliation) notes.push(`Partner domain "${raw.partner_domain}" not found among existing companies.`);
    }
  }

  let pam: User | undefined;
  if (!raw.pam_email) {
    notes.push('PAM email is missing.');
  } else {
    pam = ref.activePamsByEmail.get(raw.pam_email.toLowerCase());
    if (!pam) notes.push(`PAM email "${raw.pam_email}" does not match an active PAM.`);
  }

  let territory: Territory | undefined;
  if (pam) {
    territory = ref.territoriesByOwnerUserId.get(pam.id);
    if (!territory) notes.push(`PAM "${pam.email}" has no canonical territory assigned.`);
  }

  if (!ATTRIBUTION_TYPES.has(raw.attribution_type)) notes.push('Attribution remains unknown; use partner_sourced or partner_influenced.');

  const status = raw.status || 'open';
  if (!STATUSES.has(status)) notes.push('Status must be open, won, or lost.');

  const currency = raw.currency || 'USD';
  if (!CURRENCIES.has(currency)) notes.push('Currency must be USD, EUR, or GBP.');

  let dealValue = Number(raw.deal_value);
  if (!raw.deal_value || !Number.isFinite(dealValue) || dealValue <= 0) {
    const hubspotAmount = Number(reconciliation?.deal?.amount);
    if (Number.isFinite(hubspotAmount) && hubspotAmount > 0) {
      dealValue = hubspotAmount;
      raw.deal_value = reconciliation!.deal!.amount!;
      notes.push('Deal value filled from HubSpot.');
    } else notes.push('Deal value is missing or invalid.');
  }

  if (!isValidIsoDate(raw.opportunity_date)) {
    const created = reconciliation?.deal?.createDate ? normalizeImportDate(reconciliation.deal.createDate.slice(0, 10)) : '';
    if (isValidIsoDate(created)) {
      raw.opportunity_date = created;
      notes.push('Opportunity date filled from HubSpot.');
    } else notes.push('Opportunity date is missing or invalid.');
  }

  if (raw.expected_close_date && !isValidIsoDate(raw.expected_close_date)) notes.push('Expected close date is invalid.');

  if (raw.closed_at && !isValidIsoDate(raw.closed_at)) notes.push('Closed date is invalid.');
  if ((status === 'won' || status === 'lost') && !raw.closed_at && reconciliation?.deal?.closeDate) {
    const closed = normalizeImportDate(reconciliation.deal.closeDate.slice(0, 10));
    if (isValidIsoDate(closed)) {
      raw.closed_at = closed;
      notes.push('Closed date filled from HubSpot.');
    }
  }
  if (status === 'won' && !raw.closed_at) notes.push('Won opportunity requires closed_at.');
  if (status === 'open' && !raw.expected_close_date && reconciliation?.deal?.closeDate) {
    const expected = normalizeImportDate(reconciliation.deal.closeDate.slice(0, 10));
    if (isValidIsoDate(expected)) {
      raw.expected_close_date = expected;
      notes.push('Expected close date filled from HubSpot.');
    }
  }

  let creditValue: number | null = null;
  if (raw.credit_value) {
    creditValue = Number(raw.credit_value);
    if (!Number.isFinite(creditValue) || creditValue <= 0) notes.push('Credit value is invalid.');
  }

  if (raw.credit_date && !isValidIsoDate(raw.credit_date)) notes.push('Credit date is invalid.');

  if (reconciliation?.dealAmbiguous) notes.push('Multiple exact HubSpot deals matched this opportunity name.');
  if (reconciliation?.deal && !reconciliation.dealAmbiguous) notes.push(`Matched HubSpot deal: ${reconciliation.deal.id}.`);
  if (reconciliation?.notes) notes.push(...reconciliation.notes.filter((note) => !notes.includes(note)));

  const normalizedPamEmail = pam?.email ?? raw.pam_email;
  const externalId = reconciliation?.deal && !reconciliation.dealAmbiguous
    ? reconciliation.deal.id
    : raw.external_id || buildCutoverExternalId(raw.partner_domain, opportunityName, normalizedPamEmail);
  if (!raw.external_id && externalId.startsWith('CUTOVER-')) notes.push(`Generated deterministic external ID: ${externalId}.`);
  if (originalStatus && originalStatus.toLowerCase() !== status) notes.push(`Normalized status: ${originalStatus} → ${status}.`);

  if (externalId) {
    if (seenExternalIds.has(externalId)) {
      errors.push(`Duplicate external_id "${externalId}" within this file.`);
    } else {
      seenExternalIds.add(externalId);
    }
  }

  const pendingCompany = !company && reconciliation?.companySource === 'hubspot' && reconciliation.hubspotCompanyId && reconciliation.hubspotCompanyName
    ? { domain: normalizeDomainForLookup(raw.partner_domain) ?? raw.partner_domain, name: reconciliation.hubspotCompanyName, country: reconciliation.hubspotCompanyCountry || 'Unknown', hubspotCompanyId: reconciliation.hubspotCompanyId }
    : undefined;
  if (errors.length > 0) return { rowNumber, raw, status: 'error', errors, notes };

  // Only reachable once every required field validated cleanly, so
  // external_id/company/pam/territory are guaranteed non-null below.
  if (ref.alreadyImportedExternalIds.has(externalId)) {
    return { rowNumber, raw, status: 'duplicate', errors: [`external_id "${externalId}" was already imported.`], notes };
  }

  const invalidCreditValue = !!raw.credit_value && (creditValue === null || !Number.isFinite(creditValue) || creditValue <= 0);
  const unresolved = !company && !pendingCompany || !pam || !territory || !ATTRIBUTION_TYPES.has(raw.attribution_type) || !STATUSES.has(status) || !CURRENCIES.has(currency) || !Number.isFinite(dealValue) || dealValue <= 0 || !isValidIsoDate(raw.opportunity_date) || (status === 'won' && !raw.closed_at) || (raw.expected_close_date && !isValidIsoDate(raw.expected_close_date)) || (raw.closed_at && !isValidIsoDate(raw.closed_at)) || (raw.credit_date && !isValidIsoDate(raw.credit_date)) || invalidCreditValue || reconciliation?.companySource === 'ambiguous' || reconciliation?.dealAmbiguous;
  if (reconciliation?.companySource === 'ambiguous' || reconciliation?.dealAmbiguous) {
    // These are genuine business-data ambiguities, never structural parse errors.
  }
  const input: OpportunityInput = {
    name: opportunityName,
    company_id: company?.id ?? '',
    territory_id: territory?.id ?? '',
    assigned_user_id: pam?.id ?? '',
    attribution_type: raw.attribution_type as OpportunityAttributionType,
    status: status as OpportunityStatus,
    deal_value: dealValue,
    currency: currency as OpportunityCurrency,
    opportunity_date: raw.opportunity_date,
    expected_close_date: raw.expected_close_date || null,
    closed_at: raw.closed_at || null,
    credit_value: creditValue,
    credit_date: raw.credit_date || null,
    customer_name: raw.customer_name || null,
    note: raw.note || null,
    source_system: 'import',
    external_id: externalId,
  };

  if (unresolved) return { rowNumber, raw, status: 'needs_review', errors: [], notes, pendingCompany, input };

  return {
    rowNumber,
    raw,
    status: 'ready',
    errors: [],
    notes,
    pendingCompany,
    resolved: { companyId: company?.id ?? '', companyName: company?.name ?? pendingCompany!.name, userId: pam!.id, userName: pam!.name, territoryId: territory!.id, territoryName: territory!.name },
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
