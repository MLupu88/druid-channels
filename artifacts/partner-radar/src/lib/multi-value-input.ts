// Settings has several comma-separated multi-value fields (partner types,
// industries, technologies, excluded domains, Channel Radar monitored
// entities). 5B-R hotfix: parsing on every keystroke and feeding the parsed
// array straight back into a controlled input's value loses whatever the
// user just typed the moment it would parse away -- a trailing comma, a
// trailing space, an empty segment mid-edit -- making an entry like
// "System Integrator, Consulting, MSP" nearly impossible to type. Parsing
// must only happen at the save/commit boundary; the input itself keeps the
// raw text the user is actually typing until then (the same pattern
// Territory countries already used correctly -- see settings.tsx's
// localCountries state).
export function parseMultiValueInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatMultiValueInput(values: string[] | null | undefined): string {
  return (values ?? []).join(', ');
}

// Same fix, for the one multi-value field that's newline- rather than
// comma-delimited (search queries can legitimately contain commas, e.g.
// `"Genesys partner" + banking`) -- pressing Enter to start a new line must
// not immediately collapse that blank line away.
export function parseLineDelimitedInput(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatLineDelimitedInput(values: string[] | null | undefined): string {
  return (values ?? []).join('\n');
}
