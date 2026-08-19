// Phase 11.6D: frontend-only display metadata keyed by the stable backend
// provider_type (never renamed/mutated in the DB -- see services/
// connections.ts's DEFAULT_PROVIDERS and connection-display.ts, both
// untouched). Settings > Connections & data previously showed the raw
// generic provider_name ("AI", "Web Search") stored on the connections row
// -- this file is the single place that maps each stable identity to the
// actual product-facing name, purpose, and capability list, without ever
// touching the row itself.
//
// "powers" lists are deliberately verified against the actual call sites
// in the repo (grep for resolveProviderSecret("ai") / ("web_search")) as
// of Phase 11.6D, not guessed -- update this list if a future call site is
// added or removed, don't let it silently drift from reality.
export interface ConnectionProviderMeta {
  displayName: string;
  purpose: string;
  powers: string[];
  // web_reader: never shown in the product-facing Connections list at all
  // (it is genuinely unwired -- see druidContextIngestionProvider.ts's own
  // comment: Tavily's search result content already flows directly through
  // extraction.ts with no second "reader" call). The DB row and backend
  // identity are untouched -- this is a display-only omission.
  hiddenFromList?: boolean;
}

export const CONNECTION_PROVIDER_META: Record<string, ConnectionProviderMeta> = {
  ai: {
    displayName: 'DeepSeek',
    purpose: 'AI reasoning used across qualification, radar analysis, and management reporting.',
    powers: [
      'Discovery qualification & company identity',
      'Channel Radar qualification & classification',
      'AI Channel Brief',
      'PAM Copilot',
      'Portfolio import normalization',
    ],
  },
  web_search: {
    displayName: 'Tavily',
    purpose: 'Web research and page extraction that powers live, evidence-grounded discovery.',
    powers: ['Discovery web search', 'DRUID Context source ingestion (druidai.com)'],
  },
  web_reader: {
    displayName: 'Web Reader',
    purpose: '',
    powers: [],
    hiddenFromList: true,
  },
  hubspot: {
    displayName: 'HubSpot',
    purpose: 'Read-only CRM access for company and deal lookup and opportunity reconciliation.',
    powers: ['Company lookup', 'Deal lookup and reconciliation'],
  },
};
