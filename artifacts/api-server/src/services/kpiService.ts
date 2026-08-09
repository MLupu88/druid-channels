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
} from "@workspace/db";
import { eq, and, isNull, gte, lte, inArray, desc } from "drizzle-orm";
import { METRIC_BY_KEY, METRIC_REGISTRY, PERIODS, resolvePeriodKey, isMoneyMetric, type SourceType } from "./kpiRegistry";
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

export async function ensureMetricMappingsSeeded(): Promise<void> {
  const existing = await db.select().from(metricMappingsTable);
  const existingKeys = new Set(existing.map((m) => m.metricKey));
  const missing = METRIC_REGISTRY.filter((m) => !existingKeys.has(m.key));
  if (missing.length === 0) return;
  await db.insert(metricMappingsTable).values(
    missing.map((m) => ({
      metricKey: m.key,
      sourceType: m.defaultSourceType,
      active: true,
      mappingJson: null,
    })),
  );
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
export async function getTargetOverride(metricKey: string, periodKey: string, territoryId: string | null): Promise<number | null> {
  const scopeFilter = territoryId ? eq(metricTargetsTable.territoryId, territoryId) : isNull(metricTargetsTable.territoryId);
  const [row] = await db
    .select()
    .from(metricTargetsTable)
    .where(and(eq(metricTargetsTable.metricKey, metricKey), eq(metricTargetsTable.period, periodKey), scopeFilter));
  return row ? Number(row.targetValue) : null;
}

// targetOverride, when provided, is authoritative for both the returned
// target and the status banding derived from it -- this is the only
// PARTNER_RADAR computation that self-derives a status from its target, so
// threading the override in here (rather than only patching `target` after
// the fact) keeps status and target consistent in one pass.
async function computeNewPartnerProspects(periodKey: string, target: ResolvedTerritory, targetOverride?: number | null): Promise<KpiComputation> {
  const periodInfo = PERIODS[periodKey];
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
// the previous calendar week, clamped to the period's own end.
async function computeSignedPartners(periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = PERIODS[periodKey];
  const allTerritories = await db.select().from(territoriesTable);
  const allProspects = await db.select().from(prospectsTable);

  const periodStartMs = new Date(periodInfo.start).getTime();
  const periodEndMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();

  const isEligibleThrough = (p: (typeof allProspects)[number], endMs: number) => {
    if (p.status !== "accepted" && p.status !== "pushed_to_hubspot") return false;
    if (p.acceptedAt === null) return false;
    const acceptedMs = new Date(p.acceptedAt as unknown as string).getTime();
    return acceptedMs >= periodStartMs && acceptedMs <= endMs;
  };

  const eligible = allProspects.filter((p) => isEligibleThrough(p, effectiveAsOfMs(periodKey)));

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
    .map((p) => ({
      label: `Prospect ${p.id.slice(0, 8)} (${p.status})`,
      value: 1,
      date: new Date(p.acceptedAt as unknown as string).toISOString(),
    }));

  const lastWeekEndMs = Math.min(periodEndMs, endOfPreviousCalendarWeek(new Date()).getTime());
  const lastWeekEligible = allProspects.filter((p) => isEligibleThrough(p, lastWeekEndMs));
  const lastWeekScoped = target.territoryId
    ? lastWeekEligible.filter((p) => p.territoryId === target.territoryId)
    : lastWeekEligible;

  return {
    current: scoped.length,
    target: null,
    last_week: lastWeekScoped.length,
    trend: trendOf(scoped.length, lastWeekScoped.length),
    status: null,
    data_status: "CONNECTED",
    data_source: "Live: prospects table, accepted/pushed_to_hubspot prospects with accepted_at inside the selected period, through the effective as-of date",
    last_updated: (mostRecentUpdated ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecentUpdated === null,
    what_changed: null,
    explanation: `${scoped.length} partner${scoped.length === 1 ? "" : "s"} signed (accepted or pushed to HubSpot) in ${periodInfo.label} for ${target.territoryName}, based on accepted_at.`,
    by_territory: byTerritory,
    records,
  };
}

// Renewals (locked semantics): count, never money. Current = cumulative
// count of renewal_date inside the selected period through the effective
// as-of date, mirroring signed_partners. last_updated reflects the
// underlying prospect rows' own updated_at, not request time. Last Week is
// the same cumulative count through the end of the previous calendar week,
// clamped to the period's own end.
async function computeRenewals(periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = PERIODS[periodKey];
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

  const lastWeekEndStr = minDateStr(periodInfo.end, endOfPreviousCalendarWeek(new Date()).toISOString().slice(0, 10));
  const lastWeekEligible = allProspects.filter((p) => inRange(p.renewalDate, lastWeekEndStr));
  const lastWeekScoped = target.territoryId
    ? lastWeekEligible.filter((p) => p.territoryId === target.territoryId)
    : lastWeekEligible;

  return {
    current: scoped.length,
    target: null,
    last_week: lastWeekScoped.length,
    trend: trendOf(scoped.length, lastWeekScoped.length),
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

export const CURRENT_STATE_FIELD_BY_KEY: Record<string, "pipelineSourced" | "pipelineInfluenced" | "revenueClosed"> = {
  partner_sourced_pipeline: "pipelineSourced",
  partner_influenced_pipeline: "pipelineInfluenced",
  closed_revenue: "revenueClosed",
};

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
  const periodInfo = PERIODS[periodKey];
  const periodEndMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();
  return Math.min(periodEndMs, Date.now());
}

function effectiveAsOfDateStr(periodKey: string): string {
  const periodInfo = PERIODS[periodKey];
  const todayStr = new Date().toISOString().slice(0, 10);
  return minDateStr(periodInfo.end, todayStr);
}

// Where a reporting period sits relative to today. Drives the 3 current-
// state money metrics' dispatch: only an "active" period may show today's
// live total; a "past" period reads a persisted snapshot; a "future"
// period is honestly unavailable rather than either of those.
function periodState(periodKey: string): "past" | "active" | "future" {
  const periodInfo = PERIODS[periodKey];
  const todayStr = new Date().toISOString().slice(0, 10);
  if (todayStr < periodInfo.start) return "future";
  if (todayStr > periodInfo.end) return "past";
  return "active";
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

// partner_sourced_pipeline / partner_influenced_pipeline / closed_revenue
// (locked semantics): current-state numeric fields with no historical audit
// trail, restricted to accepted/pushed_to_hubspot prospects only (new/
// rejected/deferred prospects never contribute to a commercial partner
// total). This is the *live* value, valid only when
// periodState(periodKey) === "active". Last Week always comes from the
// previous week's persisted snapshot, never computed live -- these fields
// have no audit trail to recompute a past value from.
// Shared eligibility rule for the 3 current-state money metrics: accepted
// or pushed_to_hubspot only. Exported so the weekly snapshot writer uses
// this exact same rule rather than a second, potentially-drifting copy.
export function isEligibleForCurrentState(p: { status: string }): boolean {
  return p.status === "accepted" || p.status === "pushed_to_hubspot";
}

async function computeCurrentStateLive(metricKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const field = CURRENT_STATE_FIELD_BY_KEY[metricKey];
  const label = METRIC_BY_KEY.get(metricKey)!.label;
  const allTerritories = await db.select().from(territoriesTable);
  const allProspects = await db.select().from(prospectsTable);

  const eligible = allProspects.filter(isEligibleForCurrentState);

  const valueOf = (p: (typeof eligible)[number]) => {
    const raw = p[field];
    return raw !== null ? Number(raw) : 0;
  };

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: eligible.filter((p) => p.territoryId === t.id).reduce((sum, p) => sum + valueOf(p), 0),
  }));

  const scoped = target.territoryId ? eligible.filter((p) => p.territoryId === target.territoryId) : eligible;
  const current = scoped.reduce((sum, p) => sum + valueOf(p), 0);

  const mostRecentUpdated = scoped.reduce<Date | null>((latest, p) => {
    const updated = new Date(p.updatedAt as unknown as string);
    return !latest || updated > latest ? updated : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped
    .filter((p) => valueOf(p) !== 0)
    .slice(0, 100)
    .map((p) => ({ label: `Prospect ${p.id.slice(0, 8)}`, value: valueOf(p), date: null }));

  const lastWeek = await previousWeekSnapshotValue(label, target.territoryId, mondayOf(new Date()));

  return {
    current,
    target: null,
    last_week: lastWeek,
    trend: lastWeek !== null ? trendOf(current, lastWeek) : null,
    status: null,
    data_status: "CONNECTED",
    data_source: `Live: prospects table, accepted/pushed_to_hubspot prospects' current-state total of ${label.toLowerCase()} across ${target.territoryName} (not period-filtered -- this field has no historical audit trail)`,
    last_updated: (mostRecentUpdated ?? new Date()).toISOString(),
    last_updated_is_synthetic: mostRecentUpdated === null,
    what_changed: null,
    explanation: `Current live total for ${label} in ${target.territoryName}, as of now, across accepted/pushed-to-HubSpot partners.`,
    by_territory: byTerritory,
    records,
  };
}

// partner_sourced_pipeline / partner_influenced_pipeline / closed_revenue,
// for a "past" period: the live current-state total cannot honestly be
// labeled as that period's value, so this reads the latest weekly
// kpi_snapshots row captured during that period instead. A territory with
// no snapshot in range is *omitted* from by_territory entirely -- a
// missing snapshot means unavailable, never zero. Returns NOT_CONNECTED
// (never a fabricated number) if the selected scope itself has no
// snapshot for that period.
async function computeCurrentStateFromSnapshot(
  metricKey: string,
  periodKey: string,
  target: ResolvedTerritory,
): Promise<KpiComputation> {
  const periodInfo = PERIODS[periodKey];
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

async function computePartnerRadar(metricKey: string, periodKey: string, target: ResolvedTerritory, targetOverride: number | null): Promise<KpiComputation> {
  switch (metricKey) {
    case "new_partner_prospects":
      return computeNewPartnerProspects(periodKey, target, targetOverride);
    case "signed_partners":
      return computeSignedPartners(periodKey, target);
    case "renewals":
      return computeRenewals(periodKey, target);
    case "partner_sourced_pipeline":
    case "partner_influenced_pipeline":
    case "closed_revenue": {
      const state = periodState(periodKey);
      if (state === "active") return computeCurrentStateLive(metricKey, target);
      if (state === "past") return computeCurrentStateFromSnapshot(metricKey, periodKey, target);
      // future
      return notConnected(
        "This reporting period has not started. Current-state commercial totals are not projected into a future period.",
      );
    }
    default:
      // A PARTNER_RADAR-mapped metric this service doesn't know how to
      // compute -- report it honestly as unsupported rather than
      // substituting another metric's data.
      return notConnected(`No PARTNER_RADAR computation is implemented for metric "${metricKey}".`);
  }
}

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
    data_source: `Live: activities table, calendar week ${toDateStr(thisWeekStart)} to ${toDateStr(thisWeekEnd)} vs prior week`,
    last_updated: now.toISOString(),
    last_updated_is_synthetic: true,
    what_changed: null,
    explanation: `${thisWeekValue} ${label.toLowerCase()} this week for ${target.territoryName}, vs ${lastWeekValue} last week.`,
    by_territory: byTerritory,
    records,
  };
}

async function computeDemo(metricKey: string, periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = PERIODS[periodKey];
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
  const rows = await db.select().from(manualMetricValuesTable).where(eq(manualMetricValuesTable.metricKey, metricKey));
  const periodRows = rows.filter((r) => r.period === periodKey);
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

  const periodInfo = PERIODS[periodKey];
  const startMs = new Date(periodInfo.start + "T00:00:00.000Z").getTime();
  const endMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();
  const todayEndMs = new Date(new Date().toISOString().slice(0, 10) + "T23:59:59.999Z").getTime();
  const totalDays = Math.round((endMs - startMs) / 86400000) + 1;
  const elapsedDays = Math.round((Math.min(todayEndMs, endMs) - startMs) / 86400000) + 1;
  const fraction = Math.min(1, Math.max(0, elapsedDays / totalDays));
  return fullPeriodTarget * fraction;
}

function fullPeriodTargetLabelFor(periodKey: string): "Full-quarter target" | "Full-year target" {
  return periodKey === "ytd" ? "Full-year target" : "Full-quarter target";
}

function computeVariance(current: number | null, targetToDateValue: number | null): number | null {
  if (current === null || targetToDateValue === null) return null;
  return current - targetToDateValue;
}

function convertMoney(value: number | null, rate: number): number | null {
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
  const periodInfo = PERIODS[periodKey];
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

export { resolvePeriodKey, PERIODS };
