// Service boundary for a real web-page-extraction provider (e.g. Firecrawl,
// Apify -- see the product spec, section 8.2). No live HTTP calls are
// implemented yet: this function throws until a specific provider is chosen
// and wired up, so discoveryEngine.ts never silently fabricates page
// content. Once implemented, read the provider choice from
// `connection.configJson.provider` and the API key from
// `process.env[connection.credentialEnvVar]`.

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

export async function extract(_url: string): Promise<ExtractedPage> {
  throw new ExtractionNotImplementedError();
}
