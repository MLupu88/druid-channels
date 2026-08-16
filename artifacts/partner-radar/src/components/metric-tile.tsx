import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

// Phase 11.6A: generalizes the "StatTile" shape already duplicated
// near-identically in overview.tsx and commercial-performance.tsx
// (rounded-md border border-border/60 p-3, uppercase muted label, bold
// tabular-nums value) into one reusable primitive, extended with the
// delta/target/attention states later slices (Reporting, Overview) will
// need. Not wired into any existing page in this slice -- both existing
// StatTile implementations are left exactly as they are; see the 11.6A
// report for why replacing them belongs to the pages' own later slice
// (11.6B/11.6C), not this foundation slice.

export type MetricTileVariant = 'default' | 'primary';

interface MetricTileDelta {
  direction: 'up' | 'down' | 'flat';
  label: string;
  // Whether "up" reads as good news for this particular metric -- not every
  // metric's "up" is positive (kept explicit rather than assumed) --
  // defaults to the conventional up=good/down=bad reading.
  tone?: 'positive' | 'negative' | 'neutral';
}

interface MetricTileProps {
  label: ReactNode;
  value: ReactNode;
  // 'primary' is the visibly-dominant treatment the 11.6 audit calls for
  // (e.g. Closed Revenue outweighing secondary KPIs) -- larger value
  // typography and a subtle primary-tinted left accent, still restrained
  // (no shadow/gradient/oversized card).
  variant?: MetricTileVariant;
  delta?: MetricTileDelta;
  // Soft amber highlight for a tile that needs the viewer's attention
  // (e.g. behind target) -- independent of `variant`, since a primary
  // metric can also be behind target.
  attention?: boolean;
  className?: string;
}

function DeltaIndicator({ delta }: { delta: MetricTileDelta }) {
  const tone = delta.tone ?? (delta.direction === 'up' ? 'positive' : delta.direction === 'down' ? 'negative' : 'neutral');
  const toneClass = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-muted-foreground';
  const Icon = delta.direction === 'up' ? ArrowUp : delta.direction === 'down' ? ArrowDown : Minus;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', toneClass)}>
      <Icon className="h-3 w-3" />
      {delta.label}
    </span>
  );
}

export function MetricTile({ label, value, variant = 'default', delta, attention, className }: MetricTileProps) {
  return (
    <div
      className={cn(
        'rounded-md border p-3',
        attention ? 'border-attention-border bg-attention/5' : 'border-border/60',
        // Phase 11.6A amendment: the raw --brand green, not --primary --
        // this is a decorative accent strip, not text, so it can safely use
        // the actual brand swatch rather than the accessible-contrast shade.
        variant === 'primary' && 'border-l-2 border-l-brand',
        className,
      )}
    >
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
      <p className={variant === 'primary' ? 'text-metric-value-primary' : 'text-metric-value'}>{value}</p>
      {delta && (
        <div className="mt-1.5">
          <DeltaIndicator delta={delta} />
        </div>
      )}
    </div>
  );
}
