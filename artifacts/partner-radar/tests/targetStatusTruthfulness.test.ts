// 5B.2: target status "unavailable" (a valid target exists but the actual
// value is unavailable -- never interpreted as zero) must render neutrally
// on every frontend target surface, never with the amber/red performance
// styling used for "behind". Pure checks on the Weekly Team aggregate plus
// source-text boundaries on the four surfaces -- same convention as
// tests/teamCommercialRollup.test.ts; this project has no React rendering
// harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { aggregateTargetLabel } from "../src/components/weekly-team-target-label";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf-8");

// ---- Weekly Team aggregate precedence -------------------------------------

const t = (status: "ahead" | "behind" | "no_target" | "unavailable") => ({ status });

test("aggregateTargetLabel: any behind -> behind, even alongside unavailable/ahead/no_target", () => {
  assert.equal(aggregateTargetLabel([t("ahead"), t("unavailable"), t("behind"), t("no_target")]), "behind");
});

test("aggregateTargetLabel: ahead + unavailable -> unavailable, never summarized as fully ahead", () => {
  assert.equal(aggregateTargetLabel([t("ahead"), t("unavailable")]), "unavailable");
});

test("aggregateTargetLabel: only unavailable (with or without no_target) -> unavailable", () => {
  assert.equal(aggregateTargetLabel([t("unavailable")]), "unavailable");
  assert.equal(aggregateTargetLabel([t("no_target"), t("unavailable")]), "unavailable");
});

test("aggregateTargetLabel: ahead (with no_target) -> ahead", () => {
  assert.equal(aggregateTargetLabel([t("ahead"), t("no_target")]), "ahead");
});

test("aggregateTargetLabel: only no_target, or no territories -> no_target", () => {
  assert.equal(aggregateTargetLabel([t("no_target")]), "no_target");
  assert.equal(aggregateTargetLabel([]), "no_target");
});

// ---- The four target surfaces render unavailable neutrally ------------------

const SURFACES = [
  { name: "Team Targets / PAM target accordion", file: "../src/components/pam-target-accordion.tsx", guard: "row.status === 'unavailable'" },
  { name: "PAM workspace", file: "../src/pages/pam-workspace.tsx", guard: "row.status === 'unavailable'" },
  { name: "Weekly Report", file: "../src/pages/weekly-report.tsx", guard: "t.status === 'unavailable'" },
  { name: "Weekly Team", file: "../src/components/weekly-team-view.tsx", guard: "targetLabel === 'unavailable'" },
];

// The Badge rendered directly for the unavailable guard.
function unavailableBadge(source: string, guard: string): string {
  const at = source.indexOf(guard);
  assert.notEqual(at, -1, `expected an explicit ${guard} branch`);
  const start = source.indexOf("<Badge", at);
  const end = source.indexOf("</Badge>", start);
  assert.ok(start !== -1 && end !== -1, `expected a Badge after ${guard}`);
  return source.slice(start, end + "</Badge>".length);
}

for (const surface of SURFACES) {
  test(`${surface.name}: unavailable renders a neutral "Data unavailable" badge in the No target visual family`, () => {
    const source = read(surface.file);
    const badge = unavailableBadge(source, surface.guard);
    assert.match(badge, />Data unavailable</);
    assert.match(badge, /text-muted-foreground/);
    assert.doesNotMatch(badge, /amber|rose|red-|emerald|warning|danger|statusTone|%/);
  });

  test(`${surface.name}: the unavailable branch is decided before the ahead/behind badge, so it can never fall through to "Behind"`, () => {
    const source = read(surface.file);
    const guardAt = source.indexOf(surface.guard);
    const behindLabelAt = source.indexOf("'Behind'");
    assert.ok(guardAt !== -1 && behindLabelAt !== -1);
    assert.ok(guardAt < behindLabelAt, "unavailable must be handled before the ahead/behind ternary");
  });
}

test("Weekly Team: the aggregate comes from the tested pure helper, not a local copy", () => {
  const source = read("../src/components/weekly-team-view.tsx");
  assert.match(source, /import \{ aggregateTargetLabel \} from '@\/components\/weekly-team-target-label';/);
  assert.doesNotMatch(source, /function aggregateTargetLabel/);
});
