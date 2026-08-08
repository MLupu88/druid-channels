// Service boundary for a real web-search provider (e.g. Tavily, Bing --
// see the product spec, section 8.1). No live HTTP calls are implemented
// yet: this function throws until a specific provider is chosen and wired
// up, so discoveryEngine.ts never silently reports a live search that
// didn't happen. Once implemented, read the provider choice from
// `connection.configJson.provider` and the API key from
// `process.env[connection.credentialEnvVar]`.

export class SearchNotImplementedError extends Error {
  constructor() {
    super("Web search is not implemented yet. Configure a connection and implement this call before relying on live discovery.");
    this.name = "SearchNotImplementedError";
  }
}

export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
}

export async function search(_query: string, _opts: { maxResults: number }): Promise<WebSearchResult[]> {
  throw new SearchNotImplementedError();
}
