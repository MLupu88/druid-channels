---
name: KPI honesty principle
description: Rule for presenting dashboard metrics without fabricating derivations across unrelated data.
---

When a dashboard/KPI can't be computed live from a real, directly-related source, don't
approximate it with cross-entity math (e.g. deriving "partner pipeline" from an unrelated
prospect count, or applying an arbitrary multiplier like `* 0.92` to fake a trend).

**How to apply:**
- Store the real value as a snapshot (e.g. a `kpi_snapshots` table with `lastWeekValue`) and
  read it directly at request time instead of computing it from unrelated tables.
- For rows that legitimately can be computed live from directly related data, do the real
  aggregation (counts/sums from the actual source table), not an inference.
- Attach `data_source` and `last_updated` fields to every KPI row so the UI can show
  provenance and the user can tell manual/snapshot data from live-computed data.
- Threshold/status-banding logic (e.g. `value >= target * 0.7` to decide amber vs red) is fine
  — that's a display rule, not a fabricated metric value.

**Why:** a KPI that looks precise but is secretly synthesized erodes trust once anyone checks
the number against its real source; explicit provenance lets users judge confidence themselves.
