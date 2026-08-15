import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Phase 11.3: replaces ~9 hand-copied title/description/actions blocks
// (see components/workspace-subnav.tsx for the tab row these usually sit
// under). Deliberately just three slots -- title, an optional description,
// and an optional trailing actions area -- since that's the only shape any
// existing page header actually needs. Not a general layout framework.
interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 flex-wrap', className)}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}
