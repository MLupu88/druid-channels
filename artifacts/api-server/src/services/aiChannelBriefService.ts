import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { aiChannelBriefsTable, type AiChannelBriefContent } from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
import { buildHeadOfChannelsData, PERIODS, type ResolvedTerritory } from "./kpiService";
import type { SupportedCurrency } from "./fx";
import * as aiBriefProvider from "./aiBriefProvider";
import { logger } from "../lib/logger";

// Owns everything aiBriefProvider.ts deliberately doesn't: building the
// snapshot from the same trusted KPI computation layer Overview/PPTX use,
// deciding which metrics are evidence-eligible, the generation-input hash,
// freshness derivation, and the cache read/write. aiBriefProvider.ts only
// ever sees an already-filtered, already-labeled snapshot.

// Exactly the DataStatus values kpiService.ts defines -- CONNECTED and
// MANUAL are real/legitimate data; DEMO and NOT_CONNECTED must never
// support an AI conclusion or count toward freshness/staleness.
const ELIGIBLE_DATA_STATUSES = new Set(["CONNECTED", "MANUAL"]);

function isEligible(dataStatus: string): boolean {
  return ELIGIBLE_DATA_STATUSES.has(dataStatus);
}

type Section = aiBriefProvider.AiBriefMetricSnapshot["section"];

export function toMetricSnapshot(section: Section, row: any): aiBriefProvider.AiBriefMetricSnapshot {
  return {
    section,
    metric_key: row.metric_key,
    metric: row.metric,
    current: (section === "channel_activity" ? row.this_week : row.current) ?? null,
    target: row.target ?? null,
    status: row.status ?? null,
    trend: row.trend ?? null,
    data_status: row.data_status,
    data_source: row.data_source ?? null,
    // A synthetic (wall-clock fallback) timestamp is not a fact about the
    // data -- normalize it to null here so it never enters the generation
    // hash, never feeds data_as_of, and is never presented to the AI
    // provider as if it were a real freshness claim.
    last_updated: row.last_updated_is_synthetic ? null : (row.last_updated ?? null),
  };
}

// The full Overview snapshot -- every metric, every data_status. Only the
// eligible subset (see filterEligible) is ever hashed, sent to the
// provider, or used to derive data_as_of.
async function buildFullMetrics(
  periodKey: string,
  target: ResolvedTerritory,
  currency: SupportedCurrency,
): Promise<aiBriefProvider.AiBriefMetricSnapshot[]> {
  const { partnerDevelopment, weeklyCommercial, weeklyMarketing } = await buildHeadOfChannelsData(periodKey, target, currency);
  return [
    ...partnerDevelopment.map((r) => toMetricSnapshot("channel_kpi", r)),
    ...weeklyCommercial.map((r) => toMetricSnapshot("pipeline_revenue", r)),
    ...weeklyMarketing.map((r) => toMetricSnapshot("channel_activity", r)),
  ];
}

function filterEligible(metrics: aiBriefProvider.AiBriefMetricSnapshot[]): aiBriefProvider.AiBriefMetricSnapshot[] {
  return metrics.filter((m) => isEligible(m.data_status));
}

// Generation-input hash: period + exact territory scope + currency + the
// sorted/normalized EVIDENCE-ELIGIBLE metrics only. A DEMO value/timestamp
// changing must never make a real brief look stale; a metric crossing the
// eligible/ineligible boundary does change the hash (it entered or left the
// actual generation input).
function canonicalizeForHash(periodKey: string, territoryId: string | null, currency: string, eligible: aiBriefProvider.AiBriefMetricSnapshot[]): string {
  const sorted = [...eligible]
    .sort((a, b) => (a.section === b.section ? a.metric_key.localeCompare(b.metric_key) : a.section.localeCompare(b.section)))
    .map((m) => ({
      section: m.section,
      metric_key: m.metric_key,
      metric: m.metric,
      current: m.current ?? null,
      target: m.target ?? null,
      status: m.status ?? null,
      trend: m.trend ?? null,
      data_status: m.data_status,
      data_source: m.data_source ?? null,
      last_updated: m.last_updated ?? null,
    }));
  return JSON.stringify({ period: periodKey, territory_id: territoryId ?? "global", currency, metrics: sorted });
}

export function computeGenerationInputHash(periodKey: string, territoryId: string | null, currency: string, eligible: aiBriefProvider.AiBriefMetricSnapshot[]): string {
  return createHash("sha256").update(canonicalizeForHash(periodKey, territoryId, currency, eligible)).digest("hex");
}

// Only from eligible metrics -- a DEMO metric's timestamp must never make
// real channel data appear fresher than it is. Never substitutes generatedAt.
function deriveDataAsOf(eligible: aiBriefProvider.AiBriefMetricSnapshot[]): string | null {
  const valid = eligible.map((m) => m.last_updated).filter((ts): ts is string => !!ts && !Number.isNaN(new Date(ts).getTime()));
  if (valid.length === 0) return null;
  return valid.reduce((max, ts) => (new Date(ts) > new Date(max) ? ts : max));
}

async function fetchCachedRow(periodKey: string, territoryId: string | null, currency: string) {
  const scopeFilter = territoryId ? eq(aiChannelBriefsTable.territoryId, territoryId) : isNull(aiChannelBriefsTable.territoryId);
  const [row] = await db
    .select()
    .from(aiChannelBriefsTable)
    .where(and(eq(aiChannelBriefsTable.period, periodKey), eq(aiChannelBriefsTable.currency, currency), scopeFilter));
  return row;
}

async function upsertBrief(input: {
  periodKey: string;
  territoryId: string | null;
  currency: string;
  content: AiChannelBriefContent;
  snapshotHash: string;
  dataAsOf: string | null;
  requestedByUserId: string;
}) {
  const now = new Date();
  const values = {
    period: input.periodKey,
    territoryId: input.territoryId,
    currency: input.currency,
    content: input.content,
    snapshotHash: input.snapshotHash,
    dataAsOf: input.dataAsOf ? new Date(input.dataAsOf) : null,
    generatedAt: now,
    requestedByUserId: input.requestedByUserId,
    updatedAt: now,
  };
  const updateSet = {
    content: values.content,
    snapshotHash: values.snapshotHash,
    dataAsOf: values.dataAsOf,
    generatedAt: values.generatedAt,
    requestedByUserId: values.requestedByUserId,
    updatedAt: values.updatedAt,
  };

  // Same atomic INSERT .. ON CONFLICT .. DO UPDATE pattern as metric_targets
  // -- no select-then-write race window.
  const [saved] = input.territoryId
    ? await db
        .insert(aiChannelBriefsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [aiChannelBriefsTable.period, aiChannelBriefsTable.territoryId, aiChannelBriefsTable.currency],
          set: updateSet,
        })
        .returning()
    : await db
        .insert(aiChannelBriefsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [aiChannelBriefsTable.period, aiChannelBriefsTable.currency],
          targetWhere: sql`${aiChannelBriefsTable.territoryId} is null`,
          set: updateSet,
        })
        .returning();
  return saved!;
}

function classifyAiBriefError(err: unknown): string {
  if (err instanceof aiBriefProvider.AiBriefNotConfiguredError) return "AI provider is not connected.";
  if (err instanceof aiBriefProvider.AiBriefProviderError) {
    if (err.code === "timeout") return "The AI provider did not respond in time. Please try again.";
    if (err.code === "network_error" || err.code === "http_error") return "Could not reach the AI provider. Please try again.";
    return "The AI provider returned an unusable response. Please try again.";
  }
  return "The AI channel brief could not be generated. Please try again.";
}

export type BriefState = "never_generated" | "ready" | "stale" | "insufficient_data";

export interface BriefStateResult {
  state: BriefState;
  providerStatus: "configured" | "not_configured";
  canRegenerate: boolean;
  periodLabel: string;
  territoryName: string;
  currency: string;
  content: AiChannelBriefContent | null;
  dataAsOf: string | null;
  generatedAt: string | null;
}

// Cache/content state (state, content) is fully independent of provider
// availability (providerStatus): a previously generated brief remains
// readable even if AI_PROVIDER/AI_API_KEY are later removed.
export async function getBriefState(periodKey: string, target: ResolvedTerritory, currency: SupportedCurrency): Promise<BriefStateResult> {
  const periodInfo = PERIODS[periodKey];
  const allMetrics = await buildFullMetrics(periodKey, target, currency);
  const eligible = filterEligible(allMetrics);
  const currentHash = computeGenerationInputHash(periodKey, target.territoryId, currency, eligible);

  const [cached, providerConfigured] = await Promise.all([
    fetchCachedRow(periodKey, target.territoryId, currency),
    aiBriefProvider.isConfigured(),
  ]);

  let state: BriefState;
  if (cached) {
    state = cached.snapshotHash === currentHash ? "ready" : "stale";
  } else if (eligible.length === 0) {
    state = "insufficient_data";
  } else {
    state = "never_generated";
  }

  return {
    state,
    providerStatus: providerConfigured ? "configured" : "not_configured",
    canRegenerate: providerConfigured && eligible.length > 0,
    periodLabel: periodInfo.label,
    territoryName: target.territoryName,
    currency,
    content: cached?.content ?? null,
    dataAsOf: cached?.dataAsOf ? cached.dataAsOf.toISOString() : null,
    generatedAt: cached?.generatedAt ? cached.generatedAt.toISOString() : null,
  };
}

export type RegenerateOutcome = { ok: true; result: BriefStateResult } | { ok: false; status: number; error: string };

export async function regenerateBrief(
  periodKey: string,
  target: ResolvedTerritory,
  currency: SupportedCurrency,
  requestedByUserId: string,
): Promise<RegenerateOutcome> {
  const periodInfo = PERIODS[periodKey];
  const providerConfigured = await aiBriefProvider.isConfigured();
  if (!providerConfigured) {
    return { ok: false, status: 400, error: "AI provider is not connected." };
  }

  const allMetrics = await buildFullMetrics(periodKey, target, currency);
  const eligible = filterEligible(allMetrics);

  if (eligible.length === 0) {
    // Do not call DeepSeek, do not write anything. A previously generated
    // brief must survive its evidence disappearing -- it becomes stale, not
    // erased. Only report insufficient_data when there was never a brief.
    const cached = await fetchCachedRow(periodKey, target.territoryId, currency);

    if (cached) {
      return {
        ok: true,
        result: {
          state: "stale",
          providerStatus: "configured",
          canRegenerate: false,
          periodLabel: periodInfo.label,
          territoryName: target.territoryName,
          currency,
          content: cached.content,
          dataAsOf: cached.dataAsOf ? cached.dataAsOf.toISOString() : null,
          generatedAt: cached.generatedAt.toISOString(),
        },
      };
    }

    return {
      ok: true,
      result: {
        state: "insufficient_data",
        providerStatus: "configured",
        canRegenerate: false,
        periodLabel: periodInfo.label,
        territoryName: target.territoryName,
        currency,
        content: null,
        dataAsOf: null,
        generatedAt: null,
      },
    };
  }

  const dataAsOf = deriveDataAsOf(eligible);
  const snapshot: aiBriefProvider.ChannelBriefSnapshot = {
    period: periodInfo.label,
    territoryId: target.territoryId,
    territoryName: target.territoryName,
    currency,
    dataAsOf,
    metrics: eligible,
  };

  let content: AiChannelBriefContent;
  try {
    content = await aiBriefProvider.generate(snapshot);
  } catch (err) {
    logger.error(
      {
        period: periodKey,
        territoryId: target.territoryId,
        currency,
        errorCode: err instanceof aiBriefProvider.AiBriefProviderError ? err.code : err instanceof Error ? err.name : "unknown",
      },
      "AI channel brief generation failed",
    );
    return { ok: false, status: 502, error: classifyAiBriefError(err) };
  }

  const snapshotHash = computeGenerationInputHash(periodKey, target.territoryId, currency, eligible);
  const saved = await upsertBrief({
    periodKey,
    territoryId: target.territoryId,
    currency,
    content,
    snapshotHash,
    dataAsOf,
    requestedByUserId,
  });

  return {
    ok: true,
    result: {
      state: "ready",
      providerStatus: "configured",
      canRegenerate: true,
      periodLabel: periodInfo.label,
      territoryName: target.territoryName,
      currency,
      content: saved.content,
      dataAsOf: saved.dataAsOf ? saved.dataAsOf.toISOString() : null,
      generatedAt: saved.generatedAt.toISOString(),
    },
  };
}
