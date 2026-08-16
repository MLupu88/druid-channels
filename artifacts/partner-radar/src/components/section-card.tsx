import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// Phase 11.6A: thin composition over the existing shadcn Card primitives
// (components/ui/card.tsx, untouched), not a competing card framework --
// codifies the "shadow-none border-border/70, CardHeader with a muted
// bottom-bordered header, px-5 py-4" shape already hand-copied across
// AiChannelBriefPanel/CommercialPerformanceHead/ConnectionCard and the
// Overview KPI tables (overview.tsx, commercial-performance.tsx,
// settings.tsx) so a page adopting it later doesn't re-derive that shape.
// Not wired into any existing page in this slice -- see the 11.6A report.

export function SectionCard({ className, children, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card className={cn('shadow-none border-border/70', className)} {...props}>
      {children}
    </Card>
  );
}

interface SectionCardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

// Matches the existing "py-4 px-5 border-b border-border/60 bg-muted/20"
// header treatment exactly -- title sits at CardTitle's existing
// "text-base font-medium" weight (one step below PageHeader's page-title
// tier), with an optional trailing actions slot for the header-row buttons
// every current instance of this pattern already has (Edit/Regenerate/Test
// connection, etc.).
export function SectionCardHeader({ title, description, actions, className }: SectionCardHeaderProps) {
  return (
    <CardHeader className={cn('py-4 px-5 border-b border-border/60 bg-muted/20', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="text-base font-medium">{title}</CardTitle>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </CardHeader>
  );
}

interface SectionCardContentProps {
  className?: string;
  noPadding?: boolean;
  children: ReactNode;
}

// noPadding is for content that supplies its own (e.g. a Table, which
// already has its own cell padding and looks wrong with an extra p-5 gutter
// -- the existing PAM quarterly allocations / Metric setup tables both
// already reach for CardContent's "p-0" for exactly this reason).
export function SectionCardContent({ className, noPadding, children }: SectionCardContentProps) {
  return <CardContent className={cn(noPadding ? 'p-0' : 'p-5', className)}>{children}</CardContent>;
}
