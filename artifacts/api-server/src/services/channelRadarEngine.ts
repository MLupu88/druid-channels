import { db } from "@workspace/db";
import {
  channelRadarConfigsTable,
  channelRadarSignalsTable,
  channelRadarSignalEvidenceTable,
  territoriesTable,
  RADAR_SIGNAL_TYPES,
  type ChannelRadarConfig,
  type Territory,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as searchProvider from "./discoveryProviders/search";
import * as radarAiProvider from "./channelRadarProviders/ai";
import { resolveCompanyMatchForEntityName } from "./radarCompanyBridge";
import { normalizeCompanyName } from "./companyMatchingService";
import { listTrustedDruidFacts, formatTrustedDruidContext } from "./druidFacts";
import { logger } from "../lib/logger";

// Stage 5 Channel Radar engine. Deliberately no demo/fallback data path --
// unlike Discovery (which has an explicit demo-candidate generator for a
// disconnected environment), Radar has none: if the providers aren't
// configured, the run is honestly refused rather than fabricating signals.

const SIGNAL_TYPE_SEARCH_TERMS: Record<string, string> = {
  acquisition: "acquisition OR acquires",
  partnership: "partnership OR strategic alliance",
  reseller_distributor: "reseller OR distributor OR systems integrator",
  regional_expansion: "regional expansion OR new office OR market entry",
  leadership_hire: "channel hire OR alliance hire OR new VP",
  funding: "funding round OR raises",
  customer_win: "customer win OR case study",
  product_gtm: "product launch OR go-to-market",
  marketplace_listing: "marketplace listing OR app store",
  event: "conference OR webinar OR keynote",
  other: "news",
};

// Phase 11.6.1 Radar recency fix (corrected classification pass):
// classification of the existing query families above into NEWS-LIKE (an
// announced, dated ecosystem move -- "this happened on/around a specific
// day, and being recent is the whole point of surfacing it") vs NON-NEWS/
// WEB SIGNAL (a genuinely ongoing-state/directory page with no meaningful
// "publish date"). No new signal-type category is invented here -- this
// only labels the families that already exist in SIGNAL_TYPE_SEARCH_TERMS
// above, re-audited per family against its actual query text and product
// semantics (not "could an evergreen page exist for this," which is true
// of almost any query and is not the test):
//
//   NEWS-LIKE: acquisition, partnership, reseller_distributor,
//   regional_expansion, leadership_hire, funding, customer_win,
//   product_gtm, event, other ("news" itself).
//     - acquisition / partnership / regional_expansion / leadership_hire /
//       funding / product_gtm: unambiguous dated announcements.
//     - reseller_distributor ("reseller OR distributor OR systems
//       integrator"): a NEW reseller/distributor/SI relationship is itself
//       a dated ecosystem move (e.g. "X named as distributor of Y") --
//       reclassified from the prior pass, which wrongly treated the whole
//       family as evergreen just because a static partner-directory page
//       could also exist for the same terms.
//     - customer_win ("customer win OR case study"): a customer-win
//       announcement is a dated event; reclassified from the prior pass
//       for the same reason -- "case study" is one possible result shape,
//       not proof the family is evergreen.
//     - event ("conference OR webinar OR keynote"): the query text targets
//       mentions of an entity's participation in a conference/webinar/
//       keynote, not an evergreen events-calendar/listing page (no
//       "schedule"/"calendar"/"upcoming events" wording) -- that is a
//       dated-occurrence signal, so this stays NEWS-LIKE.
//
//   NON-NEWS/WEB SIGNAL: marketplace_listing ("marketplace listing OR app
//   store") -- this is the one family whose query text is itself
//   structurally directorial (a listing/catalog entry), not an
//   announcement; genuinely has no reliable publish date and is not a news
//   article reporting a dated event. Its evidence still flows through
//   unchanged (never a fabricated date, see the hard rejection below,
//   which applies ONLY to topic "news").
const NEWS_LIKE_SIGNAL_TYPES = new Set<string>([
  "acquisition",
  "partnership",
  "reseller_distributor",
  "regional_expansion",
  "leadership_hire",
  "funding",
  "customer_win",
  "product_gtm",
  "event",
  "other",
]);

export function topicForSignalType(signalType: string): "general" | "news" {
  return NEWS_LIKE_SIGNAL_TYPES.has(signalType) ? "news" : "general";
}

const MAX_RADAR_QUERIES = 12;
const MAX_RESULTS_PER_QUERY = 3;

export interface RadarQuery {
  query: string;
  entityHint: string;
  // Phase 11.6.1: which Tavily search mode this query runs under -- "news"
  // only for NEWS-LIKE signal-type families (see NEWS_LIKE_SIGNAL_TYPES
  // above); "general" for every non-news family, preserving today's
  // existing search behavior for those unchanged. Radar is never
  // globally switched to news mode -- this is decided per query.
  topic: "general" | "news";
}

// Stage 6.3: the small deterministic geo-term helper the query builder
// appends to every query so a Romania scan is materially scoped to
// Romania, not just labeled that way after the fact. Prefers the
// territory's own canonical countries (e.g. DACH -> "Germany OR Austria OR
// Switzerland"); falls back to the territory name only when no countries
// are configured. Deliberately does not try to expand a country into a
// long list of regions/cities -- readable and bounded, not "blindly
// appending a giant country list."
export function buildGeoTerm(countries: string[], territoryName: string): string {
  const trimmed = countries.map((c) => c.trim()).filter(Boolean);
  if (trimmed.length === 0) return territoryName;
  if (trimmed.length === 1) return trimmed[0]!;
  return trimmed.join(" OR ");
}

// Bounded round-robin, never a full entities x signal-types Cartesian
// product: round 0 gives every entity its first (rotating) signal-type
// phrase, round 1 gives every entity its second, etc. -- every monitored
// entity is represented starting at query #1, capped at
// MAX_RADAR_QUERIES, never padded when the config is narrow. Every query
// also carries the territory's geo term (see buildGeoTerm) -- Radar's
// actual search request is geographically scoped, not just the signal
// that later gets attributed to a territory after the fact.
export function buildRadarQueries(entities: string[], signalTypes: string[], geoTerm: string): RadarQuery[] {
  const queries: RadarQuery[] = [];
  const seenQueryText = new Set<string>();
  const push = (query: string, entityHint: string, topic: "general" | "news") => {
    const trimmed = query.trim();
    if (trimmed && !seenQueryText.has(trimmed) && queries.length < MAX_RADAR_QUERIES) {
      seenQueryText.add(trimmed);
      queries.push({ query: trimmed, entityHint, topic });
    }
  };

  if (entities.length === 0) return [];

  // Carries each term's originating signalType alongside the search phrase
  // so the round-robin loop below can decide topic per query -- the query
  // string itself was already round-robin-blind to signal type; this only
  // adds the classification needed to choose "general" vs "news".
  const termEntries = signalTypes
    .map((s) => (SIGNAL_TYPE_SEARCH_TERMS[s] ? { signalType: s, term: SIGNAL_TYPE_SEARCH_TERMS[s]! } : null))
    .filter((t): t is { signalType: string; term: string } => t !== null);
  if (termEntries.length === 0) {
    // Fallback ("news" the literal search term) is itself a NEWS-LIKE
    // family (mirrors signal_type "other" above) -- topic "news" here too.
    for (const entity of entities) push(`"${entity}" news ${geoTerm}`, entity, "news");
    return queries;
  }

  for (let round = 0; round < termEntries.length && queries.length < MAX_RADAR_QUERIES; round++) {
    for (let i = 0; i < entities.length && queries.length < MAX_RADAR_QUERIES; i++) {
      const entry = termEntries[(i + round) % termEntries.length]!;
      push(`"${entities[i]}" ${entry.term} ${geoTerm}`, entities[i], topicForSignalType(entry.signalType));
    }
  }

  return queries;
}

// Stage 6.3: derives a real Tavily `start_date` (YYYY-MM-DD) from
// lookback_days -- a real, provider-enforced recency constraint at the
// request level, not text stuffed into the query string. Tavily's own docs
// describe start_date/end_date as filtering "based on publish date or last
// updated date," an ambiguity this codebase cannot resolve from its side --
// which is exactly why this alone is not sufficient for NEWS-LIKE queries.
// Phase 11.6.1 adds a second, client-side check: Tavily's documented
// `published_date` field (topic="news" results -- see
// discoveryProviders/search.ts) is verified per result and a stale/
// unverifiable one is rejected before persistence (see
// evaluateNewsRecency below).
export function computeLookbackStartDate(lookbackDays: number, now: Date = new Date()): string {
  const boundedDays = Math.max(1, Math.floor(lookbackDays));
  const start = new Date(now.getTime() - boundedDays * 86_400_000);
  return start.toISOString().slice(0, 10);
}

// Phase 11.6.1 Radar recency fix: the hard NEWS-LIKE recency rule, pure and
// DB-free so it's directly unit-testable (same convention as
// computeDedupeKey/isValidStatusTransition/computeRequiresValidation
// above). publishedAt/cutoffStartDate are both YYYY-MM-DD, so a plain
// string comparison is a correct chronological comparison.
//   - publishedAt >= cutoff -> admit.
//   - publishedAt < cutoff -> reject as "stale" (the exact production bug:
//     an old article that slipped past the request-level start_date
//     filter, now caught client-side before it's ever interpreted or
//     persisted).
//   - publishedAt == null -> reject as "publication-date-unverified". Never
//     treated as recent -- an unknown date is not evidence of recency.
// Only ever called for topic:"news" results -- never applied to non-news
// evidence, which is handled on its own honest terms (see runRadarForConfig
// below and NEWS_LIKE_SIGNAL_TYPES above).
export type NewsRecencyDecision = { admit: true } | { admit: false; reason: "stale" | "publication-date-unverified" };

export function evaluateNewsRecency(publishedAt: string | null, cutoffStartDate: string): NewsRecencyDecision {
  if (!publishedAt) return { admit: false, reason: "publication-date-unverified" };
  if (publishedAt < cutoffStartDate) return { admit: false, reason: "stale" };
  return { admit: true };
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Deterministic, event-based, never a timestamp: normalized entity name +
// signal type + normalized primary source URL. A repeated "Run Radar"
// recomputes the same key for the same underlying event and collapses
// harmlessly via ON CONFLICT DO NOTHING (see runRadarForConfig below).
export function computeDedupeKey(entityName: string, signalType: string, primarySourceUrl: string): string {
  const normalizedEntity = entityName.trim().toLowerCase();
  const normalizedUrl = normalizeUrl(primarySourceUrl);
  return createHash("sha256").update(`${normalizedEntity}|${signalType}|${normalizedUrl}`).digest("hex");
}

// Simple, deliberately narrow: new -> reviewed; new/reviewed -> dismissed.
// dismissed is terminal. Not a generic state machine.
export function isValidStatusTransition(from: string, to: string): boolean {
  if (from === to) return false;
  if (from === "new") return to === "reviewed" || to === "dismissed";
  if (from === "reviewed") return to === "dismissed";
  return false;
}

// ---- Phase 10: cross-run event consolidation -------------------------------
//
// dedupeKey (above) is the exact-URL floor: a repeated URL for the same
// entity+signal_type collapses onto the same row. It does NOT solve a
// different source reporting the SAME event under a DIFFERENT URL days
// later -- that's what the candidate search + bounded same-event AI check
// below solve. See channelRadarProviders/ai.ts's classifySameEvent for the
// AI half of this (a narrow binary decision made only over what this
// deterministic search returns).

// Fixed, documented constant -- not a per-territory config knob, matching
// this file's existing convention (MAX_RADAR_QUERIES, MAX_RESULTS_PER_QUERY)
// of small fixed constants over configurable ones for internal engine
// behavior. Generous enough to catch slow follow-on trade-press coverage of
// the same announcement; bounded enough to not merge across unrelated
// quarters.
export const EVENT_MATCH_WINDOW_DAYS = 60;
export const MAX_EVENT_CANDIDATES = 3;

export interface EventCandidate {
  id: string;
  headline: string;
  summary: string;
  sourceTitle: string;
  sourceUrl: string;
}

interface EventCandidateRow {
  id: string;
  entityName: string;
  companyId: string | null;
  headline: string;
  summary: string;
  sourceTitle: string;
  sourceUrl: string;
  discoveredAt: Date;
  lastEvidenceAt: Date | null;
}

// Pure, DB-free -- takes an already-fetched row set so the matching/ranking
// logic can be unit tested without a database. See findEventCandidates below
// for the DB-backed wrapper actually used by runRadarForConfig.
//
// Deliberately does NOT exclude status='dismissed' signals: a dismissed
// signal is a real, human-reviewed event on record, not noise to forget --
// a corroborating source found later must still be able to attach to it
// (see the correction in the Phase 10 plan). The window anchors on
// lastEvidenceAt (falling back to discoveredAt for rows that never had
// evidence attached, including every pre-Phase-10 row) rather than
// source_published_at, which Tavily frequently leaves null -- the window
// must anchor on what this pipeline reliably knows.
export function selectEventCandidates(
  rows: EventCandidateRow[],
  input: { entityName: string; companyId: string | null; asOf: Date },
): EventCandidate[] {
  const normalizedEntity = normalizeCompanyName(input.entityName);
  const windowStart = input.asOf.getTime() - EVENT_MATCH_WINDOW_DAYS * 86_400_000;

  const matches = rows.filter((r) => {
    const sameEntity =
      input.companyId && r.companyId ? r.companyId === input.companyId : normalizeCompanyName(r.entityName) === normalizedEntity;
    if (!sameEntity) return false;
    const anchorMs = (r.lastEvidenceAt ?? r.discoveredAt).getTime();
    return anchorMs >= windowStart && anchorMs <= input.asOf.getTime();
  });

  matches.sort((a, b) => {
    const aMs = (a.lastEvidenceAt ?? a.discoveredAt).getTime();
    const bMs = (b.lastEvidenceAt ?? b.discoveredAt).getTime();
    return bMs - aMs; // most-recent-first
  });

  return matches.slice(0, MAX_EVENT_CANDIDATES).map((r) => ({
    id: r.id,
    headline: r.headline,
    summary: r.summary,
    sourceTitle: r.sourceTitle,
    sourceUrl: r.sourceUrl,
  }));
}

// DB-backed wrapper: scoped to the same territory + same signal_type
// (deterministic, cheap filters pushed into SQL), then the entity match +
// time window + ranking + cap happen in selectEventCandidates above.
async function findEventCandidates(
  territoryId: string,
  signalType: (typeof RADAR_SIGNAL_TYPES)[number],
  entityName: string,
  companyId: string | null,
  asOf: Date,
): Promise<EventCandidate[]> {
  const rows = await db
    .select({
      id: channelRadarSignalsTable.id,
      entityName: channelRadarSignalsTable.entityName,
      companyId: channelRadarSignalsTable.companyId,
      headline: channelRadarSignalsTable.headline,
      summary: channelRadarSignalsTable.summary,
      sourceTitle: channelRadarSignalsTable.sourceTitle,
      sourceUrl: channelRadarSignalsTable.sourceUrl,
      discoveredAt: channelRadarSignalsTable.discoveredAt,
      lastEvidenceAt: channelRadarSignalsTable.lastEvidenceAt,
    })
    .from(channelRadarSignalsTable)
    .where(and(eq(channelRadarSignalsTable.territoryId, territoryId), eq(channelRadarSignalsTable.signalType, signalType)));

  return selectEventCandidates(rows, { entityName, companyId, asOf });
}

// Iterates candidates most-recent-first (the order selectEventCandidates
// already returns them in), calling `classify` -- a thin wrapper the caller
// supplies around radarAiProvider.classifySameEvent -- for each one, and
// stops at the first confirmed match. Exported and injected-callback-based
// specifically so this policy is unit-testable with a mocked classify
// function, no DB or network required:
//   - ANY error thrown by classify (provider down, malformed response,
//     anything) is caught HERE and treated as "different event" for that
//     candidate -- it never propagates and never fails the caller's scan.
//   - A false/uncertain decision moves on to the next candidate; running out
//     of candidates returns null (create a new signal).
//   - The first candidate classify confirms true wins immediately -- later
//     candidates are never even asked.
export async function resolveEventAttachment(
  candidates: EventCandidate[],
  classify: (candidate: EventCandidate) => Promise<radarAiProvider.SameEventOutput>,
): Promise<string | null> {
  for (const candidate of candidates) {
    let sameEvent = false;
    try {
      sameEvent = (await classify(candidate)).sameEvent;
    } catch (err) {
      logger.warn(
        { candidateSignalId: candidate.id, errorName: err instanceof Error ? err.name : typeof err },
        "Channel Radar: same-event classification failed for a candidate; treated as a different event",
      );
      sameEvent = false; // never merge on AI error/uncertainty
    }
    if (sameEvent) return candidate.id;
  }
  return null;
}

// ---- Phase 10 fix: territory-scoped exact-URL floor -----------------------
//
// The floor checks in runRadarForConfig below query BROADLY (any territory
// sharing this dedupeKey / this normalized evidence URL, via a query pushed
// only as far as "same key" -- see below) and then decide NARROWLY, here,
// whether one of those rows actually belongs to the territory this run is
// scoped to. A same-dedupeKey or same-URL row that belongs to a DIFFERENT
// territory must never suppress this territory's own signal -- the same
// entity+signal_type+URL is a legitimate, independently-owned event in each
// territory that happens to observe it (e.g. a global vendor's announcement
// picked up by two territories' scans). Pure and DB-free specifically so
// this decision is unit-testable without a database -- mirrors
// selectEventCandidates' fetch-broadly/decide-narrowly shape above.
export function isClaimedInTerritory(rows: Array<{ territoryId: string }>, territoryId: string): boolean {
  return rows.some((r) => r.territoryId === territoryId);
}

// ---- Phase 10: small pure route helpers (kept here, not in routes/, so
// they're unit-testable without importing Express/session/db-connection
// machinery -- same convention as every other pure function in this file) --

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export function boundListPagination(limit: number | null | undefined, offset: number | null | undefined): { limit: number; offset: number } {
  const boundedLimit = Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
  const boundedOffset = Math.max(0, offset ?? 0);
  return { limit: boundedLimit, offset: boundedOffset };
}

// Query params arrive as strings (or null/undefined when omitted) --
// "true"/"false" are the only two values that mean anything; anything else
// (including an omitted param) means "don't filter on this at all", not
// "false".
export function coerceBooleanFilter(value: string | null | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// Phase 10 fix: the ONE filter-application function both GET /channel-radar
// (list) and GET /channel-radar/summary call, so their notion of "the
// currently active filters" can never silently drift apart. `territory`
// scoping stays a separate, prior step in both routes (it decides which
// rows are even fetched under PAM's own-territory constraint, via
// scopedTerritoryId -- see services/authz.ts), passed in here already
// resolved; every other filter is applied identically for both endpoints.
export interface ChannelRadarActiveFilters {
  scopedTerritoryId: string | null;
  territory?: string | null;
  signalType?: string | null;
  entityType?: string | null;
  implication?: string | null;
  impact?: string | null;
  status?: string | null;
  requiresValidation?: boolean;
  search?: string | null;
}

interface FilterableSignalRow {
  signal: {
    territoryId: string;
    signalType: string;
    entityType: string;
    implication: string;
    impact: string;
    status: string;
    requiresValidation: boolean;
    entityName: string;
    headline: string;
  };
  territory: { name: string } | null;
}

export function applyChannelRadarFilters<T extends FilterableSignalRow>(rows: T[], filters: ChannelRadarActiveFilters): T[] {
  let filtered = rows;
  if (filters.scopedTerritoryId) {
    filtered = filtered.filter((r) => r.signal.territoryId === filters.scopedTerritoryId);
  } else if (filters.territory) {
    filtered = filtered.filter((r) => r.territory?.name === filters.territory || r.signal.territoryId === filters.territory);
  }
  if (filters.signalType) filtered = filtered.filter((r) => r.signal.signalType === filters.signalType);
  if (filters.entityType) filtered = filtered.filter((r) => r.signal.entityType === filters.entityType);
  if (filters.implication) filtered = filtered.filter((r) => r.signal.implication === filters.implication);
  if (filters.impact) filtered = filtered.filter((r) => r.signal.impact === filters.impact);
  if (filters.status) filtered = filtered.filter((r) => r.signal.status === filters.status);
  if (filters.requiresValidation !== undefined) {
    filtered = filtered.filter((r) => r.signal.requiresValidation === filters.requiresValidation);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter((r) => r.signal.entityName.toLowerCase().includes(q) || r.signal.headline.toLowerCase().includes(q));
  }
  return filtered;
}

// ---- Phase 10 fix: legacy evidence compatibility ---------------------------
//
// Pre-Phase-10 signals were created before channel_radar_signal_evidence
// existed and were never backfilled into it (backfilling would mean
// mutating historical rows just because they were read -- deliberately not
// done). Such a signal must never *look* like it has zero evidence when it
// plainly has one: its own source_title/source_url/source_domain/
// source_published_at. This synthesizes exactly one read-only, never-
// persisted primary evidence item from those fields when the evidence
// table has nothing for this signal yet.

export interface ChannelRadarEvidenceItem {
  id: string;
  source_title: string;
  source_url: string;
  source_domain: string | null;
  source_published_at: string | null;
  discovered_at: string;
  is_primary: boolean;
}

export interface EvidenceRowLike {
  id: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDomain: string | null;
  sourcePublishedAt: string | null;
  discoveredAt: Date;
  isPrimary: boolean;
}

export interface LegacySignalSourceFields {
  id: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDomain: string | null;
  sourcePublishedAt: string | null;
  discoveredAt: Date;
}

// evidence rows exist -> use them (mapped, unchanged).
// no evidence rows + a real legacy source_url -> synthesize one primary item.
// no evidence rows + no source_url -> [] (never fabricates a source).
export function resolveSignalEvidence(evidenceRows: EvidenceRowLike[], signal: LegacySignalSourceFields): ChannelRadarEvidenceItem[] {
  if (evidenceRows.length > 0) {
    return evidenceRows.map((e) => ({
      id: e.id,
      source_title: e.sourceTitle,
      source_url: e.sourceUrl,
      source_domain: e.sourceDomain,
      source_published_at: e.sourcePublishedAt,
      discovered_at: e.discoveredAt.toISOString(),
      is_primary: e.isPrimary,
    }));
  }
  if (!signal.sourceUrl) return [];
  return [
    {
      // Deterministic, stable, and deliberately never a real evidence-table
      // uuid -- a synthesized item is not a persisted row and must never be
      // mistaken for one (e.g. by a client trying to key/cache it).
      id: `legacy-${signal.id}`,
      source_title: signal.sourceTitle,
      source_url: signal.sourceUrl,
      source_domain: signal.sourceDomain,
      source_published_at: signal.sourcePublishedAt,
      discovered_at: signal.discoveredAt.toISOString(),
      is_primary: true,
    },
  ];
}

// Same compatibility rule applied to the cheap bulk-count path the LIST
// endpoint uses (it already has signal.sourceUrl on hand from its own
// select, so this never needs a second query) -- keeps evidence_count
// consistent between the list and detail responses for the same signal.
export function resolveEvidenceCount(rawEvidenceRowCount: number, hasLegacySource: boolean): number {
  return rawEvidenceRowCount > 0 ? rawEvidenceRowCount : hasLegacySource ? 1 : 0;
}

// Three independent, OR'd factors -- deliberately never simply
// confidence=='low' (confidence and validation stay conceptually separate).
// A high-confidence signal can still require validation via an ambiguous
// identity or uncertain regional applicability; a low-confidence signal is
// one path among three, not the definition. Zero company matches (a
// genuinely unlisted entity) is never ambiguity on its own -- only more than
// one match is.
export function computeRequiresValidation(input: {
  ambiguousPrimaryIdentity: boolean;
  ambiguousRelatedIdentity: boolean;
  regionalApplicabilityCertain: boolean;
  confidence: "high" | "medium" | "low";
}): boolean {
  return (
    input.ambiguousPrimaryIdentity ||
    input.ambiguousRelatedIdentity ||
    !input.regionalApplicabilityCertain ||
    input.confidence === "low"
  );
}

export class ChannelRadarNotConfiguredError extends Error {}
export class ChannelRadarRunFailedError extends Error {}

function classifyRadarError(err: unknown): string {
  if (err instanceof searchProvider.SearchNotImplementedError) return "Search provider not connected.";
  if (err instanceof radarAiProvider.RadarAiNotImplementedError) return "AI qualification provider not connected.";
  if (err instanceof searchProvider.SearchProviderError) return "Web search provider call failed. Please try again.";
  if (err instanceof radarAiProvider.RadarAiProviderError) return "AI qualification call failed. Please try again.";
  return "Channel Radar scan could not be completed. Please try again or contact an administrator.";
}

export interface ChannelRadarRunOutcome {
  resultsFound: number;
  resultsQualified: number;
}

export async function runRadarForConfig(configId: string): Promise<ChannelRadarRunOutcome> {
  const [config] = await db.select().from(channelRadarConfigsTable).where(eq(channelRadarConfigsTable.id, configId));
  if (!config) throw new Error("Channel Radar config not found");
  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, config.territoryId));
  if (!territory) throw new Error("Territory not found for Channel Radar config");

  const [searchReady, aiReady] = await Promise.all([searchProvider.isConfigured(), radarAiProvider.isConfigured()]);
  if (!searchReady || !aiReady) {
    throw new ChannelRadarNotConfiguredError("Channel Radar requires both the Search and AI providers to be connected.");
  }

  const entities = (config.monitoredEntities as string[]) ?? [];
  const signalTypes = (config.enabledSignalTypes as string[]) ?? [];
  const geoTerm = buildGeoTerm((territory.countries as string[]) ?? [], territory.name);
  const queries = buildRadarQueries(entities, signalTypes, geoTerm);
  const startDate = computeLookbackStartDate(config.lookbackDays);

  // Phase 11.5C.3: trusted DRUID context, loaded and formatted once per run
  // (same tier as queries/startDate above) and passed to every qualifySignal
  // call below -- never classifySameEvent, and never a per-result DB query.
  // Optional grounding, not a correctness gate: a load failure must never
  // abort the run, so it degrades to "" (identical to the zero-trusted-facts
  // case) and is only logged -- never invents DRUID knowledge on failure.
  let druidContext = "";
  try {
    druidContext = formatTrustedDruidContext(await listTrustedDruidFacts());
  } catch (err) {
    logger.warn(
      { channelRadarConfigId: config.id, errorName: err instanceof Error ? err.name : typeof err },
      "Channel Radar: failed to load trusted DRUID context for this run; continuing without DRUID grounding",
    );
  }

  let resultsFound = 0;
  let resultsQualified = 0;
  // Phase 11.6.1: structured, in-memory-only observability for the hard
  // news-recency rule -- never persisted (no schema change), logged once as
  // a run summary below. Lets a stale-news regression (or an unexpected
  // rise in "publication-date-unverified" rejections -- Tavily's
  // published_date is documented but optional/best-effort, so some
  // fraction of genuine news results legitimately omitting it is expected;
  // see WebSearchResult.publishedAt) be diagnosed from logs alone.
  let newsResultsAccepted = 0;
  let newsResultsRejectedStale = 0;
  let newsResultsRejectedUnverifiedDate = 0;
  let nonNewsResultsProcessed = 0;

  try {
    const seenUrls = new Set<string>();
    for (const { query, entityHint, topic } of queries) {
      const results = await searchProvider.search(query, { maxResults: MAX_RESULTS_PER_QUERY, startDate, topic });
      for (const result of results) {
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        resultsFound++;

        // Hard recency rule (NEWS-LIKE queries only, never applied to
        // non-news evidence) -- reject before this result is ever
        // interpreted or persisted. See evaluateNewsRecency above.
        if (topic === "news") {
          const decision = evaluateNewsRecency(result.publishedAt, startDate);
          if (!decision.admit) {
            if (decision.reason === "publication-date-unverified") newsResultsRejectedUnverifiedDate++;
            else newsResultsRejectedStale++;
            logger.info(
              { configId, url: result.url, entityHint, publishedAt: result.publishedAt, cutoff: startDate, reason: decision.reason },
              decision.reason === "publication-date-unverified"
                ? "Channel Radar: publication-date-unverified -- news-topic result has no verifiable publish date and was rejected rather than assumed recent"
                : "Channel Radar: news-topic result is older than the configured lookback window and was rejected",
            );
            continue;
          }
          newsResultsAccepted++;
        } else {
          nonNewsResultsProcessed++;
        }

        const qualification = await radarAiProvider.qualifySignal({
          entityHint,
          territoryName: territory.name,
          evidence: [{ url: result.url, title: result.title, text: result.snippet }],
          druidContext,
        });

        if (!qualification.keep) continue;

        const primaryUrl = qualification.evidenceUrls[0] ?? result.url;
        const normalizedPrimaryUrl = normalizeUrl(primaryUrl);
        const dedupeKey = computeDedupeKey(qualification.entityName, qualification.signalType, primaryUrl);

        // Floor check (cheap, deterministic, no AI): this exact URL was
        // already fully processed before *within this territory*, either as
        // a primary signal (dedupeKey) or as evidence attached to one on an
        // earlier run (normalizedPrimaryUrl in the evidence table). A
        // repeated "Run Radar" over the same underlying result, in the SAME
        // territory, is a true no-op here -- no candidate search, no AI
        // call. Phase 10 fix: both queries below fetch by key alone (any
        // territory), then isClaimedInTerritory decides narrowly whether
        // one of those rows is actually THIS territory's -- a same-key row
        // owned by a different territory must never suppress this one (see
        // isClaimedInTerritory's comment above).
        const dedupeKeyRows = await db
          .select({ territoryId: channelRadarSignalsTable.territoryId })
          .from(channelRadarSignalsTable)
          .where(eq(channelRadarSignalsTable.dedupeKey, dedupeKey));
        const evidenceUrlRows = await db
          .select({ territoryId: channelRadarSignalsTable.territoryId })
          .from(channelRadarSignalEvidenceTable)
          .innerJoin(channelRadarSignalsTable, eq(channelRadarSignalEvidenceTable.signalId, channelRadarSignalsTable.id))
          .where(eq(channelRadarSignalEvidenceTable.normalizedUrl, normalizedPrimaryUrl));
        if (isClaimedInTerritory(dedupeKeyRows, territory.id) || isClaimedInTerritory(evidenceUrlRows, territory.id)) continue;

        // Stage 6 / Phase 10: deterministic, exact-name-only bridge to the
        // canonical companies table -- see radarCompanyBridge.ts. Stays null
        // on any ambiguity; never an LLM call, never fuzzy. Resolved for
        // both the primary entity and (Phase 10) its counterparty, when the
        // qualification named one -- `ambiguous` (>1 match, never a
        // zero-match "genuinely unlisted entity") feeds requiresValidation
        // below, never company_id's own null-on-ambiguity-or-absence
        // contract.
        const primaryMatch = await resolveCompanyMatchForEntityName(qualification.entityName);
        const relatedMatch = qualification.relatedEntityName
          ? await resolveCompanyMatchForEntityName(qualification.relatedEntityName)
          : { companyId: null, ambiguous: false };

        const requiresValidation = computeRequiresValidation({
          ambiguousPrimaryIdentity: primaryMatch.ambiguous,
          ambiguousRelatedIdentity: relatedMatch.ambiguous,
          regionalApplicabilityCertain: qualification.regionalApplicabilityCertain,
          confidence: qualification.confidence,
        });

        // Phase 10 cross-run consolidation: a bounded, deterministic
        // candidate search (same territory + same entity + same
        // signal_type + 60-day window, dismissed included, capped at 3),
        // then -- only over those pre-vetted candidates -- one narrow AI
        // same-event/different-event call per candidate, most-recent-first,
        // stopping at the first confirmed match (see resolveEventAttachment
        // below for the never-merge-on-error/doubt policy).
        const candidates = await findEventCandidates(
          territory.id,
          qualification.signalType,
          qualification.entityName,
          primaryMatch.companyId,
          new Date(),
        );

        const attachToSignalId = await resolveEventAttachment(candidates, (candidate) =>
          radarAiProvider.classifySameEvent({
            entityHint: qualification.entityName,
            candidate: {
              headline: candidate.headline,
              summary: candidate.summary,
              sourceTitle: candidate.sourceTitle,
              sourceUrl: candidate.sourceUrl,
            },
            newEvidence: { url: primaryUrl, title: result.title, text: result.snippet },
          }),
        );

        if (attachToSignalId) {
          // Attach: new evidence row only. Never rewrite headline/summary/
          // why_it_matters/implication/impact/confidence/recommended_action/
          // status/requires_validation on the existing signal -- a human may
          // already have reviewed or dismissed it, and this must not
          // silently reopen or reclassify it. Bump last_evidence_at only.
          const [insertedEvidence] = await db
            .insert(channelRadarSignalEvidenceTable)
            .values({
              signalId: attachToSignalId,
              sourceTitle: result.title,
              sourceUrl: primaryUrl,
              normalizedUrl: normalizedPrimaryUrl,
              sourceDomain: extractDomain(primaryUrl),
              sourcePublishedAt: result.publishedAt,
              isPrimary: false,
            })
            .onConflictDoNothing({ target: [channelRadarSignalEvidenceTable.signalId, channelRadarSignalEvidenceTable.normalizedUrl] })
            .returning();

          if (insertedEvidence) {
            await db
              .update(channelRadarSignalsTable)
              .set({ lastEvidenceAt: new Date() })
              .where(eq(channelRadarSignalsTable.id, attachToSignalId));
            resultsQualified++;
          }
          continue;
        }

        // Phase 10 fix: signal + primary evidence are created atomically --
        // either both persist or neither does. Previously these were two
        // independent statements; a failure on the evidence insert could
        // leave a signal row with no evidence at all (the exact defect
        // legacy rows already have -- see resolveSignalEvidence -- but
        // freshly self-inflicted on every new signal instead of inherited
        // from before this table existed). onConflictDoNothing's target is
        // the new territory-scoped composite unique (territory_id,
        // dedupe_key) -- matches the migration in
        // lib/db/schema/channel_radar_signals.ts; a same-dedupeKey row in a
        // different territory is no longer a conflict at all.
        const now = new Date();
        const created = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(channelRadarSignalsTable)
            .values({
              territoryId: territory.id,
              assignedUserId: territory.ownerUserId,
              companyId: primaryMatch.companyId,
              entityName: qualification.entityName,
              entityType: qualification.entityType,
              signalType: qualification.signalType,
              headline: qualification.headline,
              summary: qualification.summary,
              whyItMatters: qualification.whyItMatters,
              implication: qualification.implication,
              impact: qualification.impact,
              recommendedAction: qualification.recommendedAction,
              druidPartnerMotion: qualification.druidPartnerMotion,
              confidence: qualification.confidence,
              sourceTitle: result.title,
              sourceUrl: primaryUrl,
              sourceDomain: extractDomain(primaryUrl),
              sourcePublishedAt: result.publishedAt, // honest: null when the provider gave no date
              dedupeKey,
              requiresValidation,
              regionalApplicabilityCertain: qualification.regionalApplicabilityCertain,
              relatedEntityName: qualification.relatedEntityName,
              relatedEntityType: qualification.relatedEntityType,
              relatedEntityCompanyId: relatedMatch.companyId,
              relationshipLabel: qualification.relationshipLabel,
              discoveredAt: now,
              // Initialized from this signal's own creation/discovery moment
              // so candidate-window logic (findEventCandidates above) can
              // consistently use lastEvidenceAt going forward; pre-Phase-10
              // rows fall back to discoveredAt (see selectEventCandidates).
              lastEvidenceAt: now,
            })
            .onConflictDoNothing({ target: [channelRadarSignalsTable.territoryId, channelRadarSignalsTable.dedupeKey] })
            .returning();

          if (!inserted) return null; // idempotent no-op: exact repeat within this territory

          // Mirror the primary evidence into the evidence table at creation
          // time -- the evidence table is then the single source of truth
          // for "which URLs have been recorded against this event." Same
          // transaction as the signal insert above: if this throws, the
          // signal insert rolls back with it.
          await tx.insert(channelRadarSignalEvidenceTable).values({
            signalId: inserted.id,
            sourceTitle: result.title,
            sourceUrl: primaryUrl,
            normalizedUrl: normalizedPrimaryUrl,
            sourceDomain: extractDomain(primaryUrl),
            sourcePublishedAt: result.publishedAt,
            isPrimary: true,
          });

          return inserted;
        });

        if (created) resultsQualified++;
      }
    }
  } catch (err) {
    const safeMessage = classifyRadarError(err);
    logger.error(
      { configId, errorName: err instanceof Error ? err.name : typeof err, safeMessage },
      "Channel Radar scan failed",
    );
    throw new ChannelRadarRunFailedError(safeMessage);
  }

  logger.info(
    {
      configId,
      resultsFound,
      resultsQualified,
      newsResultsAccepted,
      newsResultsRejectedStale,
      newsResultsRejectedUnverifiedDate,
      nonNewsResultsProcessed,
    },
    "Channel Radar: run recency enforcement summary",
  );

  return { resultsFound, resultsQualified };
}
