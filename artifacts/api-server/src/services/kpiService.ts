import { db } from "@workspace/db";
import {
  territoriesTable,
  prospectsTable,
  campaignsTable,
  kpiSnapshotsTable,
  metricMappingsTable,
  manualMetricValuesTable,
  metricTargetsTable,
  connectionsTable,
  usersTable,
  partnerRecruitmentsTable,
  partnerOpportunitiesTable,
  OPPORTUNITY_ATTRIBUTION_TYPES,
} from "@workspace/db";
import { eq, and, isNull, gte, lte, inArray, desc } from "drizzle-orm";
import { METRIC_BY_KEY, METRIC_REGISTRY, resolvePeriodRange, resolvePeriodKey, splitPeriodKey, isMoneyMetric, type SourceType } from "./kpiRegistry";
import { hasCredential } from "./connections";
import { resolveFx, type SupportedCurrency, type FxInfo } from "./fx";

export type DataStatus = "CONNECTED" | "MANUAL" | "DEMO" | "NOT_CONNECTED";
export type MappingStatus = "connected" | "needs_mapping" | "not_connected" | "demo";

export interface TerritoryContribution {
  territory_id: string | null;
  territory_name: string;
  value: number;
}

export interface KpiDetailRecord {
  label: string;
  value: number;
  date: string | null;
}

export interface PamContribution {
  pam_user_id: string | null;
  pam_name: string | null;
  territory_id: string;
  territory_name: string;
  value: number;
}

export interface ResolvedTerritory {
  territoryId: string | null;
  territoryName: string;
}

export interface KpiComputation {
  current: number | null;
  target: number | null;
  last_week: number | null;
  trend: "up" | "down" | "flat" | null;
  status: "green" | "amber" | "red" | "on_track" | null;
  data_status: DataStatus;
  data_source: string | null;
  last_updated: string | null;
  // true when last_updated is a wall-clock fallback (no underlying
  // row/timestamp existed), not a genuine data timestamp -- read by
  // aiChannelBriefService to normalize the AI generation-input hash.
  // Never surfaced through the public API (silently stripped by the
  // response zod schemas, which have no matching property).
  last_updated_is_synthetic?: boolean;
  what_changed: string | null;
  explanation: string | null;
  by_territory: TerritoryContribution[];
  records: KpiDetailRecord[];
}

// metric_mappings is user-configurable (Admin > Connections & data can
// deliberately set any source_type per metric, including DEMO/MANUAL/
// NOT_CONNECTED) -- ensureMetricMappingsSeeded must never blindly resync
// every existing row to the registry's current default, since that would
// silently discard an admin's intentional customization. This is why the
// loop below only ever INSERTs rows that don't exist yet, never UPDATEs an
// existing one.
//
// opportunities_created is a narrow, known exception (Phase 5A follow-up):
// every database seeded before Phase 5A has it stuck at the OLD default
// (DEMO, from before partner_opportunities existed), and since this
// function never updates existing rows, that database would never pick up
// the new PARTNER_RADAR computation no matter how the app code changes.
// upgradeKnownStaleMappings corrects exactly that one metric_key, and only
// when it still holds exactly that one legacy value -- every other metric,
// and any opportunities_created row an admin has since set to something
// else (including deliberately back to DEMO), is left untouched.
const LEGACY_STALE_MAPPINGS: ReadonlyArray<{ metricKey: string; staleSourceType: SourceType; correctSourceType: SourceType }> = [
  { metricKey: "opportunities_created", staleSourceType: "DEMO", correctSourceType: "PARTNER_RADAR" },
];

async function upgradeKnownStaleMappings(): Promise<void> {
  for (const { metricKey, staleSourceType, correctSourceType } of LEGACY_STALE_MAPPINGS) {
    await db
      .update(metricMappingsTable)
      .set({ sourceType: correctSourceType, updatedAt: new Date() })
      .where(and(eq(metricMappingsTable.metricKey, metricKey), eq(metricMappingsTable.sourceType, staleSourceType)));
  }
}

export async function ensureMetricMappingsSeeded(): Promise<void> {
  const existing = await db.select().from(metricMappingsTable);
  const existingKeys = new Set(existing.map((m) => m.metricKey));
  const missing = METRIC_REGISTRY.filter((m) => !existingKeys.has(m.key));
  if (missing.length > 0) {
    await db.insert(metricMappingsTable).values(
      missing.map((m) => ({
        metricKey: m.key,
        sourceType: m.defaultSourceType,
        active: true,
        mappingJson: null,
      })),
    );
  }
  await upgradeKnownStaleMappings();
}

export async function resolveTerritory(territory: string | undefined | null): Promise<ResolvedTerritory> {
  const isGlobalRequest = !territory || ["global", "Global", "null", "undefined"].includes(territory);
  if (isGlobalRequest) return { territoryId: null, territoryName: "Global" };

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(territory);
  const [terr] = await db
    .select()
    .from(territoriesTable)
    .where(isUuid ? eq(territoriesTable.id, territory) : eq(territoriesTable.name, territory));
  if (terr) return { territoryId: terr.id, territoryName: terr.name };
  return { territoryId: null, territoryName: "Global" };
}

function trendOf(current: number, previous: number): "up" | "down" | "flat" {
  return current > previous ? "up" : current < previous ? "down" : "flat";
}

// Management-configured target for this metric_key/period/territory, from
// metric_targets -- the single source of truth for an edited target,
// independent of how source_type computes "current". null means no target
// has been configured (never a fabricated default).
//
// Stage 6.2: targets are canonically keyed by (metric_key, period,
// pam_user_id, territory_id). Every caller of computeMetric (Overview,
// exports, the AI brief) only ever has a territory in hand, never a PAM
// directly -- so the accountable PAM is derived here from the v1
// one-PAM-owns-one-territory invariant (territories.owner_user_id) rather
// than threading a new parameter through the entire KPI call chain. A
// Global scope, or a territory with no canonical owner, has no single
// accountable PAM in the new model and therefore no target -- this is a
// deliberate behavior change from pre-6.2 "Global" targets (see the 6.2
// final report).
export async function getTargetOverride(metricKey: string, periodKey: string, territoryId: string | null): Promise<number | null> {
  if (!territoryId) return null;
  const split = splitPeriodKey(periodKey);
  if (!split) return null;
  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, territoryId));
  const pamUserId = territory?.ownerUserId ?? null;
  if (!pamUserId) return null;

  const [row] = await db
    .select()
    .from(metricTargetsTable)
    .where(
      and(
        eq(metricTargetsTable.metricKey, metricKey),
        eq(metricTargetsTable.year, split.year),
        eq(metricTargetsTable.period, split.quarterKey),
        eq(metricTargetsTable.territoryId, territoryId),
        eq(metricTargetsTable.pamUserId, pamUserId),
      ),
    );
  return row ? Number(row.targetValue) : null;
}

// targetOverride, when provided, is authoritative for both the returned
// target and the status banding derived from it -- this is the only
// PARTNER_RADAR computation that self-derives a status from its target, so
// threading the override in here (rather than only patching `target` after
// the fact) keeps status and target consistent in one pass.
async function computeNewPartnerProspects(periodKey: string, target: ResolvedTerritory, targetOverride?: number | null): Promise<KpiComputation> {
  const periodInfo = resolvePeriodRange(periodKey);
  const allTerritories = await db.select().from(territoriesTable);
  const allProspects = await db.select().from(prospectsTable);

  const periodStartMs = new Date(periodInfo.start).getTime();
  const periodEndMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();
  const inPeriod = allProspects.filter((p) => {
    const createdMs = new Date(p.createdAt as unknown as string).getTime();
    return createdMs >= periodStartMs && createdMs <= periodEndMs;
  });

  const isCountable = (p: (typeof inPeriod)[number]) =>
    p.status === "new" || p.status === "accepted" || p.status === "pushed_to_hubspot";

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: inPeriod.filter((p) => p.territoryId === t.id && isCountable(p)).length,
  }));

  const scoped = target.territoryId ? inPeriod.filter((p) => p.territoryId === target.territoryId) : inPeriod;
  const newCount = scoped.filter((p) => p.status === "new").length;
  const acceptedCount = scoped.filter((p) => p.status === "accepted").length;
  const pushedCount = scoped.filter((p) => p.status === "pushed_to_hubspot").length;
  const rejectedCount = scoped.filter((p) => p.status === "rejected").length;
  const total = newCount + acceptedCount + pushedCount;
  // Honest: no metric_targets row -> no target, no status. Never a fabricated default.
  const targetValue = targetOverride ?? null;
  const mostRecent = scoped.reduce<Date | null>((latest, p) => {
    const created = new Date(p.createdAt as unknown as string);
    return !latest || created > latest ? created : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped
    .filter(isCountable)
    .slice(0, 100)
    .map((p) => ({ label: `Prospect ${p.id.slice(0, 8)} (${p.status})`, value: 1, date: new Date(p.createdAt as unknown as string).toISOString() }));

  const status: KpiComputation["status"] =
    targetValue === null ? null : total >= targetValue ? "green" : total >= targetValue * 0.7 ? "amber" : "red";

  return {
    current: total,
    target: targetValue,
    last_week: null,
    trend: null,
    status,
    data_status: "CONNECTED",
    data_source: "Live: prospects table, scoped to prospects created within the selected period",
    last_updated: (mostRecent ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecent === null,
    what_changed: `${acceptedCount} accepted, ${newCount} awaiting review, ${rejectedCount} rejected`,
    explanation: `${acceptedCount} accepted and ${newCount} awaiting review, out of ${scoped.length} discovered in ${periodInfo.label} for ${target.territoryName}. ${rejectedCount} were rejected as not a fit.`,
    by_territory: byTerritory,
    records,
  };
}

// Signed Partners (locked semantics): eligible statuses are accepted and
// pushed_to_hubspot; accepted_at is the canonical date and is never
// substituted with created_at. Current = cumulative count of accepted_at
// inside the selected period through the effective as-of date -- today for
// an active period, the period's own end for a completed one, and
// (naturally, via an empty date window) zero for a future period.
// last_updated reflects the underlying prospect rows' own updated_at, not
// request time. Last Week is the same cumulative count through the end of
// the previous calendar week -- only when that cutoff lies inside the
// active selected period (previousWeekCutoffInActivePeriod), else null.
// Stage 4 correction: eligibility is partner_recruitments.stage = "signed"
// (never prospects.status accepted/pushed_to_hubspot -- Accepted,
// Contacting, Engaged, and Agreement are all real, ongoing recruitment work,
// not a signed partner). The date field is signed_at, set only the moment a
// recruitment enters "signed" (see partnerRecruitmentService.ts) and never
// substituted with accepted_at/created_at. No historical backfill: existing
// demo/legacy accepted or pushed_to_hubspot prospects were never given a
// partner_recruitments row retroactively, so they honestly do not count here.
async function computeSignedPartners(periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = resolvePeriodRange(periodKey);
  const allTerritories = await db.select().from(territoriesTable);
  const allRecruitments = await db.select().from(partnerRecruitmentsTable);

  const periodStartMs = new Date(periodInfo.start).getTime();

  const isEligibleThrough = (r: (typeof allRecruitments)[number], endMs: number) => {
    if (r.stage !== "signed") return false;
    if (r.signedAt === null) return false;
    const signedMs = new Date(r.signedAt as unknown as string).getTime();
    return signedMs >= periodStartMs && signedMs <= endMs;
  };

  const eligible = allRecruitments.filter((r) => isEligibleThrough(r, effectiveAsOfMs(periodKey)));

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: eligible.filter((r) => r.territoryId === t.id).length,
  }));

  const scoped = target.territoryId ? eligible.filter((r) => r.territoryId === target.territoryId) : eligible;
  const mostRecentUpdated = scoped.reduce<Date | null>((latest, r) => {
    const updated = new Date(r.updatedAt as unknown as string);
    return !latest || updated > latest ? updated : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped
    .slice(0, 100)
    .map((r) => ({
      label: `Recruitment ${r.id.slice(0, 8)} (signed)`,
      value: 1,
      date: new Date(r.signedAt as unknown as string).toISOString(),
    }));

  const lastWeekCutoff = previousWeekCutoffInActivePeriod(periodInfo);
  let lastWeek: number | null = null;
  if (lastWeekCutoff !== null) {
    const lastWeekEndMs = new Date(lastWeekCutoff + "T23:59:59.999Z").getTime();
    const lastWeekEligible = allRecruitments.filter((r) => isEligibleThrough(r, lastWeekEndMs));
    lastWeek = (target.territoryId ? lastWeekEligible.filter((r) => r.territoryId === target.territoryId) : lastWeekEligible).length;
  }

  return {
    current: scoped.length,
    target: null,
    ...cumulativeWeekComparison(scoped.length, lastWeek),
    status: null,
    data_status: "CONNECTED",
    data_source: "Live: partner_recruitments table, stage=signed with signed_at inside the selected period, through the effective as-of date",
    last_updated: (mostRecentUpdated ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecentUpdated === null,
    what_changed: null,
    explanation: `${scoped.length} partner${scoped.length === 1 ? "" : "s"} signed in ${periodInfo.label} for ${target.territoryName}, based on signed_at.`,
    by_territory: byTerritory,
    records,
  };
}

// Renewals (locked semantics): count, never money. Current = cumulative
// count of renewal_date inside the selected period through the effective
// as-of date, mirroring signed_partners. last_updated reflects the
// underlying prospect rows' own updated_at, not request time. Last Week is
// the same cumulative count through the end of the previous calendar week,
// only when that cutoff lies inside the active selected period, else null.
async function computeRenewals(periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = resolvePeriodRange(periodKey);
  const allTerritories = await db.select().from(territoriesTable);
  const allProspects = await db.select().from(prospectsTable);

  const inRange = (dateStr: string | null, end: string) =>
    dateStr !== null && dateStr >= periodInfo.start && dateStr <= end;

  const eligible = allProspects.filter((p) => inRange(p.renewalDate, effectiveAsOfDateStr(periodKey)));

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: eligible.filter((p) => p.territoryId === t.id).length,
  }));

  const scoped = target.territoryId ? eligible.filter((p) => p.territoryId === target.territoryId) : eligible;
  const mostRecentUpdated = scoped.reduce<Date | null>((latest, p) => {
    const updated = new Date(p.updatedAt as unknown as string);
    return !latest || updated > latest ? updated : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped
    .slice(0, 100)
    .map((p) => ({ label: `Prospect ${p.id.slice(0, 8)} renewal`, value: 1, date: p.renewalDate }));

  const lastWeekCutoff = previousWeekCutoffInActivePeriod(periodInfo);
  let lastWeek: number | null = null;
  if (lastWeekCutoff !== null) {
    const lastWeekEligible = allProspects.filter((p) => inRange(p.renewalDate, lastWeekCutoff));
    lastWeek = (target.territoryId ? lastWeekEligible.filter((p) => p.territoryId === target.territoryId) : lastWeekEligible).length;
  }

  return {
    current: scoped.length,
    target: null,
    ...cumulativeWeekComparison(scoped.length, lastWeek),
    status: null,
    data_status: "CONNECTED",
    data_source: "Live: prospects table, renewal_date inside the selected period through the effective as-of date (count, not revenue)",
    last_updated: (mostRecentUpdated ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecentUpdated === null,
    what_changed: null,
    explanation: `${scoped.length} renewal${scoped.length === 1 ? "" : "s"} due in ${periodInfo.label} for ${target.territoryName}, based on renewal_date.`,
    by_territory: byTerritory,
    records,
  };
}

// Phase 5A: partner_sourced_pipeline / partner_influenced_pipeline are
// current-state metrics backed by partner_opportunities.attributionType
// (open opportunities only) -- no historical audit trail of their own, same
// as before this table existed, just sourced differently now. closed_revenue
// is deliberately NOT in this map any more: a won opportunity's closed_at is
// a real per-row business date, so closed_revenue is a period-flow query
// (computeClosedRevenue below), not a current-state snapshot dispatch.
// Exported so the weekly snapshot writer uses this exact same mapping
// rather than a second, potentially-drifting copy.
export const PIPELINE_ATTRIBUTION_BY_KEY: Record<string, "partner_sourced" | "partner_influenced"> = {
  partner_sourced_pipeline: "partner_sourced",
  partner_influenced_pipeline: "partner_influenced",
};

// Fetches each distinct currency's USD rate at most once via services/fx.ts,
// then lets callers convert many rows synchronously. USD itself resolves
// instantly at rate=1 with no network call, so an all-USD row set (e.g.
// every automated-test fixture) never touches a live provider. Currency
// conversion for DISPLAY still only ever happens in the outer API caller
// (see isMoneyMetric/convertMoney elsewhere in this file) -- this only
// normalizes multi-currency deal_value rows into one comparable USD sum,
// matching computeMetric's existing "always returns raw USD" contract.
export async function buildUsdRateMap(currencies: Iterable<string>): Promise<Map<string, number>> {
  const distinct = [...new Set(currencies)];
  const rateByCurrency = new Map<string, number>();
  for (const currency of distinct) {
    const fx = await resolveFx(currency as SupportedCurrency);
    rateByCurrency.set(currency, fx.usd_to_currency_rate);
  }
  return rateByCurrency;
}

export function usdValueOf(row: { dealValue: string; currency: string }, rateByCurrency: Map<string, number>): number {
  return Number(row.dealValue) / (rateByCurrency.get(row.currency) ?? 1);
}

// Monday (UTC, YYYY-MM-DD) of the calendar week containing `date`. This is
// the same week-alignment the Stage 2B snapshot writer uses for
// kpi_snapshots.period_start, so lookups here line up with what gets
// written there.
export function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

// Sunday 23:59:59.999 UTC of the calendar week immediately before the one
// containing `date`.
function endOfPreviousCalendarWeek(date: Date): Date {
  const mondayThisWeek = new Date(mondayOf(date) + "T00:00:00.000Z");
  const sundayLastWeek = new Date(mondayThisWeek);
  sundayLastWeek.setUTCDate(sundayLastWeek.getUTCDate() - 1);
  sundayLastWeek.setUTCHours(23, 59, 59, 999);
  return sundayLastWeek;
}

function minDateStr(a: string, b: string): string {
  return a <= b ? a : b;
}

// "Current" upper bound for a period-filtered live count: today for an
// active period, the period's own end for a completed one. For a future
// period this still resolves to today, which -- paired with the
// >= period.start lower bound in the caller -- yields an empty (and
// therefore zero) window rather than needing a special case.
function effectiveAsOfMs(periodKey: string): number {
  const periodInfo = resolvePeriodRange(periodKey);
  const periodEndMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();
  return Math.min(periodEndMs, Date.now());
}

function effectiveAsOfDateStr(periodKey: string): string {
  const periodInfo = resolvePeriodRange(periodKey);
  const todayStr = new Date().toISOString().slice(0, 10);
  return minDateStr(periodInfo.end, todayStr);
}

// Where a reporting period sits relative to today. Drives the 3 current-
// state money metrics' dispatch: only an "active" period may show today's
// live total; a "past" period reads a persisted snapshot; a "future"
// period is honestly unavailable rather than either of those.
function periodState(periodKey: string): "past" | "active" | "future" {
  const periodInfo = resolvePeriodRange(periodKey);
  const todayStr = new Date().toISOString().slice(0, 10);
  if (todayStr < periodInfo.start) return "future";
  if (todayStr > periodInfo.end) return "past";
  return "active";
}

// "Last Week" cutoff (inclusive YYYY-MM-DD, the Sunday ending the previous
// calendar week) for the cumulative period-flow KPIs (signed_partners,
// renewals, closed_revenue, opportunities_created). A comparison is only
// legitimate when the selected period is ACTIVE and that cutoff falls
// inside it: in the period's first week the cutoff precedes period.start
// (the "previous" cumulative total would be an empty window, not a real
// prior value), and for a past or future period "the previous calendar
// week" is not a point inside the selected period at all. null means
// unavailable -- never a fabricated 0 or "flat".
export function previousWeekCutoffInActivePeriod(period: { start: string; end: string }, now: Date = new Date()): string | null {
  const todayStr = now.toISOString().slice(0, 10);
  if (todayStr < period.start || todayStr > period.end) return null;
  const cutoff = endOfPreviousCalendarWeek(now).toISOString().slice(0, 10);
  if (cutoff < period.start) return null;
  return cutoff;
}

// last_week/trend for a cumulative period-flow KPI. An unavailable
// comparison stays null/null; a genuine comparison -- including an equal
// value -- goes through trendOf unchanged.
export function cumulativeWeekComparison(current: number, lastWeek: number | null): Pick<KpiComputation, "last_week" | "trend"> {
  if (lastWeek === null) return { last_week: null, trend: null };
  return { last_week: lastWeek, trend: trendOf(current, lastWeek) };
}

// Most recent persisted kpi_snapshots row for a metric/territory whose
// period_start falls within [periodStart, periodEnd] -- i.e. the last
// weekly capture that happened during a given reporting quarter/YTD.
async function latestKpiSnapshotInRange(
  metricLabel: string,
  territoryId: string | null,
  periodStart: string,
  periodEnd: string,
): Promise<typeof kpiSnapshotsTable.$inferSelect | undefined> {
  const scopeFilter = territoryId ? eq(kpiSnapshotsTable.territoryId, territoryId) : isNull(kpiSnapshotsTable.territoryId);
  const [row] = await db
    .select()
    .from(kpiSnapshotsTable)
    .where(and(eq(kpiSnapshotsTable.metricName, metricLabel), scopeFilter, gte(kpiSnapshotsTable.periodStart, periodStart), lte(kpiSnapshotsTable.periodStart, periodEnd)))
    .orderBy(desc(kpiSnapshotsTable.periodStart))
    .limit(1);
  return row;
}

// "Last Week" per the locked semantics: the previous week's *persisted*
// snapshot, exact-matched on period_start = Monday of the week before
// currentWeekMonday. Returns null (never invented) if that row doesn't
// exist yet.
async function previousWeekSnapshotValue(
  metricLabel: string,
  territoryId: string | null,
  currentWeekMonday: string,
): Promise<number | null> {
  const prevMonday = new Date(currentWeekMonday + "T00:00:00.000Z");
  prevMonday.setUTCDate(prevMonday.getUTCDate() - 7);
  const prevMondayStr = prevMonday.toISOString().slice(0, 10);

  const scopeFilter = territoryId ? eq(kpiSnapshotsTable.territoryId, territoryId) : isNull(kpiSnapshotsTable.territoryId);
  const [row] = await db
    .select()
    .from(kpiSnapshotsTable)
    .where(and(eq(kpiSnapshotsTable.metricName, metricLabel), scopeFilter, eq(kpiSnapshotsTable.periodStart, prevMondayStr)))
    .limit(1);
  return row ? Number(row.currentValue) : null;
}

// partner_sourced_pipeline / partner_influenced_pipeline (Phase 5A): current-
// state totals with no historical audit trail of their own, restricted to
// OPEN partner_opportunities rows only (won/lost never contribute to
// pipeline). This is the *live* value, valid only when
// periodState(periodKey) === "active". Last Week always comes from the
// previous week's persisted snapshot, never computed live -- these fields
// have no audit trail to recompute a past value from.
async function computeCurrentStateLive(metricKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const attributionType = PIPELINE_ATTRIBUTION_BY_KEY[metricKey];
  const label = METRIC_BY_KEY.get(metricKey)!.label;
  const allTerritories = await db.select().from(territoriesTable);

  // Phase 7: shares its "status = open" eligibility with
  // computeOpenPipelineForScope below (fetchOpenOpportunities).
  const open = await fetchOpenOpportunities();
  const eligible = open.filter((o) => o.attributionType === attributionType);
  const rateByCurrency = await buildUsdRateMap(eligible.map((o) => o.currency));
  const valueOf = (o: (typeof eligible)[number]) => usdValueOf(o, rateByCurrency);

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: eligible.filter((o) => o.territoryId === t.id).reduce((sum, o) => sum + valueOf(o), 0),
  }));

  const scoped = target.territoryId ? eligible.filter((o) => o.territoryId === target.territoryId) : eligible;
  const current = scoped.reduce((sum, o) => sum + valueOf(o), 0);

  const mostRecentUpdated = scoped.reduce<Date | null>((latest, o) => {
    const updated = new Date(o.updatedAt as unknown as string);
    return !latest || updated > latest ? updated : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped
    .filter((o) => valueOf(o) !== 0)
    .slice(0, 100)
    .map((o) => ({ label: o.name, value: valueOf(o), date: o.opportunityDate }));

  const lastWeek = await previousWeekSnapshotValue(label, target.territoryId, mondayOf(new Date()));

  return {
    current,
    target: null,
    last_week: lastWeek,
    trend: lastWeek !== null ? trendOf(current, lastWeek) : null,
    status: null,
    data_status: "CONNECTED",
    data_source: `Live: partner_opportunities table, open ${attributionType} opportunities' current total across ${target.territoryName} (not period-filtered -- pipeline is a current-state metric; deal_value normalized to USD)`,
    last_updated: (mostRecentUpdated ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecentUpdated === null,
    what_changed: null,
    explanation: `Current live open ${label.toLowerCase()} total in ${target.territoryName}, as of now.`,
    by_territory: byTerritory,
    records,
  };
}

// Historical cutover note: a pre-go-live open opportunity is backfilled with
// its true opportunityDate (which may be well before app go-live) but no
// closedAt -- it is picked up here purely by status="open", with no date
// filter at all, exactly like every other open opportunity. Pipeline is a
// current-state metric, so "when was this opened" never gates inclusion.
//
// partner_sourced_pipeline / partner_influenced_pipeline, for a "past"
// period: the live current-state total cannot honestly be labeled as that
// period's value, so this reads the latest weekly kpi_snapshots row
// captured during that period instead. A territory with no snapshot in
// range is *omitted* from by_territory entirely -- a missing snapshot means
// unavailable, never zero. Returns NOT_CONNECTED (never a fabricated
// number) if the selected scope itself has no snapshot for that period.
async function computeCurrentStateFromSnapshot(
  metricKey: string,
  periodKey: string,
  target: ResolvedTerritory,
): Promise<KpiComputation> {
  const periodInfo = resolvePeriodRange(periodKey);
  const label = METRIC_BY_KEY.get(metricKey)!.label;
  const allTerritories = await db.select().from(territoriesTable);

  const byTerritoryRows = await Promise.all(
    allTerritories.map(async (t): Promise<TerritoryContribution | null> => {
      const row = await latestKpiSnapshotInRange(label, t.id, periodInfo.start, periodInfo.end);
      return row ? { territory_id: t.id, territory_name: t.name, value: Number(row.currentValue) } : null;
    }),
  );
  const byTerritory: TerritoryContribution[] = byTerritoryRows.filter((r): r is TerritoryContribution => r !== null);

  const snapshot = await latestKpiSnapshotInRange(label, target.territoryId, periodInfo.start, periodInfo.end);
  if (!snapshot) {
    return notConnected(`No historical snapshot has been recorded yet for ${label} in ${periodInfo.label}.`);
  }

  const lastWeek = await previousWeekSnapshotValue(label, target.territoryId, snapshot.periodStart);
  const current = Number(snapshot.currentValue);

  return {
    current,
    target: snapshot.targetValue !== null ? Number(snapshot.targetValue) : null,
    last_week: lastWeek,
    trend: lastWeek !== null ? trendOf(current, lastWeek) : null,
    status: null,
    data_status: "CONNECTED",
    data_source: `Historical: last captured ${snapshot.periodStart} (weekly snapshot) -- ${periodInfo.label} does not contain today, so a current live total cannot honestly be labeled as this period's value`,
    last_updated: snapshot.updatedAt.toISOString(),
    what_changed: snapshot.whatChanged,
    explanation: snapshot.explanation ?? `Historical total for ${label} in ${target.territoryName}, as last captured on ${snapshot.periodStart}.`,
    by_territory: byTerritory,
    records: [],
  };
}

// closed_revenue (Phase 5A): a period-flow metric, computed directly from
// partner_opportunities the same way computeRenewals reads prospects -- won
// opportunities whose real closed_at falls inside the selected period. This
// is a REPORTING figure only, always using the true deal_value/closed_at
// even for a historically-backfilled deal, and is NOT the same figure as
// target attainment: attainment instead uses credit_value/credit_date when
// present (see targetService.ts's getAnnualCascade/computeAnnualCascade), so
// a contract can report as closed revenue in the quarter it truly closed
// while separately crediting a different (e.g. later) target period without
// double-reporting or falsifying closed_at.
async function computeClosedRevenue(periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = resolvePeriodRange(periodKey);
  const label = METRIC_BY_KEY.get("closed_revenue")!.label;
  const allTerritories = await db.select().from(territoriesTable);

  // Phase 7: shares its won/closed_at-in-range eligibility with
  // computeClosedRevenueForRange below (fetchWonOpportunitiesInRange) --
  // dayAfter() turns this function's existing inclusive end date into that
  // helper's [start, end) contract without changing which dates are
  // included (see dayAfter's own comment).
  const eligible = await fetchWonOpportunitiesInRange(periodInfo.start, dayAfter(effectiveAsOfDateStr(periodKey)));

  const rateByCurrency = await buildUsdRateMap(eligible.map((o) => o.currency));
  const valueOf = (o: (typeof eligible)[number]) => usdValueOf(o, rateByCurrency);

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: eligible.filter((o) => o.territoryId === t.id).reduce((sum, o) => sum + valueOf(o), 0),
  }));

  const scoped = target.territoryId ? eligible.filter((o) => o.territoryId === target.territoryId) : eligible;
  const current = scoped.reduce((sum, o) => sum + valueOf(o), 0);

  const mostRecentUpdated = scoped.reduce<Date | null>((latest, o) => {
    const updated = new Date(o.updatedAt as unknown as string);
    return !latest || updated > latest ? updated : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped.slice(0, 100).map((o) => ({ label: o.name, value: valueOf(o), date: closedAtDateStr(o) }));

  const lastWeekCutoff = previousWeekCutoffInActivePeriod(periodInfo);
  let lastWeek: number | null = null;
  if (lastWeekCutoff !== null) {
    const lastWeekEligible = await fetchWonOpportunitiesInRange(periodInfo.start, dayAfter(lastWeekCutoff));
    const lastWeekRateByCurrency = await buildUsdRateMap(lastWeekEligible.map((o) => o.currency));
    const lastWeekScoped = target.territoryId ? lastWeekEligible.filter((o) => o.territoryId === target.territoryId) : lastWeekEligible;
    lastWeek = lastWeekScoped.reduce((sum, o) => sum + usdValueOf(o, lastWeekRateByCurrency), 0);
  }

  return {
    current,
    target: null,
    ...cumulativeWeekComparison(current, lastWeek),
    status: null,
    data_status: "CONNECTED",
    data_source: "Live: partner_opportunities table, won opportunities with closed_at inside the selected period (period-flow; deal_value normalized to USD)",
    last_updated: (mostRecentUpdated ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecentUpdated === null,
    what_changed: null,
    explanation: `${label} closed in ${periodInfo.label} for ${target.territoryName}, based on closed_at.`,
    by_territory: byTerritory,
    records,
  };
}

// opportunities_created (Phase 5A): period-flow count of opportunity_date
// inside the selected period, mirroring computeRenewals's style exactly
// (just counting partner_opportunities instead of prospects). Deliberately
// not status-filtered -- a since-lost or since-won opportunity was still
// *created* in the period it was originally opened.
async function computeOpportunitiesCreated(periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = resolvePeriodRange(periodKey);
  const allTerritories = await db.select().from(territoriesTable);

  // Phase 7: shares its opportunity_date-in-range eligibility with
  // computeOpportunitiesCreatedForRange below
  // (fetchOpportunitiesCreatedInRange) -- see computeClosedRevenue's
  // dayAfter() comment for why the inclusive end date translates cleanly.
  const eligible = await fetchOpportunitiesCreatedInRange(periodInfo.start, dayAfter(effectiveAsOfDateStr(periodKey)));

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: eligible.filter((o) => o.territoryId === t.id).length,
  }));

  const scoped = target.territoryId ? eligible.filter((o) => o.territoryId === target.territoryId) : eligible;
  const mostRecentUpdated = scoped.reduce<Date | null>((latest, o) => {
    const updated = new Date(o.updatedAt as unknown as string);
    return !latest || updated > latest ? updated : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped.slice(0, 100).map((o) => ({ label: o.name, value: 1, date: o.opportunityDate }));

  const lastWeekCutoff = previousWeekCutoffInActivePeriod(periodInfo);
  let lastWeek: number | null = null;
  if (lastWeekCutoff !== null) {
    const lastWeekEligible = await fetchOpportunitiesCreatedInRange(periodInfo.start, dayAfter(lastWeekCutoff));
    lastWeek = (target.territoryId ? lastWeekEligible.filter((o) => o.territoryId === target.territoryId) : lastWeekEligible).length;
  }

  return {
    current: scoped.length,
    target: null,
    ...cumulativeWeekComparison(scoped.length, lastWeek),
    status: null,
    data_status: "CONNECTED",
    data_source: "Live: partner_opportunities table, opportunity_date inside the selected period through the effective as-of date (count)",
    last_updated: (mostRecentUpdated ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecentUpdated === null,
    what_changed: null,
    explanation: `${scoped.length} opportunit${scoped.length === 1 ? "y" : "ies"} created in ${periodInfo.label} for ${target.territoryName}, based on opportunity_date.`,
    by_territory: byTerritory,
    records,
  };
}

// ---- Phase 7: shared eligibility primitives + additive range/scope entry points ----
//
// Weekly reporting needs two things the existing computeMetric dispatch
// doesn't provide: (1) a date range that isn't a quarter/YTD periodKey, and
// (2) for a PAM's own report, a stricter visibility scope than "territory
// only" -- the same (territory AND assigned_user_id) rule
// routes/opportunities.ts's assertPamOwnsOpportunity and
// campaignService.ts's isOpportunityVisible already enforce for a PAM's own
// opportunities, reused here rather than reinvented, so a weekly report can
// never surface an opportunity assigned to a different PAM merely because it
// sits in the same territory (the one-PAM-per-territory pattern is never
// treated as an authorization boundary).
//
// The existing period-based functions above and the functions below share
// the same DB-fetch+eligibility primitives (fetchWonOpportunitiesInRange,
// fetchOpportunitiesCreatedInRange, fetchOpenOpportunities) -- only the
// downstream scoping/shaping differs, and only because the existing
// functions' by_territory breakdowns are deliberately scope-free (every
// territory's own total, always) while target filtering applies only to
// their `current`/`scoped` figure, exactly as before this section existed.
// computeMetric's externally observable behavior is unchanged.

// Discriminated on purpose (rather than a loosely-optional {territoryId,
// assignedUserId?}) so a PAM-scoped call can never accidentally compile with
// only one of the two fields set -- "pam" always carries both, "territory"
// only where a genuine territory-level (not PAM-identity) figure is needed,
// "global" for unrestricted Head/Admin aggregation. "pam" carries a
// territoryIds ARRAY, not a single id: territories.owner_user_id has no DB
// uniqueness constraint, so a PAM may canonically own more than one
// territory (see authz.ts's getOwnTerritories) -- a single territoryId
// field would silently under-scope such a PAM's report.
export type OpportunityScope =
  | { kind: "global" }
  | { kind: "territory"; territoryId: string }
  | { kind: "pam"; territoryIds: string[]; assignedUserId: string };

// Exported (alongside OpportunityScope) purely so
// tests/weeklyReportingRangeMath.test.ts can exercise this rule directly
// without a database -- same rationale as campaignService.ts's
// isOpportunityVisible.
export function matchesOpportunityScope(o: { territoryId: string; assignedUserId: string }, scope: OpportunityScope): boolean {
  switch (scope.kind) {
    case "global":
      return true;
    case "territory":
      return o.territoryId === scope.territoryId;
    case "pam":
      return scope.territoryIds.includes(o.territoryId) && o.assignedUserId === scope.assignedUserId;
  }
}

// Reuses the canonical attribution vocabulary (partner_opportunities.ts's
// OPPORTUNITY_ATTRIBUTION_TYPES) rather than a separately hard-coded union.
export type OpportunityAttributionType = (typeof OPPORTUNITY_ATTRIBUTION_TYPES)[number];

// One calendar day after a YYYY-MM-DD date string, via UTC date arithmetic
// (never string manipulation) -- lets the existing inclusive-end period
// functions above express their same "<= end" boundary as the shared
// helpers' "< endExclusive" contract without changing which dates are
// included: for plain YYYY-MM-DD strings, `d <= end` is exactly equivalent
// to `d < dayAfter(end)` (see tests/weeklyReportingRangeMath.test.ts).
// Exported purely so tests/weeklyReportingRangeMath.test.ts can prove, without
// a database, that `d <= end` and `d < dayAfter(end)` agree for every plain
// YYYY-MM-DD date string -- the equivalence the refactored
// computeClosedRevenue/computeOpportunitiesCreated rely on to preserve their
// exact pre-Phase-7 inclusive-end behavior.
export function dayAfter(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function closedAtDateStr(o: { closedAt: unknown }): string | null {
  return o.closedAt ? new Date(o.closedAt as string).toISOString().slice(0, 10) : null;
}

// Shared by computeClosedRevenue(periodKey) above and
// computeClosedRevenueForRange(...) below -- the only place "won, closed_at
// inside [startInclusive, endExclusive)" is expressed.
async function fetchWonOpportunitiesInRange(startInclusive: string, endExclusive: string) {
  const allOpportunities = await db.select().from(partnerOpportunitiesTable);
  return allOpportunities.filter((o) => {
    if (o.status !== "won") return false;
    const d = closedAtDateStr(o);
    return d !== null && d >= startInclusive && d < endExclusive;
  });
}

// Shared by computeOpportunitiesCreated(periodKey) above and
// computeOpportunitiesCreatedForRange(...) below. Deliberately not
// status-filtered (unchanged) -- opportunity_date is the real business open
// date, never created_at, so a since-lost/won or historically backfilled
// opportunity still counts in the period it was truly opened.
async function fetchOpportunitiesCreatedInRange(startInclusive: string, endExclusive: string) {
  const allOpportunities = await db.select().from(partnerOpportunitiesTable);
  return allOpportunities.filter((o) => o.opportunityDate >= startInclusive && o.opportunityDate < endExclusive);
}

// Shared by computeCurrentStateLive(metricKey, target) above and
// computeOpenPipelineForScope(...) below -- the only place "status = open"
// is expressed for current-state pipeline/open-count reporting.
async function fetchOpenOpportunities() {
  return db.select().from(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.status, "open"));
}

// Per-opportunity backing data behind every Phase 7 range/scope money total
// below -- lets a caller (weeklyReportingService.ts) dedupe by opportunity_id
// across multiple PAMs' figures (e.g. after a Head/Admin reassignment moves
// an opportunity between PAMs mid-week) without ever re-deriving the
// eligibility/attribution/USD-normalization rule itself; the aggregate
// sourced/influenced/total numbers below are always exactly the sum of
// these entries, never a separately-computed figure.
export interface OpportunityMoneyEntry {
  opportunityId: string;
  attributionType: OpportunityAttributionType;
  usdValue: number;
}

export interface OpportunityClosedRevenueEntry extends OpportunityMoneyEntry {
  // Always non-null: the eligibility filter above (fetchWonOpportunitiesInRange)
  // already requires a real closed_at for every entry that reaches here.
  closedAt: string;
}

export interface OpportunityCreatedEntry {
  opportunityId: string;
  opportunityDate: string;
}

export interface RangeMoneyByAttribution {
  sourced: number;
  influenced: number;
  total: number;
  count: number;
  entries: OpportunityClosedRevenueEntry[];
}

// Additive Phase 7 entry point: same eligibility as computeClosedRevenue
// (fetchWonOpportunitiesInRange above), scoped by an explicit
// OpportunityScope instead of a territory-only ResolvedTerritory, and split
// by attribution (never a single ambiguous total) -- REPORTING revenue only,
// deal_value/closed_at, never credit_value/credit_date.
export async function computeClosedRevenueForRange(
  startInclusive: string,
  endExclusive: string,
  scope: OpportunityScope,
): Promise<RangeMoneyByAttribution> {
  const won = await fetchWonOpportunitiesInRange(startInclusive, endExclusive);
  const eligible = won.filter((o) => matchesOpportunityScope(o, scope));

  const rateByCurrency = await buildUsdRateMap(eligible.map((o) => o.currency));
  const entries: OpportunityClosedRevenueEntry[] = eligible.map((o) => ({
    opportunityId: o.id,
    attributionType: o.attributionType as OpportunityAttributionType,
    usdValue: usdValueOf(o, rateByCurrency),
    closedAt: closedAtDateStr(o)!,
  }));

  const sourced = entries.filter((e) => e.attributionType === "partner_sourced").reduce((sum, e) => sum + e.usdValue, 0);
  const influenced = entries.filter((e) => e.attributionType === "partner_influenced").reduce((sum, e) => sum + e.usdValue, 0);

  return { sourced, influenced, total: sourced + influenced, count: entries.length, entries };
}

// Additive Phase 7 entry point: same eligibility as computeOpportunitiesCreated
// (fetchOpportunitiesCreatedInRange above), scoped by an explicit
// OpportunityScope instead of a territory-only ResolvedTerritory.
export async function computeOpportunitiesCreatedForRange(
  startInclusive: string,
  endExclusive: string,
  scope: OpportunityScope,
): Promise<{ count: number; entries: OpportunityCreatedEntry[] }> {
  const created = await fetchOpportunitiesCreatedInRange(startInclusive, endExclusive);
  const eligible = created.filter((o) => matchesOpportunityScope(o, scope));
  const entries: OpportunityCreatedEntry[] = eligible.map((o) => ({ opportunityId: o.id, opportunityDate: o.opportunityDate }));
  return { count: entries.length, entries };
}

export interface OpenPipelineByScope {
  sourced: number;
  influenced: number;
  total: number;
  openCount: number;
  entries: OpportunityMoneyEntry[];
}

// Additive Phase 7 entry point: same eligibility as computeCurrentStateLive
// (fetchOpenOpportunities above), scoped by an explicit OpportunityScope,
// with sourced/influenced always broken out explicitly (never a single
// ambiguous pipeline number) and openCount derived from the exact same
// filtered set as the money totals -- so a PAM's "open pipeline" and "open
// opportunity count" can never disagree with each other.
export async function computeOpenPipelineForScope(scope: OpportunityScope): Promise<OpenPipelineByScope> {
  const open = await fetchOpenOpportunities();
  const eligible = open.filter((o) => matchesOpportunityScope(o, scope));

  const rateByCurrency = await buildUsdRateMap(eligible.map((o) => o.currency));
  const entries: OpportunityMoneyEntry[] = eligible.map((o) => ({
    opportunityId: o.id,
    attributionType: o.attributionType as OpportunityAttributionType,
    usdValue: usdValueOf(o, rateByCurrency),
  }));

  const sourced = entries.filter((e) => e.attributionType === "partner_sourced").reduce((sum, e) => sum + e.usdValue, 0);
  const influenced = entries.filter((e) => e.attributionType === "partner_influenced").reduce((sum, e) => sum + e.usdValue, 0);

  return { sourced, influenced, total: sourced + influenced, openCount: entries.length, entries };
}

async function computePartnerRadar(metricKey: string, periodKey: string, target: ResolvedTerritory, targetOverride: number | null): Promise<KpiComputation> {
  switch (metricKey) {
    case "new_partner_prospects":
      return computeNewPartnerProspects(periodKey, target, targetOverride);
    case "signed_partners":
      return computeSignedPartners(periodKey, target);
    case "renewals":
      return computeRenewals(periodKey, target);
    case "opportunities_created":
      return computeOpportunitiesCreated(periodKey, target);
    case "closed_revenue":
      return computeClosedRevenue(periodKey, target);
    case "partner_sourced_pipeline":
    case "partner_influenced_pipeline": {
      const state = periodState(periodKey);
      if (state === "active") return computeCurrentStateLive(metricKey, target);
      if (state === "past") return computeCurrentStateFromSnapshot(metricKey, periodKey, target);
      // future
      return notConnected(
        "This reporting period has not started. Current-state pipeline totals are not projected into a future period.",
      );
    }
    default:
      // A PARTNER_RADAR-mapped metric this service doesn't know how to
      // compute -- report it honestly as unsupported rather than
      // substituting another metric's data.
      return notConnected(`No PARTNER_RADAR computation is implemented for metric "${metricKey}".`);
  }
}

// Rolling windows for the ACTIVITIES-sourced marketing KPIs -- NOT calendar
// (Monday-Sunday) weeks. UTC, both ends inclusive, T = today:
//   current:  T-6  .. T     (the last 7 days, including today)
//   previous: T-13 .. T-7   (the 7 days before that)
// The thisWeek*/lastWeek* names are historical; the API field names
// (this_week/last_week) are kept for contract compatibility.
function weekWindow(now: Date) {
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const thisWeekEnd = startOfDay(now);
  const thisWeekStart = new Date(thisWeekEnd);
  thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - 6);
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - 1);
  const lastWeekStart = new Date(lastWeekEnd);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 6);
  return { thisWeekStart, thisWeekEnd, lastWeekStart, lastWeekEnd };
}

// data_source/explanation copy for computeActivities -- states the actual
// rolling windows (derived from weekWindow(now)), never "this week"/
// "calendar week" wording.
export function describeActivityWindows(
  now: Date,
  label: string,
  territoryName: string,
  currentValue: number,
  previousValue: number,
): { data_source: string; explanation: string } {
  const windows = weekWindow(now);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return {
    data_source: `Live: activities table, last 7 days (${d(windows.thisWeekStart)} to ${d(windows.thisWeekEnd)}, UTC) vs previous 7 days (${d(windows.lastWeekStart)} to ${d(windows.lastWeekEnd)})`,
    explanation: `${currentValue} ${label.toLowerCase()} in the last 7 days for ${territoryName}, vs ${previousValue} in the previous 7 days.`,
  };
}

const ACTIVITY_FIELD_BY_KEY: Record<string, { kind: "count"; type: string } | { kind: "sum"; field: "mqls" | "partnerReferrals" }> = {
  joint_campaigns: { kind: "count", type: "joint_campaign" },
  events: { kind: "count", type: "event" },
  webinars: { kind: "count", type: "webinar" },
  marketing_qualified_leads: { kind: "sum", field: "mqls" },
  partner_referrals: { kind: "sum", field: "partnerReferrals" },
};

async function computeActivities(metricKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const now = new Date();
  const { thisWeekStart, thisWeekEnd, lastWeekStart, lastWeekEnd } = weekWindow(now);
  const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
  const allTerritories = await db.select().from(territoriesTable);

  const twoWeekFilter = and(gte(campaignsTable.activityDate, toDateStr(lastWeekStart)), lte(campaignsTable.activityDate, toDateStr(thisWeekEnd)));
  const rows = await db.select().from(campaignsTable).where(twoWeekFilter);

  const inWindow = (dateStr: string | null, start: Date, end: Date) =>
    dateStr !== null && dateStr >= toDateStr(start) && dateStr <= toDateStr(end);

  const field = ACTIVITY_FIELD_BY_KEY[metricKey];
  const valueOf = (subset: typeof rows) => {
    if (field.kind === "count") return subset.filter((r) => r.type === field.type).length;
    return subset.reduce((sum, r) => sum + r[field.field], 0);
  };

  const thisWeekAll = rows.filter((r) => inWindow(r.activityDate, thisWeekStart, thisWeekEnd));
  const lastWeekAll = rows.filter((r) => inWindow(r.activityDate, lastWeekStart, lastWeekEnd));

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: valueOf(thisWeekAll.filter((r) => r.territory === t.name)),
  }));

  const scopedThisWeek = target.territoryId
    ? thisWeekAll.filter((r) => r.territory === target.territoryName)
    : thisWeekAll;
  const scopedLastWeek = target.territoryId
    ? lastWeekAll.filter((r) => r.territory === target.territoryName)
    : lastWeekAll;

  const thisWeekValue = valueOf(scopedThisWeek);
  const lastWeekValue = valueOf(scopedLastWeek);
  const label = METRIC_BY_KEY.get(metricKey)!.label;
  const copy = describeActivityWindows(now, label, target.territoryName, thisWeekValue, lastWeekValue);

  const records: KpiDetailRecord[] = scopedThisWeek
    .filter((r) => (field.kind === "count" ? r.type === field.type : true))
    .slice(0, 100)
    .map((r) => ({
      label: r.name,
      value: field.kind === "count" ? 1 : r[field.field],
      date: r.activityDate,
    }));

  return {
    current: thisWeekValue,
    target: null,
    last_week: lastWeekValue,
    trend: trendOf(thisWeekValue, lastWeekValue),
    status: null,
    data_status: "CONNECTED",
    data_source: copy.data_source,
    last_updated: now.toISOString(),
    last_updated_is_synthetic: true,
    what_changed: null,
    explanation: copy.explanation,
    by_territory: byTerritory,
    records,
  };
}

async function computeDemo(metricKey: string, periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = resolvePeriodRange(periodKey);
  const label = METRIC_BY_KEY.get(metricKey)!.label;
  const allTerritories = await db.select().from(territoriesTable);

  const territoryRows = await db
    .select()
    .from(kpiSnapshotsTable)
    .where(and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.metricName, label), inArray(kpiSnapshotsTable.territoryId, allTerritories.map((t) => t.id))));

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => {
    const row = territoryRows.find((r) => r.territoryId === t.id);
    return { territory_id: t.id, territory_name: t.name, value: row ? Number(row.currentValue) : 0 };
  });

  const scopeWhere = target.territoryId
    ? and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.metricName, label), eq(kpiSnapshotsTable.territoryId, target.territoryId))
    : and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.metricName, label), isNull(kpiSnapshotsTable.territoryId));
  const [snapshot] = await db.select().from(kpiSnapshotsTable).where(scopeWhere);

  if (!snapshot) {
    return {
      current: null,
      target: null,
      last_week: null,
      trend: null,
      status: null,
      data_status: "NOT_CONNECTED",
      data_source: null,
      last_updated: null,
      what_changed: null,
      explanation: `No demo snapshot exists yet for ${label} in ${periodInfo.label}.`,
      by_territory: byTerritory,
      records: [],
    };
  }

  const current = Number(snapshot.currentValue);
  const lastWeek = snapshot.lastWeekValue !== null ? Number(snapshot.lastWeekValue) : null;

  return {
    current,
    target: Number(snapshot.targetValue),
    last_week: lastWeek,
    trend: lastWeek !== null ? trendOf(current, lastWeek) : null,
    status: snapshot.status,
    data_status: "DEMO",
    data_source: "Demo data: seeded quarterly snapshot (not a live CRM sync)",
    last_updated: snapshot.createdAt.toISOString(),
    what_changed: snapshot.whatChanged,
    explanation: snapshot.explanation,
    by_territory: byTerritory,
    records: [],
  };
}

async function computeManual(metricKey: string, periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const split = splitPeriodKey(periodKey);
  const rows = await db.select().from(manualMetricValuesTable).where(eq(manualMetricValuesTable.metricKey, metricKey));
  const periodRows = split ? rows.filter((r) => r.period === split.quarterKey && r.year === split.year) : [];
  const allTerritories = await db.select().from(territoriesTable);

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => {
    const row = periodRows.find((r) => r.territoryId === t.id);
    return { territory_id: t.id, territory_name: t.name, value: row ? Number(row.currentValue) : 0 };
  });

  const match = target.territoryId
    ? periodRows.find((r) => r.territoryId === target.territoryId)
    : periodRows.find((r) => r.territoryId === null);

  if (!match) {
    return {
      current: null,
      target: null,
      last_week: null,
      trend: null,
      status: null,
      data_status: "NOT_CONNECTED",
      data_source: null,
      last_updated: null,
      what_changed: null,
      explanation: `No manual value has been entered yet for this metric/period/territory.`,
      by_territory: byTerritory,
      records: [],
    };
  }

  return {
    current: Number(match.currentValue),
    target: match.targetValue !== null ? Number(match.targetValue) : null,
    last_week: null,
    trend: null,
    status: null,
    data_status: "MANUAL",
    data_source: "Manual entry (Admin > Connections & data > Metric setup)",
    last_updated: match.updatedAt.toISOString(),
    what_changed: null,
    explanation: match.note,
    by_territory: byTerritory,
    records: [],
  };
}

function notConnected(reason: string): KpiComputation {
  return {
    current: null,
    target: null,
    last_week: null,
    trend: null,
    status: null,
    data_status: "NOT_CONNECTED",
    data_source: null,
    last_updated: null,
    what_changed: null,
    explanation: reason,
    by_territory: [],
    records: [],
  };
}

export async function getEffectiveMapping(metricKey: string) {
  const [mapping] = await db.select().from(metricMappingsTable).where(eq(metricMappingsTable.metricKey, metricKey));
  if (mapping) return mapping;
  const def = METRIC_BY_KEY.get(metricKey);
  return {
    id: "",
    metricKey,
    sourceType: (def?.defaultSourceType ?? "NOT_CONNECTED") as SourceType,
    connectionId: null,
    mappingJson: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export interface MappingOverride {
  sourceType: SourceType;
  connectionId: string | null;
  mappingJson: Record<string, unknown> | null;
  active: boolean;
}

async function computeMetricFromSource(
  metricKey: string,
  periodKey: string,
  target: ResolvedTerritory,
  mapping: MappingOverride,
  targetOverride: number | null,
): Promise<KpiComputation> {
  switch (mapping.sourceType as SourceType) {
    case "PARTNER_RADAR":
      return computePartnerRadar(metricKey, periodKey, target, targetOverride);
    case "ACTIVITIES":
      return computeActivities(metricKey, target);
    case "DEMO":
      return computeDemo(metricKey, periodKey, target);
    case "MANUAL":
      return computeManual(metricKey, periodKey, target);
    case "HUBSPOT": {
      if (!mapping.connectionId) return notConnected("HubSpot source selected, but no connection is linked yet.");
      const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, mapping.connectionId));
      if (!conn || !hasCredential(conn.credentialEnvVar)) {
        return notConnected(`HubSpot connection is not configured (missing ${conn?.credentialEnvVar ?? "credential"}).`);
      }
      if (!mapping.mappingJson) return notConnected("HubSpot connection is configured, but this metric still needs mapping.");
      // A real HubSpot connection + mapping exists, but the live-call
      // implementation (services/hubspot.ts) intentionally throws until a
      // real integration is built -- report NOT_CONNECTED honestly instead
      // of fabricating a value.
      return notConnected("HubSpot connection and mapping are configured, but the live sync is not implemented yet.");
    }
    case "NOT_CONNECTED":
    default:
      return notConnected("This metric has no data source configured yet.");
  }
}

export async function computeMetric(
  metricKey: string,
  periodKey: string,
  target: ResolvedTerritory,
  override?: MappingOverride,
): Promise<KpiComputation> {
  const mapping = override ?? (await getEffectiveMapping(metricKey));

  if (!mapping.active) {
    return notConnected("This metric's mapping is currently disabled in Admin > Connections & data.");
  }

  const targetOverride = await getTargetOverride(metricKey, periodKey, target.territoryId);
  const c = await computeMetricFromSource(metricKey, periodKey, target, mapping, targetOverride);

  // metric_targets is the sole canonical target for every source type --
  // always wins, and an absent row always means null here, never a
  // fallback to whatever legacy target field the source computation
  // produced (kpi_snapshots.target_value for DEMO/past-period money
  // metrics, manual_metric_values.target_value for MANUAL). Never touches
  // how `current` above was computed.
  return { ...c, target: targetOverride };
}

export function reconcile(current: number | null, byTerritory: TerritoryContribution[]): { reconciles: boolean; note: string | null } {
  if (current === null || byTerritory.length === 0) return { reconciles: true, note: null };
  const sum = byTerritory.reduce((acc, t) => acc + t.value, 0);
  const tolerance = Math.max(1, Math.abs(current) * 0.01);
  if (Math.abs(sum - current) <= tolerance) return { reconciles: true, note: null };
  return {
    reconciles: false,
    note: `Data does not reconcile: territory total (${sum}) does not match reported total (${current}).`,
  };
}

export async function buildHeadOfChannelsData(periodKey: string, target: ResolvedTerritory, currency: SupportedCurrency = "USD") {
  const fx = await resolveFx(currency);
  const rate = fx.usd_to_currency_rate;

  const allMetrics = METRIC_REGISTRY;
  const devKeys = allMetrics.filter((m) => m.views.includes("partner_development"));
  const commercialKeys = allMetrics.filter((m) => m.views.includes("weekly_commercial"));
  const marketingKeys = allMetrics.filter((m) => m.views.includes("weekly_marketing"));

  const partnerDevelopment = await Promise.all(
    devKeys.map(async (def) => {
      const c = await computeMetric(def.key, periodKey, target);
      const money = isMoneyMetric(def.key);
      return {
        metric_key: def.key,
        metric: def.label,
        current: money ? convertMoney(c.current, rate) : c.current,
        target: money ? convertMoney(c.target, rate) : c.target,
        status: c.status,
        what_changed: c.what_changed,
        explanation: c.explanation,
        data_source: c.data_source,
        last_updated: c.last_updated,
        last_updated_is_synthetic: c.last_updated_is_synthetic ?? false,
        data_status: c.data_status,
      };
    }),
  );

  const weeklyCommercial = await Promise.all(
    commercialKeys.map(async (def) => {
      const c = await computeMetric(def.key, periodKey, target);
      const money = isMoneyMetric(def.key);
      return {
        metric_key: def.key,
        metric: def.label,
        current: money ? convertMoney(c.current, rate) : c.current,
        last_week: money ? convertMoney(c.last_week, rate) : c.last_week,
        target: money ? convertMoney(c.target, rate) : c.target,
        trend: c.trend,
        explanation: c.explanation,
        data_source: c.data_source,
        last_updated: c.last_updated,
        last_updated_is_synthetic: c.last_updated_is_synthetic ?? false,
        data_status: c.data_status,
      };
    }),
  );

  const weeklyMarketing = await Promise.all(
    marketingKeys.map(async (def) => {
      const c = await computeMetric(def.key, periodKey, target);
      return {
        metric_key: def.key,
        metric: def.label,
        this_week: c.current,
        last_week: c.last_week,
        trend: c.trend,
        explanation: c.explanation,
        data_source: c.data_source,
        last_updated: c.last_updated,
        last_updated_is_synthetic: c.last_updated_is_synthetic ?? false,
        data_status: c.data_status,
      };
    }),
  );

  return { partnerDevelopment, weeklyCommercial, weeklyMarketing, fx };
}

function targetToDate(periodKey: string, fullPeriodTarget: number | null): number | null {
  if (fullPeriodTarget === null) return null;
  const state = periodState(periodKey);
  if (state === "future") return 0;
  if (state === "past") return fullPeriodTarget;

  const periodInfo = resolvePeriodRange(periodKey);
  const startMs = new Date(periodInfo.start + "T00:00:00.000Z").getTime();
  const endMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();
  const todayEndMs = new Date(new Date().toISOString().slice(0, 10) + "T23:59:59.999Z").getTime();
  const totalDays = Math.round((endMs - startMs) / 86400000) + 1;
  const elapsedDays = Math.round((Math.min(todayEndMs, endMs) - startMs) / 86400000) + 1;
  const fraction = Math.min(1, Math.max(0, elapsedDays / totalDays));
  return fullPeriodTarget * fraction;
}

function fullPeriodTargetLabelFor(periodKey: string): "Full-quarter target" | "Full-year target" {
  return splitPeriodKey(periodKey)?.quarterKey === "ytd" ? "Full-year target" : "Full-quarter target";
}

function computeVariance(current: number | null, targetToDateValue: number | null): number | null {
  if (current === null || targetToDateValue === null) return null;
  return current - targetToDateValue;
}

// Exported so other read-time money-display code (e.g.
// services/campaignService.ts's linked pipeline/closed-revenue) reuses this
// exact USD->display-currency step instead of re-deriving it.
export function convertMoney(value: number | null, rate: number): number | null {
  return value === null ? null : value * rate;
}

// PAM contribution rows for a KPI detail view: territories.owner_user_id
// is the single authoritative PAM<->territory relationship (same source
// authz.ts uses for territory-scoped access), never a free-text field. A
// by_territory row with no real territory_id is dropped rather than
// emitted as a synthetic PAM row -- Global's aggregate total has no
// territory_id and must never masquerade as one.
async function buildPamContribution(byTerritory: TerritoryContribution[]): Promise<PamContribution[]> {
  const realRows = byTerritory.filter((r): r is TerritoryContribution & { territory_id: string } => r.territory_id !== null);
  if (realRows.length === 0) return [];

  const territoryIds = realRows.map((r) => r.territory_id);
  const territoryRows = await db.select().from(territoriesTable).where(inArray(territoriesTable.id, territoryIds));
  const ownerIds = territoryRows.map((t) => t.ownerUserId).filter((id): id is string => id !== null);
  const owners = ownerIds.length > 0 ? await db.select().from(usersTable).where(inArray(usersTable.id, ownerIds)) : [];

  const territoryById = new Map(territoryRows.map((t) => [t.id, t]));
  const ownerById = new Map(owners.map((u) => [u.id, u]));

  return realRows.map((r) => {
    const territory = territoryById.get(r.territory_id);
    const owner = territory?.ownerUserId ? ownerById.get(territory.ownerUserId) : undefined;
    return {
      pam_user_id: owner?.id ?? null,
      pam_name: owner?.name ?? null,
      territory_id: r.territory_id,
      territory_name: r.territory_name,
      value: r.value,
    };
  });
}

// Full drill-down detail for a single KPI. current/target/last_week/trend/
// status are passed through exactly as computeMetric produced them --
// never defaulted to 0/"amber"/"flat" -- matching the now-corrected
// KpiDetail/KpiRow/WeeklyKpiRow/MarketingKpiRow contracts, all of which
// treat "unavailable" as null, not a fabricated placeholder value.
// Shared core: assembles the full KPI detail shape from an *already
// resolved* FxInfo, so a caller building several metrics' details for the
// same report/request (e.g. the PPTX export) resolves FX exactly once and
// passes it in, rather than each metric independently calling resolveFx.
async function buildKpiDetailCore(metricKey: string, periodKey: string, target: ResolvedTerritory, fx: FxInfo) {
  const def = METRIC_BY_KEY.get(metricKey)!;
  const periodInfo = resolvePeriodRange(periodKey);
  const rate = fx.usd_to_currency_rate;
  const money = isMoneyMetric(metricKey);

  const c = await computeMetric(metricKey, periodKey, target);
  const { reconciles, note } = reconcile(c.current, c.by_territory);

  const fullPeriodTarget = c.target;
  const targetToDateValue = targetToDate(periodKey, fullPeriodTarget);
  const variance = computeVariance(c.current, targetToDateValue);
  const pamContribution = await buildPamContribution(c.by_territory);

  return {
    metric_key: def.key,
    metric: def.label,
    period: periodInfo.label,
    territory: target.territoryName,
    current: money ? convertMoney(c.current, rate) : c.current,
    target: money ? convertMoney(c.target, rate) : c.target,
    last_week: money ? convertMoney(c.last_week, rate) : c.last_week,
    trend: c.trend,
    status: c.status,
    data_status: c.data_status,
    data_source: c.data_source,
    last_updated: c.last_updated,
    what_changed: c.what_changed,
    explanation: c.explanation,
    by_territory: money ? c.by_territory.map((t) => ({ ...t, value: t.value * rate })) : c.by_territory,
    records: money ? c.records.map((r) => ({ ...r, value: r.value * rate })) : c.records,
    reconciles,
    reconciliation_note: note,
    target_to_date: money ? convertMoney(targetToDateValue, rate) : targetToDateValue,
    full_period_target: money ? convertMoney(fullPeriodTarget, rate) : fullPeriodTarget,
    full_period_target_label: fullPeriodTargetLabelFor(periodKey),
    variance: money ? convertMoney(variance, rate) : variance,
    pam_contribution: money ? pamContribution.map((p) => ({ ...p, value: p.value * rate })) : pamContribution,
    fx,
  };
}

export async function buildKpiDetail(metricKey: string, periodKey: string, target: ResolvedTerritory, currency: SupportedCurrency = "USD") {
  const fx = await resolveFx(currency);
  return buildKpiDetailCore(metricKey, periodKey, target, fx);
}

// For callers that already hold a resolved FxInfo (e.g. the PPTX export,
// which resolves FX once for the whole report via buildHeadOfChannelsData
// and reuses it across every metric's detail) -- never re-resolves FX.
export async function buildKpiDetailWithFx(metricKey: string, periodKey: string, target: ResolvedTerritory, fx: FxInfo) {
  return buildKpiDetailCore(metricKey, periodKey, target, fx);
}

export { resolvePeriodKey, resolvePeriodRange };
