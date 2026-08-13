// Phase 6: structural regression guard for the pam-workspace.tsx "Marketing
// activities" tab scoping fix. The audit found that a Head/Admin drilling
// into a specific PAM's workspace saw an unscoped campaigns list (every
// activity, not just that PAM's) because useListCampaigns() was called with
// no params. The fix passes owner_user_id only when pamUserId is present
// (the Head/Admin drill-down case); it must NOT introduce any territory-wide
// visibility for a PAM's own view of their own workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, "../src/pages/pam-workspace.tsx"), "utf-8");

test("campaigns are fetched with an owner_user_id param derived from pamUserId, not left unscoped", () => {
  assert.ok(source.includes("const campaignsParam = pamUserId ? { owner_user_id: pamUserId } : {};"), "expected campaignsParam to scope by owner_user_id only when pamUserId (Head/Admin drill-down) is present");
  assert.ok(source.includes("useListCampaigns(campaignsParam)"), "expected useListCampaigns to be called with campaignsParam");
  assert.ok(!source.includes("useListCampaigns();") && !source.includes("useListCampaigns()"), "must not call useListCampaigns with no params (the original scoping bug)");
});

test("does not introduce territory-based campaign scoping (owner_user_id only, no territory param on the campaigns fetch)", () => {
  const campaignsParamLine = source.split("\n").find((l) => l.includes("const campaignsParam"));
  assert.ok(campaignsParamLine, "expected to find the campaignsParam declaration");
  assert.ok(!campaignsParamLine!.includes("territory"), "campaignsParam must not derive from territoryId -- PAM activity visibility stays owner-scoped, not territory-wide");
});
