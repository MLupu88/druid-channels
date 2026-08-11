// Service boundary for the live web-search provider. Tavily is the
// implemented provider (Stage 3 completion -- no Firecrawl, no separate
// crawling vendor). Mirrors aiBriefProvider.ts's exact hardening
// conventions: bounded timeout, size-capped response, no retries, and a
// stable NotConfigured/ProviderError split so discoveryEngine.ts never
// silently reports a live search that didn't happen.
import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hasCredential } from "../connections";

export class SearchNotImplementedError extends Error {
  constructor() {
    super("Web search is not implemented yet. Configure a connection and implement this call before relying on live discovery.");
    this.name = "SearchNotImplementedError";
  }
}

// A small closed set of internal failure classifications -- never the raw
// provider error text. See classifyDiscoveryFailure() in discoveryEngine.ts
// for the user-facing mapping.
export class SearchProviderError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "SearchProviderError";
  }
}

export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  // Tavily's documented search response has no per-result publish date --
  // never fabricated as "today". Honestly null unless a provider actually
  // supplies one.
  publishedAt: string | null;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 300_000;

export async function isConfigured(): Promise<boolean> {
  const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.providerType, "web_search"));
  return process.env.SEARCH_PROVIDER === "tavily" && hasCredential(conn?.credentialEnvVar ?? null);
}

export async function search(query: string, opts: { maxResults: number; startDate?: string }): Promise<WebSearchResult[]> {
  if (!(await isConfigured())) throw new SearchNotImplementedError();

  switch (process.env.SEARCH_PROVIDER) {
    case "tavily":
      return searchViaTavily(query, opts);
    default:
      throw new SearchNotImplementedError();
  }
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test.
//
// startDate (YYYY-MM-DD), when provided, is passed through as Tavily's own
// documented `start_date` request parameter -- a real, provider-enforced
// recency window (confirmed against Tavily's API reference: /search
// accepts time_range/start_date/end_date). Not every caller needs one
// (Discovery's own live search doesn't), so it stays optional -- only
// Channel Radar's lookback_days currently derives it (see
// channelRadarEngine.ts's computeLookbackStartDate).
export async function searchViaTavily(query: string, opts: { maxResults: number; startDate?: string }): Promise<WebSearchResult[]> {
  const apiKey = process.env.SEARCH_API_KEY;
  if (!apiKey) throw new SearchNotImplementedError();

  const maxResults = Math.max(1, Math.min(20, opts.maxResults));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        topic: "general",
        ...(opts.startDate ? { start_date: opts.startDate } : {}),
      }),
    });
  } catch (err) {
    throw new SearchProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new SearchProviderError("http_error");

  // Read as text first and enforce a size ceiling before ever parsing --
  // the raw text/API key are never logged, on any path here.
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new SearchProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SearchProviderError("malformed_json");
  }

  if (!Array.isArray(body?.results)) {
    throw new SearchProviderError("malformed_response");
  }

  return body.results
    .filter((r: any) => typeof r?.url === "string" && typeof r?.title === "string")
    .map((r: any) => ({
      url: r.url,
      title: r.title,
      snippet: typeof r.content === "string" ? r.content : "",
      publishedAt: null,
    }));
}
