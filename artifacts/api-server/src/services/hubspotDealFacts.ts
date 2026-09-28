// Pure, deterministic helpers that turn raw HubSpot deal data into facts.
// No DB, no HubSpot calls, no PAM logic, no AI, no global state. Nothing here
// infers direction, risk, momentum, or predictions: stage display order and
// probability metadata are context only.

import type {
  HubSpotDealHistoryProperty,
  HubSpotDealPipeline,
  HubSpotPropertyHistoryEntry,
} from "./hubspot";

// ---------------------------------------------------------------------------
// Deal state
// ---------------------------------------------------------------------------

export type DealState = "open" | "closed_won" | "closed_lost" | "closed_outcome_unknown" | "unknown";

export interface DealStateFlags {
  hs_is_closed?: string | null;
  hs_is_closed_won?: string | null;
  hs_is_closed_lost?: string | null;
}

function parseHubSpotBoolean(value: string | null | undefined): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

// Uses only the explicit HubSpot closed/won/lost flags. `hs_is_closed_won =
// false` is never treated as lost.
export function deriveDealState(flags: DealStateFlags): DealState {
  const closed = parseHubSpotBoolean(flags.hs_is_closed);
  const won = parseHubSpotBoolean(flags.hs_is_closed_won);
  const lost = parseHubSpotBoolean(flags.hs_is_closed_lost);

  if (closed === null) return "unknown";
  if (won === true && lost === true) return "unknown";
  if (closed === false) return won === true || lost === true ? "unknown" : "open";
  if (won === true) return "closed_won";
  if (lost === true) return "closed_lost";
  return "closed_outcome_unknown";
}

// ---------------------------------------------------------------------------
// Pipeline / stage index
// ---------------------------------------------------------------------------

export interface DealPipelineInfo {
  id: string;
  label: string | null;
  displayOrder: number | null;
  archived: boolean | null;
}

export interface DealStageInfo {
  id: string;
  pipelineId: string;
  label: string | null;
  displayOrder: number | null;
  archived: boolean | null;
  isClosed: string | null;
  probability: string | null;
}

export interface DealPipelineIndex {
  resolvePipeline(pipelineId: string | null | undefined): DealPipelineInfo | null;
  // With a pipeline ID, only that pipeline is searched. Without one, a stage
  // resolves only if its ID is unique across all pipelines.
  resolveStage(stageId: string | null | undefined, pipelineId?: string | null): DealStageInfo | null;
}

export function buildDealPipelineIndex(pipelines: readonly HubSpotDealPipeline[]): DealPipelineIndex {
  const pipelinesById = new Map<string, DealPipelineInfo>();
  const stagesByPipeline = new Map<string, Map<string, DealStageInfo>>();
  const stagesById = new Map<string, DealStageInfo[]>();

  for (const pipeline of pipelines) {
    if (pipelinesById.has(pipeline.id)) continue;
    pipelinesById.set(pipeline.id, {
      id: pipeline.id,
      label: pipeline.label,
      displayOrder: pipeline.displayOrder,
      archived: pipeline.archived,
    });
    const stages = new Map<string, DealStageInfo>();
    for (const stage of pipeline.stages) {
      if (stages.has(stage.id)) continue;
      const info: DealStageInfo = {
        id: stage.id,
        pipelineId: pipeline.id,
        label: stage.label,
        displayOrder: stage.displayOrder,
        archived: stage.archived,
        isClosed: stage.metadata.isClosed,
        probability: stage.metadata.probability,
      };
      stages.set(stage.id, info);
      stagesById.set(stage.id, [...(stagesById.get(stage.id) ?? []), info]);
    }
    stagesByPipeline.set(pipeline.id, stages);
  }

  return {
    resolvePipeline(pipelineId) {
      if (!pipelineId) return null;
      return pipelinesById.get(pipelineId) ?? null;
    },
    resolveStage(stageId, pipelineId) {
      if (!stageId) return null;
      if (pipelineId) return stagesByPipeline.get(pipelineId)?.get(stageId) ?? null;
      const matches = stagesById.get(stageId) ?? [];
      return matches.length === 1 ? matches[0]! : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
// 12–15 digits: epoch milliseconds from 1973 onward. Shorter integers (years,
// epoch seconds) are rejected rather than misread as milliseconds.
const EPOCH_MS = /^\d{12,15}$/;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Returns an ISO-8601 UTC string, or null when the value cannot be parsed
// safely. Accepts ISO dates, ISO timestamps with an explicit zone, and epoch
// milliseconds (number or digit string). Zone-less timestamps are rejected
// because their meaning depends on the host time zone.
export function parseHubSpotDate(value: unknown): string | null {
  let ms: number;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || !EPOCH_MS.test(String(value))) return null;
    ms = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (EPOCH_MS.test(trimmed)) {
      ms = Number(trimmed);
    } else {
      const match = ISO_DATE.exec(trimmed);
      if (!match) return null;
      const [, y, mo, d, h, mi, s] = match;
      if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;
      if (h !== undefined && (Number(h) > 23 || Number(mi) > 59 || Number(s ?? "0") > 59)) return null;
      ms = Date.parse(trimmed);
    }
  } else {
    return null;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type DealHistoryEventKind = "initial" | "changed" | "cleared";

export interface DealHistoryEvent {
  property: HubSpotDealHistoryProperty;
  kind: DealHistoryEventKind;
  previousValue: string | null;
  newValue: string | null;
  previousLabel: string | null;
  newLabel: string | null;
  changedAt: string;
  sourceType: string | null;
}

const HISTORY_PROPERTY_ORDER: readonly HubSpotDealHistoryProperty[] = [
  "pipeline",
  "dealstage",
  "amount",
  "deal_currency_code",
  "closedate",
  "hubspot_owner_id",
];

function labelFor(
  property: HubSpotDealHistoryProperty,
  value: string | null,
  index: DealPipelineIndex | null,
): string | null {
  if (!index || value === null) return null;
  if (property === "pipeline") return index.resolvePipeline(value)?.label ?? null;
  if (property === "dealstage") return index.resolveStage(value)?.label ?? null;
  return null;
}

// Produces factual change events in ascending chronological order. Identical
// timestamps are ordered by original provider array index purely for
// determinism; no ordering semantic is implied. Entries whose timestamp cannot
// be parsed are dropped rather than guessed.
export function normalizeDealHistory(
  history: Partial<Record<HubSpotDealHistoryProperty, readonly HubSpotPropertyHistoryEntry[]>>,
  pipelineIndex: DealPipelineIndex | null = null,
): DealHistoryEvent[] {
  const events: Array<{ event: DealHistoryEvent; ms: number; propertyRank: number; sequence: number }> = [];

  HISTORY_PROPERTY_ORDER.forEach((property, propertyRank) => {
    const entries = history[property] ?? [];
    const timed = entries
      .flatMap((entry, position) => {
        const changedAt = parseHubSpotDate(entry.timestamp);
        return changedAt === null ? [] : [{ entry, changedAt, ms: Date.parse(changedAt), position }];
      })
      .sort((a, b) => a.ms - b.ms || a.position - b.position);

    let current: string | null = null;
    let sequence = 0;
    for (const { entry, changedAt, ms } of timed) {
      const value = entry.value !== null && entry.value.trim() !== "" ? entry.value : null;
      let kind: DealHistoryEventKind;
      if (value === null) {
        if (current === null) continue;
        kind = "cleared";
      } else {
        if (value === current) continue;
        kind = current === null && sequence === 0 ? "initial" : "changed";
      }
      events.push({
        event: {
          property,
          kind,
          previousValue: current,
          newValue: value,
          previousLabel: labelFor(property, current, pipelineIndex),
          newLabel: labelFor(property, value, pipelineIndex),
          changedAt,
          sourceType: entry.sourceType,
        },
        ms,
        propertyRank,
        sequence,
      });
      current = value;
      sequence += 1;
    }
  });

  return events
    .sort((a, b) => a.ms - b.ms || a.propertyRank - b.propertyRank || a.sequence - b.sequence)
    .map(({ event }) => event);
}
