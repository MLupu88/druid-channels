export * from "./generated/api";
export * from "./generated/types";

// Phase 7: two operations in openapi.yaml (getPamWeeklyReport,
// submitMyWeeklyReport) are the only ones in this spec that combine a path
// param with a query param, or a body whose operation-derived name
// coincides with a same-named schema. orval's zod-client output
// (./generated/api.ts) and its separate standalone-types output
// (./generated/types/*) disagree on how to name the query/body schema in
// that case -- e.g. GetPamWeeklyReportParams means "path params ({userId})"
// in generated/api.ts but "query params ({week_start})" in
// generated/types/getPamWeeklyReportParams.ts -- so the two `export *`
// above are ambiguous for these two names (TS2308). The explicit
// re-exports below resolve that ambiguity in TypeScript's own recommended
// way, preferring the runtime zod schemas from generated/api.ts (what
// route handlers actually validate against) over the redundant standalone
// type, which duplicates a shape already derivable via
// z.infer<typeof GetPamWeeklyReportQueryParams>/z.infer<typeof SubmitMyWeeklyReportBody>.
// If a future spec change introduces another operation combining a path
// param with a query param (or otherwise triggers this same collision),
// add it here too rather than reshaping the REST contract to avoid it.
export { GetPamWeeklyReportParams, SubmitMyWeeklyReportBody } from "./generated/api";
