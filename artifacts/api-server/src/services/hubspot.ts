const HUBSPOT_BASE_URL = "https://api.hubapi.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export type HubSpotErrorCode =
  | "authentication_error"
  | "permission_error"
  | "rate_limited"
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
