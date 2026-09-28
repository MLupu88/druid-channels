// Slice E: Head/Admin team commercial roll-up page and PAM navigation
// cleanup. Pure checks on src/lib/team-commercial.ts plus source-text
// boundaries on the page, navigation, and layout -- same convention as
// tests/pamCommercialWorkspace.test.ts / reportingNavigation.test.ts; this
// project has no React rendering harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REPORTING_SUBNAV_ITEMS, getPartnersSubNavItems } from "../src/lib/navigation";
import {
  ROLLUP_COUNT_KEYS,
  ROLLUP_CRM_NOTE,
  ROLLUP_SCOPE_NOTE,
  ROLLUP_TOTAL_LABELS,
  UNASSIGNED_NOTE,
  formatTerritories,
  hasRelationships,
} from "../src/lib/team-commercial";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf-8");

const pageSource = read("../src/pages/team-commercial.tsx");
const appSource = read("../src/App.tsx");
const layoutSource = read("../src/components/layout.tsx");
const workspaceSource = read("../src/pages/pam-workspace.tsx");

function navBlock(which: "global" | "pam"): string {
  const start = layoutSource.indexOf("const navItems: NavItem[] = isGlobalUser");
  const split = layoutSource.indexOf("    : [", start);
  const end = layoutSource.indexOf("      ];", split);
  return which === "global" ? layoutSource.slice(start, split) : layoutSource.slice(split, end);
}

// ---- Reporting placement ----------------------------------------------------

test("Commercial is a Reporting subnav tab at /team-commercial, Head/Admin-gated, with no new sidebar item", () => {
  const item = REPORTING_SUBNAV_ITEMS.find((i) => i.value === "team-commercial");
  assert.deepEqual(item, { value: "team-commercial", label: "Commercial", href: "/team-commercial" });

  const routeStart = appSource.indexOf('<Route path="/team-commercial">');
  assert.notEqual(routeStart, -1);
  const routeBody = appSource.slice(routeStart, appSource.indexOf("</Route>", routeStart));
  assert.ok(routeBody.includes("<Guarded allow={isGlobalUser}><TeamCommercial /></Guarded>"), "a PAM must never reach the team roll-up");

  assert.match(layoutSource, /label: 'Reporting'.*?activePaths: \[[^\]]*'\/team-commercial'[^\]]*\]/s);
  assert.ok(!layoutSource.includes("href: '/team-commercial'"), "no separate sidebar entry for the roll-up");
  assert.ok(pageSource.includes("<WorkspaceSubNav items={REPORTING_SUBNAV_ITEMS} />"));
});

// ---- Truthful, DB-only roll-up ----------------------------------------------

test("the page loads only the DB-only roll-up -- no deal hook, no deal/pipeline/revenue tiles", () => {
  assert.ok(pageSource.includes("useGetPamCommercialRollup()"));
  assert.ok(!pageSource.includes("useGetPamCommercialRelationshipDeals"), "loading the roll-up must not load HubSpot deals");
  assert.ok(!pageSource.includes("useGetPamCommercialWorkspace"), "no per-PAM fan-out on page load");
  const labels = Object.values(ROLLUP_TOTAL_LABELS).join(" ");
  assert.doesNotMatch(labels, /deal|pipeline|revenue|health|score|momentum/i);
  assert.deepEqual(ROLLUP_COUNT_KEYS, ["confirmed_partners", "awaiting_review", "crm_linked_confirmed", "crm_linked_awaiting_review"]);
  assert.match(ROLLUP_SCOPE_NOTE, /closed relationships are excluded/);
  assert.match(ROLLUP_CRM_NOTE, /not that deals or active opportunities exist/);
});

test("unassigned relationships are shown as their own bucket, never attributed to a PAM or openable", () => {
  assert.match(UNASSIGNED_NOTE, /not attributed to the territory owner/);
  assert.ok(pageSource.includes("hasRelationships(data.unassigned)"));
  assert.ok(pageSource.includes("hasRelationships(data.other_assignees)"));
  const bucket = pageSource.slice(pageSource.indexOf("function BucketRow("));
  assert.ok(!bucket.includes("setSelected"), "a bucket row has no PAM drill-down");
  assert.equal(hasRelationships({ confirmed_partners: 0, awaiting_review: 0, crm_linked_confirmed: 0, crm_linked_awaiting_review: 0 }), false);
  assert.equal(hasRelationships({ confirmed_partners: 0, awaiting_review: 1, crm_linked_confirmed: 0, crm_linked_awaiting_review: 0 }), true);
});

test("territories[] render as context, supporting several or none", () => {
  assert.equal(formatTerritories([]), "—");
  assert.equal(formatTerritories([{ territory_name: "Iberia" }, { territory_name: "LATAM" }]), "Iberia, LATAM");
  assert.ok(pageSource.includes("formatTerritories(p.territories)"));
});

// ---- Drill-down reuses the existing Commercial workspace ----------------------

test("selecting a PAM reuses PamCommercialWorkspace with pam_user_id; deals stay lazy inside it", () => {
  assert.ok(pageSource.includes("import { PamCommercialWorkspace } from '@/components/pam-commercial-workspace';"));
  assert.ok(pageSource.includes("<PamCommercialWorkspace key={selected.id} pamUserId={selected.id} pamName={selected.name} />"));
  assert.ok(pageSource.includes("{selected && ("), "the workspace mounts only after an explicit selection");
  assert.equal((pageSource.match(/function \w*Deal/g) ?? []).length, 0, "no second deal UI");

  const component = read("../src/components/pam-commercial-workspace.tsx");
  assert.ok(component.includes("{open && <RelationshipDealsPanel"), "the deal panel still mounts only when a partner is opened");
  assert.equal(component.match(/useGetPamCommercialRelationshipDeals\(/g)?.length, 1);
});

// ---- PAM navigation cleanup ---------------------------------------------------

test("PAM sidebar is Overview, My Workspace, Portfolio, Opportunities, Radar -- My Workspace routes to /my-workspace", () => {
  const labels = [...navBlock("pam").matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Overview", "My Workspace", "Portfolio", "Opportunities", "Radar"]);
  assert.ok(navBlock("pam").includes("{ href: '/my-workspace', label: 'My Workspace', icon: Briefcase }"));
  assert.ok(!navBlock("global").includes("My Workspace"), "Head/Admin has no personal My Workspace entry");
  const route = appSource.slice(appSource.indexOf('<Route path="/my-workspace">'));
  assert.ok(route.startsWith('<Route path="/my-workspace">\n          <Guarded allow={!isGlobalUser}><MyWorkspace /></Guarded>'));
});

test("My Workspace tabs are New partners, Commercial, My targets, Marketing activities -- no obsolete Partners tab", () => {
  const triggers = [...workspaceSource.matchAll(/<TabsTrigger value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(triggers, ["prospects", "commercial", "targets", "activities"]);
  assert.ok(!workspaceSource.includes('value="partners"'));
  assert.ok(!workspaceSource.includes("Partners has moved to Portfolio"));
  assert.ok(!workspaceSource.includes("tab-workspace-partners"));
});

test("Portfolio's internal tabs are unchanged", () => {
  assert.deepEqual(getPartnersSubNavItems(false).map((i) => [i.label, i.href]), [
    ["My Prospects", "/new-partners"],
    ["Recruitment", "/recruitment"],
    ["Portfolio", "/portfolio"],
    ["Activities", "/activities"],
  ]);
  assert.deepEqual(getPartnersSubNavItems(true).map((i) => i.label), ["Discovery", "Recruitment", "Portfolio", "Activities"]);
});
