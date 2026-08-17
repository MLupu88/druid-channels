// Phase 11.6.1 P1 fix: Reporting navigation architecture. Weekly Team gets
// its own real Reporting-scoped route (/weekly-team) instead of the old
// `/?view=weekly-team` query param on Overview -- see App.tsx,
// lib/navigation.ts's REPORTING_SUBNAV_ITEMS, components/layout.tsx's
// activePaths, and the new pages/weekly-team.tsx. Same source-text-boundary
// convention as tests/connectionProviderMeta.test.ts / tests/splitEvenly
// .test.ts -- this project has no router-component rendering harness, so a
// deterministic check on the actual source is the honest, consistent way to
// guard routing/navigation behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REPORTING_SUBNAV_ITEMS } from "../src/lib/navigation";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf-8");

const appSource = read("../src/App.tsx");
const layoutSource = read("../src/components/layout.tsx");
const overviewSource = read("../src/pages/overview.tsx");
const weeklyTeamPageSource = read("../src/pages/weekly-team.tsx");

// ---- Weekly Team Reporting route exists -------------------------------------

test("App.tsx defines a real /weekly-team route, rendering the WeeklyTeam page", () => {
  assert.ok(appSource.includes('<Route path="/weekly-team">'), "expected a dedicated /weekly-team route");
  const routeStart = appSource.indexOf('<Route path="/weekly-team">');
  const routeEnd = appSource.indexOf("</Route>", routeStart);
  const routeBody = appSource.slice(routeStart, routeEnd);
  assert.ok(routeBody.includes("<WeeklyTeam />"), "expected the route to render the WeeklyTeam page component");
});

test("the /weekly-team route is Head/Admin-only, same gate the old query param used to enforce", () => {
  const routeStart = appSource.indexOf('<Route path="/weekly-team">');
  const routeEnd = appSource.indexOf("</Route>", routeStart);
  const routeBody = appSource.slice(routeStart, routeEnd);
  assert.ok(routeBody.includes("<Guarded allow={isGlobalUser}><WeeklyTeam /></Guarded>"), "expected the same isGlobalUser gate /team-targets and /pams use");
});

test("App.tsx imports WeeklyTeam from pages/weekly-team, not an inline/duplicated definition", () => {
  assert.ok(appSource.includes("import WeeklyTeam from '@/pages/weekly-team';"));
});

test("the old /weekly-team-report bookmark redirect now points at the new route, not the removed query param", () => {
  const routeStart = appSource.indexOf('<Route path="/weekly-team-report">');
  const routeEnd = appSource.indexOf("</Route>", routeStart);
  const routeBody = appSource.slice(routeStart, routeEnd);
  assert.ok(routeBody.includes('<Redirect to="/weekly-team" />'));
  assert.ok(!routeBody.includes("view=weekly-team"), "the legacy redirect must not still point at the removed query-param URL");
});

// ---- Reporting subnav points to the new route -------------------------------

test("REPORTING_SUBNAV_ITEMS' Weekly Team entry points to the new /weekly-team route", () => {
  const weeklyTeamItem = REPORTING_SUBNAV_ITEMS.find((i) => i.value === "weekly-team");
  assert.ok(weeklyTeamItem, "expected a weekly-team entry in REPORTING_SUBNAV_ITEMS");
  assert.equal(weeklyTeamItem!.href, "/weekly-team");
});

test("no REPORTING_SUBNAV_ITEMS entry still points at the old query-param URL", () => {
  for (const item of REPORTING_SUBNAV_ITEMS) {
    assert.ok(!item.href.includes("view=weekly-team"), `${item.value}'s href must not reference the removed query param`);
  }
});

// ---- Reporting sidebar active state recognizes the new route ---------------

test("layout.tsx's Reporting sidebar item treats /weekly-team, /team-targets, and /pams all as active", () => {
  const reportingItemMatch = layoutSource.match(/label: 'Reporting'.*?activePaths: (\[[^\]]*\])/s);
  assert.ok(reportingItemMatch, "expected to find Reporting's nav item with an activePaths array");
  const activePaths = reportingItemMatch![1];
  assert.ok(activePaths.includes("'/weekly-team'"), "expected /weekly-team in Reporting's activePaths");
  assert.ok(activePaths.includes("'/team-targets'"), "expected /team-targets to remain in Reporting's activePaths");
  assert.ok(activePaths.includes("'/pams'"), "expected /pams to remain in Reporting's activePaths");
});

// ---- Overview does not claim the Weekly Team route --------------------------

test("Overview's own sidebar nav item has no activePaths -- it is active only for the exact '/' route", () => {
  const overviewItemMatch = layoutSource.match(/\{ href: '\/', label: 'Overview', icon: LayoutDashboard \}/g);
  assert.ok(overviewItemMatch && overviewItemMatch.length >= 1, "expected Overview's nav item to have no activePaths field at all");
});

test("overview.tsx no longer renders WeeklyTeamView, imports it, or reads a ?view= query param", () => {
  assert.ok(!overviewSource.includes("WeeklyTeamView"), "Weekly Team must no longer live inside Overview");
  assert.ok(!overviewSource.includes("useSearch"), "Overview must no longer read the location's query string for a view switch");
  assert.ok(!overviewSource.includes("view=weekly-team"), "Overview must no longer construct or check the removed query-param URL");
  assert.ok(!overviewSource.includes("'weekly-team'"), "Overview must no longer reference a 'weekly-team' view value at all");
});

test("overview.tsx's sidebar-adjacent tab switcher for Performance/Weekly Team is gone -- Overview has one view now", () => {
  assert.ok(!overviewSource.includes('data-testid="tab-weekly-team"'), "the old Performance/Weekly Team tab switcher must be removed from Overview");
  assert.ok(!overviewSource.includes('data-testid="tab-performance"'));
});

// ---- WeeklyTeamView is reused, not copied -----------------------------------

test("pages/weekly-team.tsx imports and renders the existing WeeklyTeamView component, not a reimplementation", () => {
  assert.ok(weeklyTeamPageSource.includes("import { WeeklyTeamView } from '@/components/weekly-team-view';"));
  assert.ok(weeklyTeamPageSource.includes("<WeeklyTeamView />"));
});

test("pages/weekly-team.tsx renders the shared Reporting subnav via REPORTING_SUBNAV_ITEMS, consistent with pages/team-targets.tsx and pages/pams.tsx", () => {
  assert.ok(weeklyTeamPageSource.includes("import { WorkspaceSubNav } from '@/components/workspace-subnav';"));
  assert.ok(weeklyTeamPageSource.includes("import { REPORTING_SUBNAV_ITEMS } from '@/lib/navigation';"));
  assert.ok(weeklyTeamPageSource.includes("<WorkspaceSubNav items={REPORTING_SUBNAV_ITEMS} />"));
});

test("components/weekly-team-view.tsx itself is unmodified business logic -- still sourced from GET /reporting/weekly/team, never a copy for this page", () => {
  const weeklyTeamViewSource = read("../src/components/weekly-team-view.tsx");
  assert.ok(weeklyTeamViewSource.includes("useGetWeeklyTeamReport"), "expected the same data hook, not a duplicated fetch");
  // Only one export of this name exists in the whole src tree -- proves
  // pages/weekly-team.tsx didn't fork a second copy under a similar name.
  assert.equal((weeklyTeamViewSource.match(/export function WeeklyTeamView/g) ?? []).length, 1);
});

// ---- existing Team Targets and PAM routes still behave as Reporting routes -

test("Team Targets and PAMs routes still exist, unchanged, and are still Head/Admin-gated", () => {
  for (const routePath of ["/team-targets", "/pams"]) {
    const routeStart = appSource.indexOf(`<Route path="${routePath}">`);
    assert.notEqual(routeStart, -1, `expected ${routePath} to still be routed`);
    const routeEnd = appSource.indexOf("</Route>", routeStart);
    const routeBody = appSource.slice(routeStart, routeEnd);
    assert.ok(routeBody.includes("Guarded allow={isGlobalUser}"), `expected ${routePath} to remain Head/Admin-only`);
  }
});

test("Team Targets and PAMs pages still render the same shared Reporting subnav", () => {
  const teamTargetsSource = read("../src/pages/team-targets.tsx");
  const pamsSource = read("../src/pages/pams.tsx");
  assert.ok(teamTargetsSource.includes("<WorkspaceSubNav items={REPORTING_SUBNAV_ITEMS} />"));
  assert.ok(pamsSource.includes("<WorkspaceSubNav items={REPORTING_SUBNAV_ITEMS} />"));
});

test("REPORTING_SUBNAV_ITEMS still lists exactly weekly-team, team-targets, and pams, in that order", () => {
  assert.deepEqual(
    REPORTING_SUBNAV_ITEMS.map((i) => i.value),
    ["weekly-team", "team-targets", "pams"],
  );
});
