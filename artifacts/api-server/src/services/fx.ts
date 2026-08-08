import { db } from "@workspace/db";
import { fxSnapshotsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

// Server-side FX for the three currencies this app displays commercial
// money metrics in. USD is the canonical stored currency everywhere else in
// the schema (prospects.pipeline_sourced/pipeline_influenced/revenue_closed,
// kpi_snapshots.current_value) -- this module only ever produces a
// *display-time* conversion rate, it never rewrites a stored USD value.
export type SupportedCurrency = "USD" | "EUR" | "GBP";
const QUOTE_CURRENCIES: Extract<SupportedCurrency, "EUR" | "GBP">[] = ["EUR", "GBP"];

export interface FxInfo {
  currency: SupportedCurrency;
  usd_to_currency_rate: number; // 1 USD = usd_to_currency_rate units of `currency`
  as_of: string | null;
  source: string | null;
  stale: boolean;
}

const FRANKFURTER_URL = "https://api.frankfurter.app/latest?from=USD&to=EUR,GBP";
const SOURCE_NAME = "frankfurter.app";
const FETCH_TIMEOUT_MS = 5000;

export class FxUnavailableError extends Error {
  constructor(currency: SupportedCurrency) {
    super(`No live or previously-stored USD->${currency} rate is available.`);
    this.name = "FxUnavailableError";
  }
}

export class InvalidCurrencyError extends Error {
  constructor(raw: string) {
    super(`Invalid currency: "${raw}". Supported values: USD, EUR, GBP.`);
    this.name = "InvalidCurrencyError";
  }
}

// Validates a raw `currency` query param against the generated contract's
// enum. Missing/empty defaults to USD (matching the contract's declared
// default); USD/EUR/GBP are accepted as-is; anything else throws
// InvalidCurrencyError for the caller to turn into a 400 -- unlike
// resolvePeriodKey's silent fallback for an unknown period, an invalid
// currency is not silently coerced.
export function parseCurrencyParam(raw: unknown): SupportedCurrency {
  if (raw === undefined || raw === null || raw === "") return "USD";
  if (raw === "USD" || raw === "EUR" || raw === "GBP") return raw;
  throw new InvalidCurrencyError(String(raw));
}

function usdInfo(): FxInfo {
  return { currency: "USD", usd_to_currency_rate: 1, as_of: null, source: null, stale: false };
}

async function fetchLiveRates(): Promise<{ asOf: string; rates: Record<string, number> } | null> {
  try {
    const res = await fetch(FRANKFURTER_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
    if (!body.date || typeof body.rates?.EUR !== "number" || typeof body.rates?.GBP !== "number") {
      return null;
    }
    return { asOf: body.date, rates: body.rates };
  } catch {
    // Network error, timeout (AbortSignal.timeout), non-JSON body, etc. --
    // caller falls back to the latest stored snapshot rather than
    // surfacing this.
    return null;
  }
}

async function persistRate(quote: "EUR" | "GBP", rate: number, asOf: string): Promise<void> {
  await db
    .insert(fxSnapshotsTable)
    .values({ baseCurrency: "USD", quoteCurrency: quote, rate: String(rate), source: SOURCE_NAME, asOf })
    .onConflictDoUpdate({
      target: [fxSnapshotsTable.baseCurrency, fxSnapshotsTable.quoteCurrency, fxSnapshotsTable.asOf],
      set: { rate: String(rate), source: SOURCE_NAME, fetchedAt: new Date() },
    });
}

async function latestStoredRate(quote: "EUR" | "GBP"): Promise<{ rate: number; asOf: string; source: string } | null> {
  const [row] = await db
    .select()
    .from(fxSnapshotsTable)
    .where(and(eq(fxSnapshotsTable.baseCurrency, "USD"), eq(fxSnapshotsTable.quoteCurrency, quote)))
    .orderBy(desc(fxSnapshotsTable.asOf))
    .limit(1);
  if (!row) return null;
  return { rate: Number(row.rate), asOf: row.asOf, source: row.source };
}

/**
 * Resolves FX for exactly one currency. Callers must invoke this once per
 * request/report build, never per-metric -- a single Frankfurter call
 * covers both EUR and GBP, since the upstream endpoint returns both
 * together regardless of which one was asked for, so both get persisted
 * every time a non-USD currency is requested.
 *
 * USD never touches the network or fx_snapshots. On live-fetch failure
 * (including a >5s timeout), falls back to the latest persisted snapshot
 * for the requested currency with stale: true. If neither a live rate nor
 * any stored snapshot exists (only possible on a brand-new deployment's
 * very first request while Frankfurter is simultaneously unreachable),
 * throws FxUnavailableError rather than fabricating a rate.
 */
export async function resolveFx(currency: SupportedCurrency): Promise<FxInfo> {
  if (currency === "USD") return usdInfo();

  const live = await fetchLiveRates();
  if (live) {
    await Promise.all(QUOTE_CURRENCIES.map((q) => persistRate(q, live.rates[q], live.asOf)));
    return { currency, usd_to_currency_rate: live.rates[currency], as_of: live.asOf, source: SOURCE_NAME, stale: false };
  }

  const stored = await latestStoredRate(currency);
  if (stored) {
    return { currency, usd_to_currency_rate: stored.rate, as_of: stored.asOf, source: stored.source, stale: true };
  }

  throw new FxUnavailableError(currency);
}
