// Service boundary for the live web-search provider. Tavily is the
// implemented provider (Stage 3 completion -- no Firecrawl, no separate
// crawling vendor). Mirrors aiBriefProvider.ts's exact hardening
// conventions: bounded timeout, size-capped response, no retries, and a
// stable NotConfigured/ProviderError split so discoveryEngine.ts never
// silently reports a live search that didn't happen.
import { resolveProviderSecret, hasResolvableCredential } from "../connections";

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
  // Tavily's own REST API reference documents `published_date` as an
  // optional per-result field, populated for topic="news" results (the JS
  // SDK exposes the same value camelCased as `publishedDate`; this file
  // talks to the REST endpoint directly via fetch, so the raw snake_case
  // `published_date` key is what actually appears on the wire -- see the
  // mapping below). It is optional/best-effort even for news results, and
  // Tavily does not document it being populated for topic="general" at
  // all, so it is parsed defensively regardless of topic: present and
  // valid -> a real date; missing or unparseable -> null, never fabricated
  // or inferred from url/title/content. The Radar-side hard recency rule
  // (see channelRadarEngine.ts's evaluateNewsRecency) treats a null value
  // here as unverified, never as "recent."
  publishedAt: string | null;
  // Phase 11.6.1 P3A: Tavily's own documented per-result relevance score
  // (verified against Tavily's /search API reference) -- previously
  // returned by the provider but silently discarded. Used only as a
  // deterministic ranking signal for candidate selection before AI
  // qualification (discoveryEngine.ts); never used to infer identity or
  // company grouping. Defaults to 0 if the provider ever omits it (never
  // fabricated as a high-confidence score).
  score: number;
}

// Parses Tavily's documented `published_date` field (see
// WebSearchResult.publishedAt's own comment) into a normalized date. Never
// infers a date from anything but this one raw value -- no URL/title/
// content inspection, no "today" fallback. Normalized to YYYY-MM-DD
// (matching channel_radar_signals.source_published_at's `date` column
// type) so it can be compared/persisted directly. Any value that isn't a
// parseable date -> null, exactly like a missing/omitted field.
function parseProviderPublishedDate(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 300_000;

// Phase 11.5B: resolution now goes through resolveProviderSecret (DB secret
// -> credentialEnvVar -> unavailable, honoring enabled=false) instead of a
// hardcoded process.env.SEARCH_API_KEY read -- see services/connections.ts.
// hasResolvableCredential is the safe wrapper: a broken/malformed
// encryption key is treated as "not configured" here (never crashes a scan
// mid-run); the admin Test Connection action surfaces that loudly instead.
export async function isConfigured(): Promise<boolean> {
  return process.env.SEARCH_PROVIDER === "tavily" && (await hasResolvableCredential("web_search"));
}

export async function search(
  query: string,
  opts: { maxResults: number; startDate?: string; topic?: "general" | "news" }
): Promise<WebSearchResult[]> {
  if (!(await isConfigured())) throw new SearchNotImplementedError();

  switch (process.env.SEARCH_PROVIDER) {
    case "tavily": {
      const apiKey = await resolveProviderSecret("web_search");
      if (!apiKey) throw new SearchNotImplementedError();
      return searchViaTavily(apiKey, query, opts);
    }
    default:
      throw new SearchNotImplementedError();
  }
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test. apiKey is now an explicit parameter (the caller
// resolves it via resolveProviderSecret) rather than read from
// process.env internally -- this function no longer knows or cares where
// the key came from.
//
// startDate (YYYY-MM-DD), when provided, is passed through as Tavily's own
// documented `start_date` request parameter -- a real, provider-enforced
// recency window (confirmed against Tavily's API reference: /search
// accepts time_range/start_date/end_date). Not every caller needs one
// (Discovery's own live search doesn't), so it stays optional -- only
// Channel Radar's lookback_days currently derives it (see
// channelRadarEngine.ts's computeLookbackStartDate).
//
// topic (Phase 11.6.1 Radar recency fix): Tavily's own documented /search
// parameter, "general" | "news" -- additive, defaults to "general" so
// EVERY existing caller (Discovery's live search, company-identity
// resolution evidence search, Channel Radar's own non-news queries) is
// byte-identical in request behavior unless it explicitly opts in.
// Channel Radar is the only caller that ever passes "news", and only for
// its NEWS-LIKE signal-type queries -- see channelRadarEngine.ts's
// NEWS_LIKE_SIGNAL_TYPES / buildRadarQueries.
export async function searchViaTavily(
  apiKey: string,
  query: string,
  opts: { maxResults: number; startDate?: string; topic?: "general" | "news" }
): Promise<WebSearchResult[]> {
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
        topic: opts.topic ?? "general",
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
      publishedAt: parseProviderPublishedDate(r.published_date),
      score: typeof r.score === "number" ? r.score : 0,
    }));
}

// Phase 11.5B: the real "Test connection" verification -- a single,
// minimal, bounded Tavily search (max_results: 1), reusing searchViaTavily
// itself so the test exercises the exact same request path a real scan
// uses, just with a trivial query. Resolves nothing (throws on failure);
// the caller (routes/connections.ts) maps success/failure to a status.
export async function testConnection(apiKey: string): Promise<void> {
  await searchViaTavily(apiKey, "test", { maxResults: 1 });
}
