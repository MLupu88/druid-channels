// Service boundary for turning a search result into page text for
// qualification. Stage 3 completion deliberately does NOT add a second
// external call here (no Firecrawl, no separate crawling/extraction
// vendor): Tavily's search result already returns enough content, so
// discoveryEngine.ts always calls this with `prefetched` set to what
// Tavily returned, and this function only validates/bounds it -- no
// network request happens inside it. Calling this WITHOUT prefetched
// content still throws: there is no live extraction provider, and this
// must never silently fabricate page content.

export class ExtractionNotImplementedError extends Error {
  constructor() {
    super("Web page extraction is not implemented yet. Configure a connection and implement this call before relying on live discovery.");
    this.name = "ExtractionNotImplementedError";
  }
}

export interface ExtractedPage {
  url: string;
  text: string;
  publishedAt: string | null;
}

// A safety cap on what gets forwarded to the AI qualifier -- Tavily's
// `content` is already a search snippet, not a full page, so this rarely
// actually truncates anything; it exists to bound worst-case prompt size.
const MAX_TEXT_LENGTH = 4000;

export async function extract(url: string, prefetched?: { text: string; publishedAt: string | null }): Promise<ExtractedPage> {
  if (!prefetched || !prefetched.text.trim()) throw new ExtractionNotImplementedError();
  return {
    url,
    text: prefetched.text.slice(0, MAX_TEXT_LENGTH),
    publishedAt: prefetched.publishedAt,
  };
}
