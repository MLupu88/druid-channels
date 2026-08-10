import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { QUARTER_KEYS, splitPeriodKey, joinPeriodKey, quarterLabel, yearOptions, getDefaultPeriodKey, type QuarterKey } from '@/lib/period';

/**
 * Stage 6.3: year + quarter/YTD picker, replacing every hardcoded
 * "Q1 2026"-style dropdown. Emits the composite "<year>-<quarterKey>"
 * period key the API expects everywhere. Used identically by Overview,
 * Team Targets, My Targets, and Portfolio so there is exactly one period
 * picker implementation, not four hand-rolled copies.
 */
export function PeriodSelector({ value, onChange, className }: { value: string; onChange: (value: string) => void; className?: string }) {
  const split = splitPeriodKey(value) ?? splitPeriodKey(getDefaultPeriodKey())!;

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
      <Select value={String(split.year)} onValueChange={(y) => onChange(joinPeriodKey(Number(y), split.quarterKey))}>
        <SelectTrigger className="w-[90px] h-8 bg-background border-border/60"><SelectValue /></SelectTrigger>
        <SelectContent>
          {yearOptions().map((y) => (
            <SelectItem key={y} value={String(y)}>{y}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={split.quarterKey} onValueChange={(q) => onChange(joinPeriodKey(split.year, q as QuarterKey))}>
        <SelectTrigger className="w-[140px] h-8 bg-background border-border/60"><SelectValue /></SelectTrigger>
        <SelectContent>
          {QUARTER_KEYS.map((q) => (
            <SelectItem key={q} value={q}>{quarterLabel(q, split.year)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
