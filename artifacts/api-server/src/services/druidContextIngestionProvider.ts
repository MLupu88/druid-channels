// Service boundary for the live Tavily Crawl call that powers DRUID Context
// ingestion (Phase 11.5C.2). Tavily is the implemented provider, reusing the
// same SEARCH_PROVIDER=tavily / web_search credential already configured for
// Discovery (services/discoveryProviders/search.ts) -- but this module's
// request shape, response handling, and hardening are entirely its own,
// deliberately not imported from discoveryProviders/search.ts. Same
// convention already established across every other provider module in this
// codebase (discoveryProviders/ai.ts, channelRadarProviders/ai.ts,
// aiBriefProvider.ts): sibling features that happen to share a credential
// get their own small, independently maintainable module, not a shared one.
//
// This file only talks to Tavily and validates/bounds its response -- no DB
// logic lives here (see services/druidContextSources.ts for
// dedupe/persistence/lifecycle).
import { resolveProviderSecret, hasResolvableCredential } from "./connections";

export class DruidContextCrawlNotImplementedError extends Error {
  constructor() {
    super("DRUID context ingestion is not implemented yet. Configure a web search connection before refreshing from druidai.com.");
    this.name = "DruidContextCrawlNotImplementedError";
  }
}

// A small closed set of internal failure classifications -- never the raw
// provider error text, same convention as SearchProviderError/AiProviderError.
export class DruidContextCrawlProviderError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "DruidContextCrawlProviderError";
  }
}

export interface CrawledPage {
  url: string;
  text: string;
}

// The only DRUID site this ingestion feature is ever allowed to touch.
// Subdomains are accepted (e.g. "app.druidai.com"), everything else is
// rejected -- enforced locally here, not merely via Tavily's own
// allow_external parameter, so a provider response can never smuggle an
// off-domain page into persistence even if the request-level guard were
// ever misconfigured or ignored by the provider.
const DRUID_ROOT_URL = "https://druidai.com";
const DRUID_ROOT_DOMAIN = "druidai.com";

function isDruidDomainUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return hostname === DRUID_ROOT_DOMAIN || hostname.endsWith(`.${DRUID_ROOT_DOMAIN}`);
}

// Bounded well under Tavily's own 10-150s documented range for /crawl --
// this is the actual enforcement mechanism (AbortController), not an
// invented request-body field. Tavily's /crawl request DOES document an
// optional "timeout" field, but the approved design's explicit minimum
// field list (url, limit, allow_external, format, extract_depth) does not
// include it, so it is deliberately omitted from the request body here.
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 2_000_000;
// Matches Tavily's own documented default range for /crawl's `limit`
// (total links processed before stopping) -- deliberately small for a
// grounding-facts use case, not a full site crawl.
const CRAWL_LIMIT = 20;

export async function isConfigured(): Promise<boolean> {
  return process.env.SEARCH_PROVIDER === "tavily" && (await hasResolvableCredential("web_search"));
}

export async function crawl(): Promise<CrawledPage[]> {
  if (!(await isConfigured())) throw new DruidContextCrawlNotImplementedError();
  const apiKey = await resolveProviderSecret("web_search");
  if (!apiKey) throw new DruidContextCrawlNotImplementedError();
  return crawlViaTavily(apiKey);
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test -- same convention as searchViaTavily.
export async function crawlViaTavily(apiKey: string): Promise<CrawledPage[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/crawl", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        url: DRUID_ROOT_URL,
        limit: CRAWL_LIMIT,
        allow_external: false,
        format: "text",
        extract_depth: "basic",
      }),
    });
  } catch (err) {
    throw new DruidContextCrawlProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new DruidContextCrawlProviderError("http_error");

  // Read as text first and enforce a size ceiling before ever parsing --
  // the raw text/API key are never logged, on any path here.
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new DruidContextCrawlProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DruidContextCrawlProviderError("malformed_json");
  }

  if (!Array.isArray(body?.results)) {
    throw new DruidContextCrawlProviderError("malformed_response");
  }

  return body.results
    .filter((r: any) => typeof r?.url === "string" && typeof r?.raw_content === "string")
    .filter((r: any) => isDruidDomainUrl(r.url))
    .slice(0, CRAWL_LIMIT)
    .map((r: any) => ({ url: r.url, text: r.raw_content }));
}
