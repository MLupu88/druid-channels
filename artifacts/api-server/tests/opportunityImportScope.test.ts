import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const routeSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/routes/opportunities.ts"), "utf8");

test("opportunity-import reconciliation and company-ensure endpoints are Head/Admin-only", () => {
  assert.match(routeSource, /router\.post\("\/opportunities\/import\/reconcile", requireAdmin/);
  assert.match(routeSource, /router\.post\("\/opportunities\/import\/ensure-company", requireAdmin/);
  assert.match(routeSource, /resolveProviderSecret\("hubspot"\)/);
  assert.match(routeSource, /findCompanyByDomain\(/);
  assert.match(routeSource, /searchDeals\(/);
});

test("opportunity-import route source contains no HubSpot write API usage or token response", () => {
  assert.doesNotMatch(routeSource, /crm\/v3\/.*(?:POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(routeSource, /res\.(?:json|send)\(\{[^}]*accessToken/);
});
