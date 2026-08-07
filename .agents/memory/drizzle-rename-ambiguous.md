---
name: Drizzle push fails on rename-ambiguous diffs
description: Workaround when `drizzle-kit push` can't apply a schema change non-interactively.
---

`drizzle-kit push` prompts interactively when it can't tell whether a schema diff is a
rename vs. a drop+create (e.g. renaming/reshaping a table or dropping columns while adding
similarly-named ones). Non-interactive agent sessions can't answer that prompt, so the push
hangs or fails.

**Workaround:** apply the DDL change directly via raw SQL (e.g. through the `executeSql`
callback), then run `drizzle-kit push` again afterward to confirm the schema is now clean
(no pending diff). Treat a clean second push as the verification step, not the push itself.

**Why:** avoids getting stuck on an interactive prompt with no way to respond; still ends in a
drizzle-schema-consistent state.
