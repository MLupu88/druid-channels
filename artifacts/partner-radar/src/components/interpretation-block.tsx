import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

// Phase 11.6F: shared presentational block for AI-generated interpretive
// text (Discovery's "Why it fits"/"Why now", Channel Radar's "Why it
// matters"/"Recommended action"/"DRUID motion") -- the one piece of
// duplication genuinely worth sharing between prospects.tsx/
// my-prospects.tsx/channel-radar.tsx, since all of them are exactly
// "a label + a small AI marker + a paragraph of generated text," even
// though the surrounding evidence-card shapes on each page differ too
// much to share.
//
// This is presentation only -- it never alters, generates, or summarizes
// the text it's given; the underlying field content and its source
// (DeepSeek's structured output) are completely unchanged by 11.6F.
export type InterpretationTone = 'interpretation' | 'druid';

interface InterpretationBlockProps {
  label: ReactNode;
  tone?: InterpretationTone;
  children: ReactNode;
  className?: string;
}

export function InterpretationBlock({ label, tone = 'interpretation', children, className }: InterpretationBlockProps) {
  const isDruid = tone === 'druid';
  return (
    <div
      className={cn(
        'rounded-md border p-3',
        isDruid ? 'border-secondary-accent-border bg-secondary-accent/5' : 'border-border/60',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <Sparkles className={cn('h-3 w-3 shrink-0', isDruid ? 'text-secondary-accent' : 'text-muted-foreground')} />
        <p className={cn('text-[10px] font-medium uppercase tracking-wide', isDruid ? 'text-secondary-accent' : 'text-muted-foreground')}>
          {label}
        </p>
      </div>
      <p className="text-sm text-foreground leading-relaxed">{children}</p>
    </div>
  );
}
