import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubSpotDealPipeline, HubSpotPropertyHistoryEntry } from "../src/services/hubspot";
import {
  buildDealPipelineIndex,
  deriveDealState,
  normalizeDealHistory,
  parseHubSpotDate,
} from "../src/services/hubspotDealFacts";

function entry(value: string | null, timestamp: string, sourceType: string | null = null): HubSpotPropertyHistoryEntry {
  return { value, timestamp, sourceType, sourceId: null };
}

const PIPELINES: HubSpotDealPipeline[] = [
  {
    id: "default",
    label: "Sales",
    displayOrder: 0,
    archived: false,
    stages: [
      { id: "appointmentscheduled", label: "Appointment", displayOrder: 0, archived: false, metadata: { isClosed: "false", probability: "0.2" } },
      { id: "closedwon", label: "Closed won", displayOrder: 5, archived: false, metadata: { isClosed: "true", probability: "1.0" } },
      { id: "shared", label: "Shared A", displayOrder: 6, archived: false, metadata: { isClosed: null, probability: null } },
    ],
  },
  {
    id: "123",
    label: "Partners",
    displayOrder: 1,
    archived: false,
    stages: [
      { id: "456", label: "Partner intro", displayOrder: 0, archived: false, metadata: { isClosed: "false", probability: "0.1" } },
      { id: "shared", label: "Shared B", displayOrder: 1, archived: false, metadata: { isClosed: null, probability: null } },
    ],
  },
];

test("deriveDealState uses only explicit closed/won/lost flags", () => {
  const cases: Array<[Record<string, string | null | undefined>, string]> = [
    [{ hs_is_closed: "false", hs_is_closed_won: "false", hs_is_closed_lost: "false" }, "open"],
    [{ hs_is_closed: "false" }, "open"],
    [{ hs_is_closed: "true", hs_is_closed_won: "true", hs_is_closed_lost: "false" }, "closed_won"],
    [{ hs_is_closed: "true", hs_is_closed_won: "false", hs_is_closed_lost: "true" }, "closed_lost"],
    // won=false alone never implies lost
    [{ hs_is_closed: "true", hs_is_closed_won: "false", hs_is_closed_lost: "false" }, "closed_outcome_unknown"],
    [{ hs_is_closed: "true", hs_is_closed_won: "false" }, "closed_outcome_unknown"],
    // contradictions
    [{ hs_is_closed: "true", hs_is_closed_won: "true", hs_is_closed_lost: "true" }, "unknown"],
    [{ hs_is_closed: "false", hs_is_closed_won: "true" }, "unknown"],
    [{ hs_is_closed: "false", hs_is_closed_lost: "true" }, "unknown"],
    // missing / unparseable
    [{}, "unknown"],
    [{ hs_is_closed: null, hs_is_closed_won: "true" }, "unknown"],
    [{ hs_is_closed: "yes", hs_is_closed_won: "true" }, "unknown"],
  ];
  for (const [flags, expected] of cases) {
    assert.equal(deriveDealState(flags), expected, JSON.stringify(flags));
  }
});

test("pipeline index resolves across multiple pipelines and never manufactures labels", () => {
  const index = buildDealPipelineIndex(PIPELINES);

  assert.equal(index.resolvePipeline("default")?.label, "Sales");
  assert.equal(index.resolvePipeline("123")?.displayOrder, 1);
  assert.equal(index.resolvePipeline("999"), null);
  assert.equal(index.resolvePipeline(null), null);

  assert.deepEqual(index.resolveStage("456"), {
    id: "456",
    pipelineId: "123",
    label: "Partner intro",
    displayOrder: 0,
    archived: false,
    isClosed: "false",
    probability: "0.1",
  });
  assert.equal(index.resolveStage("closedwon", "default")?.label, "Closed won");
  assert.equal(index.resolveStage("closedwon", "123"), null);
  assert.equal(index.resolveStage("unknown-stage"), null);
  // Stage ID present in two pipelines: ambiguous without pipeline context.
  assert.equal(index.resolveStage("shared"), null);
  assert.equal(index.resolveStage("shared", "123")?.label, "Shared B");
});

test("parseHubSpotDate accepts ISO and epoch-ms values and rejects the rest", () => {
  assert.equal(parseHubSpotDate("2026-03-04T05:06:07.890Z"), "2026-03-04T05:06:07.890Z");
  assert.equal(parseHubSpotDate("2026-03-04T05:06:07+02:00"), "2026-03-04T03:06:07.000Z");
  assert.equal(parseHubSpotDate("2026-03-04"), "2026-03-04T00:00:00.000Z");
  assert.equal(parseHubSpotDate("1767225600000"), "2026-01-01T00:00:00.000Z");
  assert.equal(parseHubSpotDate(1767225600000), "2026-01-01T00:00:00.000Z");

  for (const invalid of [
    "",
    "   ",
    null,
    undefined,
    "not a date",
    "2026-02-31",
    "2026-03-04T05:06:07", // no zone: host-dependent
    "2026-03-04T25:00:00Z",
    "1767225600", // epoch seconds are not guessed
    "2026",
    Number.NaN,
    1.5,
  ]) {
    assert.equal(parseHubSpotDate(invalid), null, String(invalid));
  }
});

test("normalizeDealHistory produces chronological initial/changed/cleared events", () => {
  const index = buildDealPipelineIndex(PIPELINES);
  const events = normalizeDealHistory(
    {
      dealstage: [
        entry("closedwon", "2026-03-01T00:00:00.000Z", "CRM_UI"),
        entry("closedwon", "2026-02-15T00:00:00.000Z"),
        entry("unknown-stage", "2026-02-01T00:00:00.000Z"),
        entry("appointmentscheduled", "2026-01-01T00:00:00.000Z", "IMPORT"),
      ],
      amount: [
        entry("", "2026-02-10T00:00:00.000Z"),
        entry("1000", "2026-01-05T00:00:00.000Z"),
        entry(null, "2026-01-02T00:00:00.000Z"),
      ],
      closedate: [entry("2026-12-31", "not-a-timestamp")],
    },
    index,
  );

  assert.deepEqual(events, [
    {
      property: "dealstage",
      kind: "initial",
      previousValue: null,
      newValue: "appointmentscheduled",
      previousLabel: null,
      newLabel: "Appointment",
      changedAt: "2026-01-01T00:00:00.000Z",
      sourceType: "IMPORT",
    },
    {
      property: "amount",
      kind: "initial",
      previousValue: null,
      newValue: "1000",
      previousLabel: null,
      newLabel: null,
      changedAt: "2026-01-05T00:00:00.000Z",
      sourceType: null,
    },
    {
      property: "dealstage",
      kind: "changed",
      previousValue: "appointmentscheduled",
      newValue: "unknown-stage",
      previousLabel: "Appointment",
      newLabel: null,
      changedAt: "2026-02-01T00:00:00.000Z",
      sourceType: null,
    },
    {
      property: "amount",
      kind: "cleared",
      previousValue: "1000",
      newValue: null,
      previousLabel: null,
      newLabel: null,
      changedAt: "2026-02-10T00:00:00.000Z",
      sourceType: null,
    },
    {
      property: "dealstage",
      kind: "changed",
      previousValue: "unknown-stage",
      newValue: "closedwon",
      previousLabel: null,
      newLabel: "Closed won",
      changedAt: "2026-02-15T00:00:00.000Z",
      sourceType: null,
    },
  ]);
});

test("normalizeDealHistory orders identical timestamps by original provider index", () => {
  const history = {
    pipeline: [entry("default", "2026-01-01T00:00:00.000Z"), entry("123", "2026-01-01T00:00:00.000Z")],
    dealstage: [entry("456", "2026-01-01T00:00:00.000Z")],
  };
  const index = buildDealPipelineIndex(PIPELINES);
  const first = normalizeDealHistory(history, index);
  const second = normalizeDealHistory(history, index);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((event) => [event.property, event.kind, event.newValue, event.newLabel]),
    [
      ["pipeline", "initial", "default", "Sales"],
      ["pipeline", "changed", "123", "Partners"],
      ["dealstage", "initial", "456", "Partner intro"],
    ],
  );
});

test("normalizeDealHistory leaves labels null without a pipeline index", () => {
  const events = normalizeDealHistory({ dealstage: [entry("closedwon", "2026-01-01T00:00:00.000Z")] });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.newLabel, null);
  assert.equal(events[0]!.newValue, "closedwon");
});
