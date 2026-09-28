const HUBSPOT_BASE_URL = "https://api.hubapi.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export type HubSpotErrorCode =
  | "authentication_error"
  | "permission_error"
  | "rate_limited"
  | "not_found"
  | "timeout"
  | "network_error"
  | "malformed_json"
  | "malformed_response"
  | "http_error";

export class HubSpotProviderError extends Error {
  constructor(public readonly code: HubSpotErrorCode) {
    super(code);
    this.name = "HubSpotProviderError";
  }
}

export class HubSpotInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubSpotInputError";
  }
}

export class HubSpotAmbiguousCompanyError extends Error {
  constructor(
    public readonly domain: string,
    public readonly matchCount: number,
  ) {
    super(`HubSpot returned ${matchCount} companies with the exact domain ${domain}.`);
    this.name = "HubSpotAmbiguousCompanyError";
  }
}

export class HubSpotNotImplementedError extends Error {
  constructor(operation: string) {
    super(`HubSpot ${operation} is not implemented yet. Configure a connection and implement this call before mapping a KPI to HUBSPOT.`);
    this.name = "HubSpotNotImplementedError";
  }
}

interface HubSpotRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

async function hubSpotRequest(accessToken: string, path: string, options: HubSpotRequestOptions = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: controller.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    throw new HubSpotProviderError(error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 401) throw new HubSpotProviderError("authentication_error");
    if (response.status === 403) throw new HubSpotProviderError("permission_error");
    if (response.status === 404) throw new HubSpotProviderError("not_found");
    if (response.status === 429) throw new HubSpotProviderError("rate_limited");
    throw new HubSpotProviderError("http_error");
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new HubSpotProviderError("malformed_response");

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HubSpotProviderError("malformed_json");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireResults(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body) || !Array.isArray(body.results) || body.results.some((result) => !isRecord(result))) {
    throw new HubSpotProviderError("malformed_response");
  }
  return body.results as Array<Record<string, unknown>>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function testFailureMessage(code: HubSpotErrorCode): string {
  switch (code) {
    case "authentication_error":
      return "HubSpot authentication failed. Check the configured access token.";
    case "permission_error":
      return "HubSpot denied access. The token needs companies read permission.";
    case "rate_limited":
      return "HubSpot rate limit reached. Try again later.";
    case "timeout":
      return "HubSpot connection timed out. Try again later.";
    case "network_error":
      return "HubSpot could not be reached due to a network error.";
    case "malformed_json":
    case "malformed_response":
      return "HubSpot returned an invalid response.";
    case "not_found":
    case "http_error":
      return "HubSpot returned an unexpected error.";
  }
}

export async function testConnection(accessToken: string): Promise<{ ok: boolean; message: string }> {
  try {
    const body = await hubSpotRequest(accessToken, "/crm/v3/objects/companies?limit=1&properties=hs_object_id");
    requireResults(body);
    return { ok: true, message: "HubSpot connection successful." };
  } catch (error) {
    if (error instanceof HubSpotProviderError) return { ok: false, message: testFailureMessage(error.code) };
    return { ok: false, message: "HubSpot connection failed unexpectedly." };
  }
}

export interface HubSpotCompany {
  id: string;
  name: string | null;
  domain: string | null;
  objectId: string;
}

export function normalizeHubSpotDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) throw new HubSpotInputError("A company domain is required.");

  let hostname: string;
  try {
    hostname = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new HubSpotInputError("The company domain is invalid.");
  }

  const normalized = hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (!normalized || normalized.includes(" ")) throw new HubSpotInputError("The company domain is invalid.");
  return normalized;
}

export async function findCompanyByDomain(accessToken: string, domain: string): Promise<HubSpotCompany | null> {
  const normalizedDomain = normalizeHubSpotDomain(domain);
  const body = await hubSpotRequest(accessToken, "/crm/v3/objects/companies/search", {
    method: "POST",
    body: {
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: normalizedDomain }] }],
      properties: ["name", "domain", "hs_object_id"],
      limit: 2,
    },
  });
  const results = requireResults(body);

  if (results.length === 0) return null;
  if (results.length > 1) throw new HubSpotAmbiguousCompanyError(normalizedDomain, results.length);

  const result = results[0]!;
  if (typeof result.id !== "string" || !isRecord(result.properties)) {
    throw new HubSpotProviderError("malformed_response");
  }

  return {
    id: result.id,
    name: optionalString(result.properties.name),
    domain: optionalString(result.properties.domain),
    objectId: optionalString(result.properties.hs_object_id) ?? result.id,
  };
}

export interface HubSpotDealSearchQuery {
  query: string;
  limit?: number;
}

export interface HubSpotDeal {
  id: string;
  dealName: string | null;
  amount: string | null;
  closeDate: string | null;
  pipeline: string | null;
  dealStage: string | null;
  createDate: string | null;
  lastModifiedDate: string | null;
  objectId: string;
}

const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "closedate",
  "pipeline",
  "dealstage",
  "createdate",
  "hs_lastmodifieddate",
  "hs_object_id",
] as const;

export async function searchDeals(accessToken: string, query: HubSpotDealSearchQuery): Promise<HubSpotDeal[]> {
  const textQuery = query.query.trim();
  if (!textQuery) throw new HubSpotInputError("A deal name query is required.");
  const requestedLimit = query.limit ?? 20;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(20, Math.trunc(requestedLimit))) : 20;

  const body = await hubSpotRequest(accessToken, "/crm/v3/objects/deals/search", {
    method: "POST",
    body: { query: textQuery, properties: DEAL_PROPERTIES, limit },
  });

  return requireResults(body).map((result) => {
    if (typeof result.id !== "string" || !isRecord(result.properties)) {
      throw new HubSpotProviderError("malformed_response");
    }
    const properties = result.properties;
    return {
      id: result.id,
      dealName: optionalString(properties.dealname),
      amount: optionalString(properties.amount),
      closeDate: optionalString(properties.closedate),
      pipeline: optionalString(properties.pipeline),
      dealStage: optionalString(properties.dealstage),
      createDate: optionalString(properties.createdate),
      lastModifiedDate: optionalString(properties.hs_lastmodifieddate),
      objectId: optionalString(properties.hs_object_id) ?? result.id,
    };
  });
}

// ---------------------------------------------------------------------------
// Commercial read primitives (GET-only). These represent HubSpot faithfully and
// never interpret values; deterministic interpretation lives in
// hubspotDealFacts.ts.
// ---------------------------------------------------------------------------

export const COMPANY_DEALS_MAX = 50;
const ASSOCIATION_PAGE_LIMIT = 100;
const MAX_ASSOCIATION_PAGES = 5;

function requireHubSpotId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new HubSpotInputError(`A numeric HubSpot ${label} ID is required.`);
  return trimmed;
}

function optionalId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export interface HubSpotAssociation {
  id: string;
  associationTypes: string[];
}

interface AssociationPage {
  rows: Array<{ id: string; type: string | null }>;
  nextAfter: string | null;
}

// Parses `{ results: [{ id, type }], paging?: { next?: { after } } }`, the shape
// used both inside object-read `associations.<type>` and by the v3 associations
// list endpoint. Only the opaque `after` cursor is taken from paging; returned
// links are never followed.
function parseAssociationPage(value: unknown): AssociationPage {
  if (value === undefined || value === null) return { rows: [], nextAfter: null };
  if (!isRecord(value) || !Array.isArray(value.results)) throw new HubSpotProviderError("malformed_response");
  const rows = value.results.map((row) => {
    if (!isRecord(row)) throw new HubSpotProviderError("malformed_response");
    const id = optionalId(row.id);
    if (!id) throw new HubSpotProviderError("malformed_response");
    return { id, type: optionalString(row.type) };
  });
  const next = isRecord(value.paging) && isRecord(value.paging.next) ? value.paging.next : null;
  const nextAfter = next ? optionalId(next.after) : null;
  return { rows, nextAfter };
}

function mergeAssociationRows(
  target: Map<string, HubSpotAssociation>,
  rows: AssociationPage["rows"],
  max: number,
): boolean {
  let overflow = false;
  for (const row of rows) {
    let entry = target.get(row.id);
    if (!entry) {
      if (target.size >= max) {
        overflow = true;
        continue;
      }
      entry = { id: row.id, associationTypes: [] };
      target.set(row.id, entry);
    }
    if (row.type && !entry.associationTypes.includes(row.type)) entry.associationTypes.push(row.type);
  }
  return overflow;
}

export interface HubSpotCompanyDealAssociations {
  deals: Array<{ dealId: string; associationTypes: string[] }>;
  // Number of deals included in this response. Not HubSpot's total: when
  // `truncated` is true the full association count is unknown.
  returnedCount: number;
  truncated: boolean;
}

export async function listCompanyDealAssociations(
  accessToken: string,
  companyId: string,
  maxDeals: number = COMPANY_DEALS_MAX,
): Promise<HubSpotCompanyDealAssociations> {
  const id = requireHubSpotId(companyId, "company");
  const max = Number.isFinite(maxDeals) ? Math.max(1, Math.min(COMPANY_DEALS_MAX, Math.trunc(maxDeals))) : COMPANY_DEALS_MAX;
  const encodedId = encodeURIComponent(id);

  const company = await hubSpotRequest(accessToken, `/crm/v3/objects/companies/${encodedId}?associations=deals`);
  if (!isRecord(company)) throw new HubSpotProviderError("malformed_response");
  const associations = company.associations;
  if (associations !== undefined && associations !== null && !isRecord(associations)) {
    throw new HubSpotProviderError("malformed_response");
  }

  const deals = new Map<string, HubSpotAssociation>();
  let page = parseAssociationPage(isRecord(associations) ? associations.deals : undefined);
  let truncated = mergeAssociationRows(deals, page.rows, max);
  let pagesFetched = 1;

  while (page.nextAfter && !truncated) {
    if (deals.size >= max || pagesFetched >= MAX_ASSOCIATION_PAGES) {
      truncated = true;
      break;
    }
    const params = new URLSearchParams({ limit: String(ASSOCIATION_PAGE_LIMIT), after: page.nextAfter });
    page = parseAssociationPage(
      await hubSpotRequest(accessToken, `/crm/v3/objects/companies/${encodedId}/associations/deals?${params.toString()}`),
    );
    pagesFetched += 1;
    truncated = mergeAssociationRows(deals, page.rows, max);
  }

  const result = [...deals.values()].map((deal) => ({ dealId: deal.id, associationTypes: deal.associationTypes }));
  return { deals: result, returnedCount: result.length, truncated };
}

export const DEAL_CURRENT_PROPERTIES = [
  "dealname",
  "amount",
  "deal_currency_code",
  "pipeline",
  "dealstage",
  "closedate",
  "createdate",
  "hs_is_closed",
  "hs_is_closed_won",
  "hs_is_closed_lost",
  "hubspot_owner_id",
  "hs_lastmodifieddate",
] as const;

export const DEAL_HISTORY_PROPERTIES = [
  "dealstage",
  "amount",
  "deal_currency_code",
  "closedate",
  "pipeline",
  "hubspot_owner_id",
] as const;

export type HubSpotDealCurrentProperty = (typeof DEAL_CURRENT_PROPERTIES)[number];
export type HubSpotDealHistoryProperty = (typeof DEAL_HISTORY_PROPERTIES)[number];

export interface HubSpotPropertyHistoryEntry {
  value: string | null;
  timestamp: string;
  sourceType: string | null;
  sourceId: string | null;
}

export interface HubSpotDealWithHistory {
  id: string;
  properties: Record<HubSpotDealCurrentProperty, string | null>;
  propertiesWithHistory: Record<HubSpotDealHistoryProperty, HubSpotPropertyHistoryEntry[]>;
  companies: HubSpotAssociation[];
  companiesHasMore: boolean;
}

function parseHistoryEntries(value: unknown): HubSpotPropertyHistoryEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HubSpotProviderError("malformed_response");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.timestamp !== "string") throw new HubSpotProviderError("malformed_response");
    return {
      value: optionalString(entry.value),
      timestamp: entry.timestamp,
      sourceType: optionalString(entry.sourceType),
      sourceId: optionalString(entry.sourceId),
    };
  });
}

export async function getDealWithHistory(accessToken: string, dealId: string): Promise<HubSpotDealWithHistory> {
  const id = requireHubSpotId(dealId, "deal");
  const params = new URLSearchParams({
    properties: DEAL_CURRENT_PROPERTIES.join(","),
    propertiesWithHistory: DEAL_HISTORY_PROPERTIES.join(","),
    associations: "companies",
  });
  const body = await hubSpotRequest(accessToken, `/crm/v3/objects/deals/${encodeURIComponent(id)}?${params.toString()}`);
  const bodyId = isRecord(body) ? optionalId(body.id) : null;
  const rawProperties = isRecord(body) ? body.properties : undefined;
  if (!isRecord(body) || bodyId === null || !isRecord(rawProperties)) {
    throw new HubSpotProviderError("malformed_response");
  }
  const rawHistory = body.propertiesWithHistory;
  if (rawHistory !== undefined && rawHistory !== null && !isRecord(rawHistory)) {
    throw new HubSpotProviderError("malformed_response");
  }
  const associations = body.associations;
  if (associations !== undefined && associations !== null && !isRecord(associations)) {
    throw new HubSpotProviderError("malformed_response");
  }

  const properties = Object.fromEntries(
    DEAL_CURRENT_PROPERTIES.map((name) => [name, optionalString(rawProperties[name])]),
  ) as Record<HubSpotDealCurrentProperty, string | null>;
  const propertiesWithHistory = Object.fromEntries(
    DEAL_HISTORY_PROPERTIES.map((name) => [name, parseHistoryEntries(isRecord(rawHistory) ? rawHistory[name] : undefined)]),
  ) as Record<HubSpotDealHistoryProperty, HubSpotPropertyHistoryEntry[]>;

  const companyPage = parseAssociationPage(isRecord(associations) ? associations.companies : undefined);
  const companies = new Map<string, HubSpotAssociation>();
  mergeAssociationRows(companies, companyPage.rows, Number.POSITIVE_INFINITY);

  return {
    id: bodyId,
    properties,
    propertiesWithHistory,
    companies: [...companies.values()],
    companiesHasMore: companyPage.nextAfter !== null,
  };
}

export interface HubSpotDealStage {
  id: string;
  label: string | null;
  displayOrder: number | null;
  archived: boolean | null;
  metadata: {
    isClosed: string | null;
    probability: string | null;
  };
}

export interface HubSpotDealPipeline {
  id: string;
  label: string | null;
  displayOrder: number | null;
  archived: boolean | null;
  stages: HubSpotDealStage[];
}

export async function listDealPipelines(accessToken: string): Promise<HubSpotDealPipeline[]> {
  const body = await hubSpotRequest(accessToken, "/crm/v3/pipelines/deals");
  return requireResults(body).map((pipeline) => {
    const id = optionalId(pipeline.id);
    if (!id || (pipeline.stages !== undefined && !Array.isArray(pipeline.stages))) {
      throw new HubSpotProviderError("malformed_response");
    }
    const stages = ((pipeline.stages as unknown[] | undefined) ?? []).map((stage) => {
      const stageId = isRecord(stage) ? optionalId(stage.id) : null;
      if (!isRecord(stage) || !stageId) throw new HubSpotProviderError("malformed_response");
      const metadata: Record<string, unknown> = isRecord(stage.metadata) ? stage.metadata : {};
      return {
        id: stageId,
        label: optionalString(stage.label),
        displayOrder: optionalNumber(stage.displayOrder),
        archived: optionalBoolean(stage.archived),
        metadata: {
          isClosed: optionalString(metadata.isClosed),
          probability: optionalString(metadata.probability),
        },
      };
    });
    return {
      id,
      label: optionalString(pipeline.label),
      displayOrder: optionalNumber(pipeline.displayOrder),
      archived: optionalBoolean(pipeline.archived),
      stages,
    };
  });
}

export interface HubSpotOwner {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  archived: boolean | null;
}

const OWNER_NOT_FOUND = Symbol("owner_not_found");

async function getOwnerBody(
  accessToken: string,
  ownerId: string,
  archived: boolean,
): Promise<unknown | typeof OWNER_NOT_FOUND> {
  try {
    return await hubSpotRequest(accessToken, `/crm/v3/owners/${encodeURIComponent(ownerId)}?archived=${archived}`);
  } catch (error) {
    if (error instanceof HubSpotProviderError && error.code === "not_found") return OWNER_NOT_FOUND;
    throw error;
  }
}

// HubSpot separates active and archived owners. The archived lookup runs only
// after the active lookup returns 404; null means both returned 404.
export async function getOwner(accessToken: string, ownerId: string): Promise<HubSpotOwner | null> {
  const id = requireHubSpotId(ownerId, "owner");
  let body = await getOwnerBody(accessToken, id, false);
  if (body === OWNER_NOT_FOUND) body = await getOwnerBody(accessToken, id, true);
  if (body === OWNER_NOT_FOUND) return null;
  const ownerIdValue = isRecord(body) ? optionalId(body.id) : null;
  if (!isRecord(body) || !ownerIdValue) throw new HubSpotProviderError("malformed_response");
  return {
    id: ownerIdValue,
    firstName: optionalString(body.firstName),
    lastName: optionalString(body.lastName),
    email: optionalString(body.email),
    archived: optionalBoolean(body.archived),
  };
}


export async function getPartners(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getPartners");
}

export async function getDeals(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getDeals; use the narrow read-only searchDeals function for reconciliation searches");
}

export async function getCampaignData(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getCampaignData");
}

export async function getRenewals(_accessToken: string): Promise<unknown[]> {
  throw new HubSpotNotImplementedError("getRenewals");
}
