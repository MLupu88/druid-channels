// Production UX fix: Admin > Connections & data cards were reordering on
// every "Test connection" click, and the informational "credential present,
// live verification not implemented yet" state was rendered as a red
// failure -- including for connections that were never even tested yet
// (status stays "not_configured" until "Test connection" is clicked, even
// if the credential env var is already set) and for optional integrations
// (Web Reader / HubSpot) that simply have no credential configured, which
// is a normal, expected, non-alarming state, not an outage.

export const CONNECTION_DISPLAY_ORDER = ["ai", "web_search", "web_reader", "hubspot"] as const;

// A stable sort (Array.prototype.sort is spec-guaranteed stable): known
// provider types are placed in the fixed order above; any unrecognized
// provider type is appended at the end, in its original relative order,
// rather than crashing or being dropped. Unchanged by the status-semantics
// correction below.
export function sortConnectionsByDisplayOrder<T extends { provider_type: string }>(connections: readonly T[]): T[] {
  const priorityOf = (providerType: string): number => {
    const idx = CONNECTION_DISPLAY_ORDER.indexOf(providerType as (typeof CONNECTION_DISPLAY_ORDER)[number]);
    return idx === -1 ? CONNECTION_DISPLAY_ORDER.length : idx;
  };
  return [...connections].sort((a, b) => priorityOf(a.provider_type) - priorityOf(b.provider_type));
}

// The four raw DB statuses (not_configured | unverified | connected | error)
// collapse to three *presentation* tones. Deliberately keyed off
// has_credential (computed live from the env var, same as the API's own
// has_credential field) rather than the raw status string alone, so a
// connection whose credential is already set but has simply never been
// tested yet (status still "not_configured") is never mistaken for a real
// problem:
//
// - "connected": a real, implemented live check succeeded.
// - "configured": credential is present, but there is either no live check
//   implemented for this provider yet, or it just hasn't been run yet.
//   Amber, informational -- this is what AI/Web Search currently show once
//   their env var is set, since no live verification call exists for them.
// - "not_configured": credential is absent. Neutral/grey, never red -- a
//   missing credential on this settings page is a normal configuration
//   state (especially for an optional integration like Web Reader/HubSpot
//   that nothing currently depends on), not evidence the app is unhealthy.
// - "error": a real, implemented live check actually failed. The only tone
//   that is ever styled as a failure.
export type ConnectionTone = "connected" | "configured" | "not_configured" | "error";

export function getConnectionTone(status: string, hasCredential: boolean): ConnectionTone {
  if (status === "connected") return "connected";
  if (status === "error") return "error";
  return hasCredential ? "configured" : "not_configured";
}

// Single source of truth for "is this tone a real problem" -- drives both
// the status badge and the last_error supporting text color, and (in
// settings.tsx) the Test connection toast, so none of the three can ever
// disagree with each other about whether something actually failed.
export function isErrorTone(tone: ConnectionTone): boolean {
  return tone === "error";
}
