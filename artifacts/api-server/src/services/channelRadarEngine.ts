import { db } from "@workspace/db";
import { channelRadarConfigsTable, channelRadarSignalsTable, territoriesTable, type ChannelRadarConfig, type Territory } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as searchProvider from "./discoveryProviders/search";
import * as radarAiProvider from "./channelRadarProviders/ai";
import { resolveSafeCompanyIdForEntityName } from "./radarCompanyBridge";
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

const MAX_RADAR_QUERIES = 12;
const MAX_RESULTS_PER_QUERY = 3;

export interface RadarQuery {
  query: string;
  entityHint: string;
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
  const push = (query: string, entityHint: string) => {
    const trimmed = query.trim();
    if (trimmed && !seenQueryText.has(trimmed) && queries.length < MAX_RADAR_QUERIES) {
      seenQueryText.add(trimmed);
      queries.push({ query: trimmed, entityHint });
    }
  };

  if (entities.length === 0) return [];

  const terms = signalTypes.map((s) => SIGNAL_TYPE_SEARCH_TERMS[s]).filter((t): t is string => !!t);
  if (terms.length === 0) {
    for (const entity of entities) push(`"${entity}" news ${geoTerm}`, entity);
    return queries;
  }

  for (let round = 0; round < terms.length && queries.length < MAX_RADAR_QUERIES; round++) {
    for (let i = 0; i < entities.length && queries.length < MAX_RADAR_QUERIES; i++) {
      const term = terms[(i + round) % terms.length];
      push(`"${entities[i]}" ${term} ${geoTerm}`, entities[i]);
    }
  }

  return queries;
}

// Stage 6.3: derives a real Tavily `start_date` (YYYY-MM-DD) from
// lookback_days -- the only formally-documented hard recency constraint
// Tavily's /search endpoint supports (confirmed against Tavily's own API
// reference; there is no per-result publish-date field in the response, so
// individual results can never be verified/rejected client-side -- see
// discoveryProviders/search.ts). This is real enforcement at the request
// level, not text stuffed into the query string.
export function computeLookbackStartDate(lookbackDays: number, now: Date = new Date()): string {
  const boundedDays = Math.max(1, Math.floor(lookbackDays));
  const start = new Date(now.getTime() - boundedDays * 86_400_000);
  return start.toISOString().slice(0, 10);
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

  let resultsFound = 0;
  let resultsQualified = 0;

  try {
    const seenUrls = new Set<string>();
    for (const { query, entityHint } of queries) {
      const results = await searchProvider.search(query, { maxResults: MAX_RESULTS_PER_QUERY, startDate });
      for (const result of results) {
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        resultsFound++;

        const qualification = await radarAiProvider.qualifySignal({
          entityHint,
          territoryName: territory.name,
          evidence: [{ url: result.url, title: result.title, text: result.snippet }],
        });

        if (!qualification.keep) continue;

        const primaryUrl = qualification.evidenceUrls[0] ?? result.url;
        const dedupeKey = computeDedupeKey(qualification.entityName, qualification.signalType, primaryUrl);
        // Stage 6: deterministic, exact-name-only bridge to the canonical
        // companies table -- see radarCompanyBridge.ts. Stays null on any
        // ambiguity; never an LLM call, never fuzzy.
        const companyId = await resolveSafeCompanyIdForEntityName(qualification.entityName);

        const [inserted] = await db
          .insert(channelRadarSignalsTable)
          .values({
            territoryId: territory.id,
            assignedUserId: territory.ownerUserId,
            companyId,
            entityName: qualification.entityName,
            entityType: qualification.entityType,
            signalType: qualification.signalType,
            headline: qualification.headline,
            summary: qualification.summary,
            whyItMatters: qualification.whyItMatters,
            implication: qualification.implication,
            impact: qualification.impact,
            recommendedAction: qualification.recommendedAction,
            confidence: qualification.confidence,
            sourceTitle: result.title,
            sourceUrl: primaryUrl,
            sourceDomain: extractDomain(primaryUrl),
            sourcePublishedAt: result.publishedAt, // honest: null when the provider gave no date
            dedupeKey,
          })
          .onConflictDoNothing({ target: channelRadarSignalsTable.dedupeKey })
          .returning();

        if (inserted) resultsQualified++;
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

  return { resultsFound, resultsQualified };
}
