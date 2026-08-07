---
name: Authorization scoping rules
description: How to enforce per-role data scoping (e.g. territory/tenant) correctly instead of silently widening access.
---

When a caller requests a scope narrower/other than their own (e.g. a PAM passing
`?territory=<other>`), reject invalid or foreign scope requests outright (403/400).
Never fall back to a broader default (e.g. "Global") on an invalid or unauthorized
scope value — that silently leaks cross-tenant/cross-territory data instead of failing
loudly.

**How to apply:**
- Resolve the acting user's own scope (e.g. territory) from a real ownership relation
  in the DB (e.g. `territories.ownerUserId`), not from a free-text display field on the
  user record — display fields can drift out of sync with the authoritative relation.
- A single scope-resolution helper (reject-not-widen) should be reused by every route
  that accepts a scope parameter, so the policy can't drift per-route.
- Always re-derive the acting user's identity and role fresh from the DB on every
  request from a verified session token — never trust client-supplied identity/role/
  ownership claims in the request body or query string.
- Client-triggered downloads (`window.open`/`<a href>`) can't attach an Authorization
  header; if a protected GET route needs to support that pattern, accept the session
  token as a query parameter too (in addition to the Bearer header), not by removing
  auth from the route.
