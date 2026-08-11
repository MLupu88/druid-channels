// Phase 3A: canonical company identity. One shared, Public-Suffix-List-aware
// registrable-domain helper, used everywhere a company's own domain is
// written or matched (Discovery, Portfolio manual-add/PAM-import matching,
// and anywhere else that creates/matches companies by domain). Never used
// for evidence: signals.sourceDomain intentionally keeps the raw evidence
// hostname (see discoveryEngine.ts) -- identity and evidence are separate by
// design (Phase 3 audit).
//
// Uses tldts (a maintained Public Suffix List snapshot, no network calls) --
// deliberately not a "last two labels" heuristic, which gets multi-part
// suffixes like .co.uk wrong. allowPrivateDomains: true is a deliberate
// choice: PSL "private" entries (github.io, herokuapp.com, vercel.app, ...)
// are third-party hosting platforms where many unrelated companies share the
// same parent domain -- treating "foo.github.io" as its own registrable
// identity avoids incorrectly merging two different companies that happen to
// share a hosting platform. This never affects ordinary corporate domains
// (uipath.com, example.co.uk, ...), which are unambiguous either way.
import { getDomain } from "tldts";

// Applied before tldts sees the string, so tldts always receives a bare
// hostname: strips a scheme if present, then discards port/path/query via
// URL parsing (a URL's `.hostname` never includes them), lowercases, and
// strips a trailing root-zone dot ("uipath.com." is the same as
// "uipath.com").
function toHostname(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  if (!hostname) return null;

  return hostname.toLowerCase().replace(/\.$/, "");
}

// The one function every company-domain write/match path in this app must
// go through. Accepts a bare hostname, a domain with or without a scheme, or
// a full URL (with path/query/port) -- always returns the registrable
// domain (eTLD+1), or null if the input can't safely produce one (empty,
// malformed, an IP address, "localhost", etc.). Never a fabricated
// placeholder.
export function toRegistrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const hostname = toHostname(input);
  if (!hostname) return null;
  return getDomain(hostname, { allowPrivateDomains: true, validHosts: null }) ?? null;
}

// Small, deliberately non-exhaustive defense-in-depth guard: domains that
// must never become a company's identity even if the AI qualification step
// mis-classifies a piece of evidence hosted there as "first party" (see
// discoveryEngine.ts's resolveCandidateCompanyIdentity). This is a second,
// code-level line of defense on top of the prompt instruction -- not a
// replacement for it, and not an attempt to enumerate every publisher on
// Earth (that job stays with the AI's third-party identity-resolution
// step). Keyed on the registrable domain, so subdomains (e.g.
// "jobs.lever.co") are caught the same way.
const KNOWN_NON_CORPORATE_DOMAINS = new Set([
  // Social / video platforms
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  // Generic job boards / ATS platforms whose URLs host many different
  // companies' listings under one shared domain -- a listing there is
  // evidence about the company named in the listing, never about the ATS
  // vendor itself.
  "indeed.com",
  "glassdoor.com",
  "greenhouse.io",
  "lever.co",
]);

export function isKnownNonCorporateDomain(registrableDomain: string | null | undefined): boolean {
  if (!registrableDomain) return false;
  return KNOWN_NON_CORPORATE_DOMAINS.has(registrableDomain);
}
