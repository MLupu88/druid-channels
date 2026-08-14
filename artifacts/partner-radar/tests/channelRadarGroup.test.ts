// Phase 10: pure unit tests for Channel Radar's "Group by entity" toggle
// and list pagination footer math -- no React rendering, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSignalsByEntity, computeListPageRange } from "../src/lib/channel-radar-group";

test("groupSignalsByEntity groups rows sharing the same entity_name together", () => {
  const rows = [
    { entity_name: "Acme Systems", id: "1" },
    { entity_name: "Contoso", id: "2" },
    { entity_name: "Acme Systems", id: "3" },
  ];
  const grouped = groupSignalsByEntity(rows);
  assert.equal(grouped.length, 2);
  const acme = grouped.find(([name]) => name === "Acme Systems")!;
  assert.deepEqual(acme[1].map((r) => r.id), ["1", "3"]);
});

test("groupSignalsByEntity sorts groups alphabetically by entity name, stable regardless of input order", () => {
  const rows = [
    { entity_name: "Zeta Corp", id: "1" },
    { entity_name: "Acme Systems", id: "2" },
    { entity_name: "Meridian", id: "3" },
  ];
  const grouped = groupSignalsByEntity(rows);
  assert.deepEqual(grouped.map(([name]) => name), ["Acme Systems", "Meridian", "Zeta Corp"]);
});

test("groupSignalsByEntity with an empty list returns no groups", () => {
  assert.deepEqual(groupSignalsByEntity([]), []);
});

test("groupSignalsByEntity preserves each row's original within-group order", () => {
  const rows = [
    { entity_name: "Acme Systems", id: "oldest" },
    { entity_name: "Acme Systems", id: "newest" },
  ];
  const [, group] = groupSignalsByEntity(rows)[0]!;
  assert.deepEqual(group.map((r) => r.id), ["oldest", "newest"]);
});

// Phase 10 fix: hasNextPage now requires the real server-side filtered
// total (computeListPageRange's 4th argument) rather than the old
// `rowCount === pageSize` heuristic, which could not tell "exactly one full
// page of matches" apart from "more than one page" -- see the exact-50 test
// below, which is the concrete case the audit flagged.

test("computeListPageRange: first page, partial fill -- range starts at 1, no next page", () => {
  const result = computeListPageRange(0, 50, 12, 12);
  assert.deepEqual(result, { start: 1, end: 12, hasPreviousPage: false, hasNextPage: false });
});

test("computeListPageRange: first page, a full page with MORE rows beyond it -- Next is enabled", () => {
  const result = computeListPageRange(0, 50, 50, 137);
  assert.deepEqual(result, { start: 1, end: 50, hasPreviousPage: false, hasNextPage: true });
});

test("computeListPageRange: EXACTLY 50 matching rows with PAGE_SIZE=50 must NOT enable Next -- the audited bug", () => {
  const result = computeListPageRange(0, 50, 50, 50);
  assert.equal(result.hasNextPage, false, "a full first page that IS the entire total must never claim there's a next page");
  assert.equal(result.end, 50);
});

test("computeListPageRange: second page range offsets correctly and disables Next when it exhausts the total", () => {
  const result = computeListPageRange(1, 50, 50, 100);
  assert.deepEqual(result, { start: 51, end: 100, hasPreviousPage: true, hasNextPage: false });
});

test("computeListPageRange: second page with more rows still beyond it keeps Next enabled", () => {
  const result = computeListPageRange(1, 50, 50, 137);
  assert.deepEqual(result, { start: 51, end: 100, hasPreviousPage: true, hasNextPage: true });
});

test("computeListPageRange: empty page (e.g. filters narrowed past the last page) reports a zero start and no next page", () => {
  const result = computeListPageRange(2, 50, 0, 100);
  assert.deepEqual(result, { start: 0, end: 100, hasPreviousPage: true, hasNextPage: false });
});

test("computeListPageRange: page 0 never has a previous page; page > 0 always does", () => {
  assert.equal(computeListPageRange(0, 50, 10, 10).hasPreviousPage, false);
  assert.equal(computeListPageRange(1, 50, 10, 60).hasPreviousPage, true);
});

test("computeListPageRange: total undefined (summary not loaded yet) never enables Next -- conservative, not 'assume more pages'", () => {
  const result = computeListPageRange(0, 50, 50, undefined);
  assert.equal(result.hasNextPage, false);
  assert.equal(result.end, 50, "end falls back to offset+rowCount when the real total isn't known yet");
});
