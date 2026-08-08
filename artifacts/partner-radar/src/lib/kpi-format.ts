// Presentation-only helpers for KPI values. These never compute or convert
// anything -- the API already returns currency-converted numbers (or null
// for genuinely unavailable data); this module only formats what it's
// handed. Mirrors the equivalent formatting rules in the API server's
// pptxReport.ts so Overview and the PPTX export read identically.
export type Currency = 'USD' | 'EUR' | 'GBP';

// The 3 money metrics locked for Stage 2B. Kept here as a small, stable
// constant (frontend has no access to the backend's kpiRegistry module --
// separate app/package, only the generated API client is shared).
const MONEY_METRIC_KEYS = new Set(['partner_sourced_pipeline', 'partner_influenced_pipeline', 'closed_revenue']);

export function isMoneyMetric(metricKey: string): boolean {
  return MONEY_METRIC_KEYS.has(metricKey);
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

// Deterministic English-locale formatting, fixed "en-US" -- never depends
// on the visitor's browser locale.
export function formatMoney(value: number | null | undefined, currency: Currency): string {
  if (value === null || value === undefined) return '--';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
}

// Counts remain plain numbers; only the 3 money metrics ever get currency
// formatting.
export function formatMetricValue(value: number | null | undefined, metricKey: string, currency: Currency): string {
  return isMoneyMetric(metricKey) ? formatMoney(value, currency) : formatCount(value);
}

export function formatTrendLabel(trend: string | null | undefined): string {
  if (!trend) return '--';
  return trend.charAt(0).toUpperCase() + trend.slice(1);
}

export function formatStatusLabel(status: string | null | undefined): string {
  if (!status) return '--';
  return status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
