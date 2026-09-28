// Phase 12 Aniri PAM-level intelligence: deterministic, pure name resolution
// for GET /channel-chief/pam-overview (routes/channel_chief.ts). Given a
// free-text PAM reference ("Denny", "denny", "Denny Morais") and the
// canonical roster of PAM users, resolves it the same way a human reading
// the team list would -- never a fuzzy/LLM guess. Deliberately pure and
// DB-free so every resolution rule is directly unit-testable without a live
// Postgres (the route supplies the already-queried role="pam" user list).
import type { User } from "@workspace/db";

export type PamNameResolution =
  | { status: "found"; user: User }
  | { status: "ambiguous"; candidates: { id: string; name: string }[] }
  | { status: "not_found" };

// Bounded -- an ambiguity result is never a full-roster dump, matching every
// other Channel Chief response's "bounded, never a full-table dump"
// convention.
const MAX_AMBIGUOUS_CANDIDATES = 10;

function firstToken(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

function toCandidates(users: User[]): { id: string; name: string }[] {
  return users.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((u) => ({ id: u.id, name: u.name }));
}

// Tiered, most-specific-first -- an exact full-name match never falls
// through to a looser tier even if some other PAM's first name happens to
// match too. Case-insensitive throughout (per spec: "Denny"/"denny"/"Denny
// Morais" must all resolve the same way). Each tier only ever looks at
// pams whose the tier's own key actually matches -- a tier that matches
// zero candidates falls through to the next tier; a tier that matches 2+
// stops there as ambiguous (never silently falls through to a looser tier
// that might narrow back to 1, since that would make the match depend on
// tier-ordering coincidence rather than genuine specificity).
export function resolvePamByName(query: string, pams: User[]): PamNameResolution {
  const q = query.trim().toLowerCase();
  if (!q) return { status: "not_found" };

  const exactName = pams.filter((u) => u.name.trim().toLowerCase() === q);
  if (exactName.length === 1) return { status: "found", user: exactName[0]! };
  if (exactName.length > 1) return { status: "ambiguous", candidates: toCandidates(exactName) };

  const exactEmail = pams.filter((u) => u.email.trim().toLowerCase() === q);
  if (exactEmail.length === 1) return { status: "found", user: exactEmail[0]! };
  if (exactEmail.length > 1) return { status: "ambiguous", candidates: toCandidates(exactEmail) };

  const firstNameMatch = pams.filter((u) => firstToken(u.name).toLowerCase() === q);
  if (firstNameMatch.length === 1) return { status: "found", user: firstNameMatch[0]! };
  if (firstNameMatch.length > 1) return { status: "ambiguous", candidates: toCandidates(firstNameMatch) };

  const substringMatch = pams.filter((u) => u.name.trim().toLowerCase().includes(q));
  if (substringMatch.length === 1) return { status: "found", user: substringMatch[0]! };
  if (substringMatch.length > 1) return { status: "ambiguous", candidates: toCandidates(substringMatch) };

  return { status: "not_found" };
}
