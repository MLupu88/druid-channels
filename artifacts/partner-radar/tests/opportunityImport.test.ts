// Phase 5B-3: unit tests for the historical opportunity CSV cutover's pure
// parsing/validation module (src/lib/opportunity-import.ts). No React, no
// network, no DOM -- every resolution input is a plain in-memory fixture
// standing in for what the import page fetches via the EXISTING
// GET /companies/search, /users, /territories, /opportunities contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_CSV_COLUMNS,
  normalizeDomainForLookup,
  normalizeImportRows,
  findExactDomainMatch,
  buildActivePamsByEmail,
  buildTerritoriesByOwnerUserId,
  buildAlreadyImportedExternalIds,
  validateHeaders,
  validateImportRow,
  validateImportRows,
  buildCsvTemplate,
  type ImportReferenceData,
} from "../src/lib/opportunity-import";

const COMPANY = { id: "company-1", name: "UiPath", domain: "uipath.com", country: "US" };
const PAM = { id: "pam-1", name: "Denny Morais", email: "denny.morais@druidai.com", role: "pam" as const, territory: null, location_label: null, timezone: null, active: true };
const INACTIVE_PAM = { ...PAM, id: "pam-2", email: "inactive@druidai.com", active: false };
const HEAD_USER = { id: "head-1", name: "Irina", email: "irina@druidai.com", role: "head_of_channels" as const, territory: null, location_label: null, timezone: null, active: true };
const TERRITORY = { id: "territory-1", name: "Iberia", owner_user_id: "pam-1", countries: [], languages: [] };

function baseRef(): ImportReferenceData {
  return {
    companiesByDomain: new Map([["uipath.com", COMPANY]]),
    ambiguousDomains: new Set(),
    activePamsByEmail: buildActivePamsByEmail([PAM, INACTIVE_PAM, HEAD_USER]),
    territoriesByOwnerUserId: buildTerritoriesByOwnerUserId([TERRITORY]),
    alreadyImportedExternalIds: new Set(["already-1"]),
  };
}

function baseRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    external_id: "ext-1",
    partner_domain: "uipath.com",
    opportunity_name: "UiPath renewal",
    customer_name: "Globex",
    pam_email: "denny.morais@druidai.com",
    attribution_type: "partner_sourced",
    status: "open",
    deal_value: "1000",
    currency: "USD",
    opportunity_date: "2025-11-01",
    expected_close_date: "",
    closed_at: "",
    credit_value: "",
    credit_date: "",
    note: "",
    ...overrides,
  };
}

// ---- domain normalization / resolution -------------------------------------

test("normalizeDomainForLookup strips scheme, path, trailing dot, and a leading www.", () => {
  assert.equal(normalizeDomainForLookup("https://www.uipath.com/pricing"), "uipath.com");
  assert.equal(normalizeDomainForLookup("UiPath.com."), "uipath.com");
  assert.equal(normalizeDomainForLookup("uipath.com"), "uipath.com");
  assert.equal(normalizeDomainForLookup(""), null);
  assert.equal(normalizeDomainForLookup(null), null);
});

test("findExactDomainMatch requires an exact normalized match, never a substring/fuzzy hit", () => {
  const results = [{ id: "c1", name: "UiPath Inc", domain: "uipath.com", country: "US" }, { id: "c2", name: "Not UiPath", domain: "myuipath.com", country: "US" }];
  assert.equal(findExactDomainMatch(results, "uipath.com")?.id, "c1");
  assert.equal(findExactDomainMatch(results, "otherdomain.com"), undefined);
});

// ---- Blocker A1: header-key normalization must run once, before any -------
// ---- field-specific read (including domain pre-fetch) --------------------

test("normalizeImportRows maps partner_domain header-case/whitespace variants to the canonical column key, preserving values (Blocker A1)", () => {
  const canonical = normalizeImportRows([baseRow()])[0]!;
  assert.equal(canonical.partner_domain, "uipath.com");

  for (const headerKey of ["Partner_Domain", "PARTNER_DOMAIN", " partner_domain "]) {
    const { partner_domain, ...rest } = baseRow();
    const variantRow = { ...rest, [headerKey]: partner_domain };
    const [normalized] = normalizeImportRows([variantRow]);
    assert.equal(normalized!.partner_domain, "uipath.com", `header "${headerKey}" must normalize to the canonical partner_domain key`);
  }
});

test("a file whose partner_domain header used a case/whitespace variant resolves identically to the canonical lowercase header, through the full normalize -> validate pipeline (Blocker A1 regression)", () => {
  for (const headerKey of ["partner_domain", "Partner_Domain", "PARTNER_DOMAIN", " partner_domain "]) {
    const { partner_domain, ...rest } = baseRow();
    const variantRow = headerKey === "partner_domain" ? baseRow() : { ...rest, [headerKey]: partner_domain };
    const [normalized] = normalizeImportRows([variantRow]);
    const result = validateImportRow(normalized!, 1, baseRef(), new Set());
    assert.equal(result.status, "ready", `header "${headerKey}" must resolve to ready, not "Partner domain not found"`);
    assert.equal(result.resolved?.companyId, "company-1");
  }
});

test("normalizeImportRows normalizes keys only -- it never mutates field values", () => {
  const [normalized] = normalizeImportRows([baseRow({ opportunity_name: "  UiPath  Expansion  " })]);
  assert.equal(normalized!.opportunity_name, "UiPath  Expansion", "internal whitespace in a value must be preserved verbatim, only the surrounding trim from normalizeRawRow applies");
});

// ---- Blocker A2: ambiguous canonical-domain matches must never be --------
// ---- silently resolved to an arbitrary company ----------------------------

test("a domain flagged ambiguous by GET /companies/by-domain produces a row error, never a silent pick", () => {
  const ref = baseRef();
  ref.ambiguousDomains = new Set(["uipath.com"]);
  const result = validateImportRow(baseRow(), 1, ref, new Set());
  assert.equal(result.status, "error");
  assert.ok(result.errors.some((e) => e.includes("more than one existing company")));
  assert.equal(result.resolved, undefined, "an ambiguous domain must never carry a resolved company");
});

test("ambiguousDomains takes precedence even if the same normalized domain also happens to be present in companiesByDomain", () => {
  const ref = baseRef();
  ref.ambiguousDomains = new Set(["uipath.com"]);
  // companiesByDomain still has "uipath.com" -> COMPANY from baseRef(); the
  // ambiguous flag must still win, since it means the exact-domain lookup
  // itself refused to pick between multiple rows.
  const result = validateImportRow(baseRow(), 1, ref, new Set());
  assert.equal(result.status, "error");
});

// ---- header validation -------------------------------------------------------

test("validateHeaders passes when every required column is present (case/whitespace-insensitive)", () => {
  const headers = IMPORT_CSV_COLUMNS.map((c) => ` ${c.toUpperCase()} `);
  assert.deepEqual(validateHeaders(headers), []);
});

test("validateHeaders reports every missing required column", () => {
  const missing = validateHeaders(["external_id", "opportunity_name"]);
  assert.ok(missing.some((m) => m.includes("partner_domain")));
  assert.ok(missing.some((m) => m.includes("pam_email")));
});

// ---- core row validation ------------------------------------------------------

test("a fully valid row resolves to ready, with source_system always 'import' and external_id preserved", () => {
  const result = validateImportRow(baseRow(), 1, baseRef(), new Set());
  assert.equal(result.status, "ready");
  assert.equal(result.input?.source_system, "import");
  assert.equal(result.input?.external_id, "ext-1");
});

test("external_id is required -- a blank value is a row error, never silently substituted", () => {
  const result = validateImportRow(baseRow({ external_id: "" }), 1, baseRef(), new Set());
  assert.equal(result.status, "error");
  assert.ok(result.errors.some((e) => e.includes("external_id")));
});

test("duplicate external_id within the same file is detected on the second occurrence", () => {
  const seen = new Set<string>();
  const ref = baseRef();
  const first = validateImportRow(baseRow({ external_id: "dup-1" }), 1, ref, seen);
  const second = validateImportRow(baseRow({ external_id: "dup-1" }), 2, ref, seen);
  assert.equal(first.status, "ready");
  assert.equal(second.status, "error");
  assert.ok(second.errors.some((e) => e.includes("Duplicate external_id")));
});

test("an external_id already present in source_system='import' history is reported as duplicate, not re-created", () => {
  const result = validateImportRow(baseRow({ external_id: "already-1" }), 1, baseRef(), new Set());
  assert.equal(result.status, "duplicate");
  assert.equal(result.input, undefined, "a duplicate row must never carry a submittable input");
});

test("canonical partner-domain resolution uses the exact companies.domain match -- fuzzy company-name text is never consulted", () => {
  const ref = baseRef();
  const result = validateImportRow(baseRow({ partner_domain: "uipath.com" }), 1, ref, new Set());
  assert.equal(result.resolved?.companyId, "company-1");
});

test("an unresolvable partner domain becomes a row error, never a silently-created company", () => {
  const result = validateImportRow(baseRow({ partner_domain: "unknown-partner.example" }), 1, baseRef(), new Set());
  assert.equal(result.status, "error");
  assert.ok(result.errors.some((e) => e.includes("Partner domain") && e.includes("not found")));
});

test("PAM resolution is by exact active email, never by display name, and never matches an inactive or non-PAM user", () => {
  const ref = baseRef();
  assert.equal(validateImportRow(baseRow({ pam_email: "Denny Morais" }), 1, ref, new Set()).status, "error");
  assert.equal(validateImportRow(baseRow({ pam_email: "inactive@druidai.com" }), 1, ref, new Set()).status, "error");
  assert.equal(validateImportRow(baseRow({ pam_email: "irina@druidai.com" }), 1, ref, new Set()).status, "error", "a head_of_channels email must not resolve as a PAM assignee");
  const ok = validateImportRow(baseRow({ pam_email: "DENNY.MORAIS@druidai.com" }), 1, ref, new Set());
  assert.equal(ok.status, "ready", "email matching is case-insensitive but still exact");
});

test("the resolved territory is always the PAM's canonical owned territory, never CSV free text", () => {
  const result = validateImportRow(baseRow(), 1, baseRef(), new Set());
  assert.equal(result.resolved?.territoryId, "territory-1");
  assert.equal(result.input?.territory_id, "territory-1");
});

test("a PAM with no canonical territory produces a row error", () => {
  const ref = baseRef();
  ref.territoriesByOwnerUserId = new Map();
  const result = validateImportRow(baseRow(), 1, ref, new Set());
  assert.equal(result.status, "error");
  assert.ok(result.errors.some((e) => e.includes("no canonical territory")));
});

test("attribution_type only accepts partner_sourced/partner_influenced", () => {
  assert.equal(validateImportRow(baseRow({ attribution_type: "partner_sourced" }), 1, baseRef(), new Set()).status, "ready");
  assert.equal(validateImportRow(baseRow({ attribution_type: "partner_influenced" }), 1, baseRef(), new Set()).status, "ready");
  assert.equal(validateImportRow(baseRow({ attribution_type: "referral" }), 1, baseRef(), new Set()).status, "error");
});

test("currency only accepts USD/EUR/GBP", () => {
  for (const currency of ["USD", "EUR", "GBP"]) {
    assert.equal(validateImportRow(baseRow({ currency }), 1, baseRef(), new Set()).status, "ready");
  }
  assert.equal(validateImportRow(baseRow({ currency: "CHF" }), 1, baseRef(), new Set()).status, "error");
});

test("native deal currency and value are preserved verbatim, never converted", () => {
  const result = validateImportRow(baseRow({ deal_value: "45000", currency: "EUR" }), 1, baseRef(), new Set());
  assert.equal(result.input?.deal_value, 45000);
  assert.equal(result.input?.currency, "EUR");
});

test("status=won requires closed_at", () => {
  const withoutClosedAt = validateImportRow(baseRow({ status: "won" }), 1, baseRef(), new Set());
  assert.equal(withoutClosedAt.status, "error");
  assert.ok(withoutClosedAt.errors.some((e) => e.includes("closed_at")));

  const withClosedAt = validateImportRow(baseRow({ status: "won", closed_at: "2025-12-01" }), 1, baseRef(), new Set());
  assert.equal(withClosedAt.status, "ready");
  assert.equal(withClosedAt.input?.status, "won");
});

test("historical closed_at is preserved verbatim (same bare YYYY-MM-DD the manual form sends) and is never rewritten from credit_date", () => {
  const result = validateImportRow(baseRow({ status: "won", closed_at: "2025-01-15", credit_date: "2026-01-01" }), 1, baseRef(), new Set());
  assert.equal(result.input?.closed_at, "2025-01-15");
  assert.equal(result.input?.credit_date, "2026-01-01");
});

test("credit_date can be set without credit_value", () => {
  const result = validateImportRow(baseRow({ credit_date: "2026-01-01" }), 1, baseRef(), new Set());
  assert.equal(result.status, "ready");
  assert.equal(result.input?.credit_date, "2026-01-01");
  assert.equal(result.input?.credit_value, null);
});

test("credit_value can be set without credit_date", () => {
  const result = validateImportRow(baseRow({ credit_value: "5000" }), 1, baseRef(), new Set());
  assert.equal(result.status, "ready");
  assert.equal(result.input?.credit_value, 5000);
  assert.equal(result.input?.credit_date, null);
});

test("blank credit fields stay null -- never defaulted to deal_value/closed_at by the importer itself", () => {
  const result = validateImportRow(baseRow(), 1, baseRef(), new Set());
  assert.equal(result.input?.credit_value, null);
  assert.equal(result.input?.credit_date, null);
});

test("a non-positive credit_value is a row error", () => {
  const result = validateImportRow(baseRow({ credit_value: "0" }), 1, baseRef(), new Set());
  assert.equal(result.status, "error");
});

test("deal_value must be a positive number", () => {
  assert.equal(validateImportRow(baseRow({ deal_value: "0" }), 1, baseRef(), new Set()).status, "error");
  assert.equal(validateImportRow(baseRow({ deal_value: "-5" }), 1, baseRef(), new Set()).status, "error");
  assert.equal(validateImportRow(baseRow({ deal_value: "abc" }), 1, baseRef(), new Set()).status, "error");
});

test("opportunity_date must be an ISO YYYY-MM-DD date", () => {
  assert.equal(validateImportRow(baseRow({ opportunity_date: "11/01/2025" }), 1, baseRef(), new Set()).status, "error");
  assert.equal(validateImportRow(baseRow({ opportunity_date: "" }), 1, baseRef(), new Set()).status, "error");
});

test("validateImportRows processes a whole file and dedupes external_id across the batch", () => {
  const results = validateImportRows([baseRow({ external_id: "a" }), baseRow({ external_id: "a" }), baseRow({ external_id: "b" })], baseRef());
  assert.equal(results[0]!.status, "ready");
  assert.equal(results[1]!.status, "error");
  assert.equal(results[2]!.status, "ready");
});

// ---- template ------------------------------------------------------------------

test("buildCsvTemplate's header row contains exactly the documented CSV contract columns", () => {
  const [header] = buildCsvTemplate().split("\n");
  assert.deepEqual(header!.split(","), [...IMPORT_CSV_COLUMNS]);
});
