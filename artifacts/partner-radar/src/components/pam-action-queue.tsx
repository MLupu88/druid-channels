// Phase 4: PAM Overview "Your Actions" -- answers "what do I need to do
// now?" from data that already exists (assigned prospects, Recruitment,
// prospect_activity). Deliberately not editable here -- every row links out
// to the real workflow (My Prospects / Recruitment) via a ?id= deep link;
// this section only surfaces status, priority, and links, matching the
// existing Overview's own "status/priorities/derived metrics/actionable
// links, never a giant editable form" convention.
import { Link } from 'wouter';
import { useListProspects, useListRecruitments, useListRecentProspectActivity } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ListChecks, Clock, TrendingUp, Activity } from 'lucide-react';

const EVENT_TYPE_LABELS: Record<string, string> = {
  discovered: 'Discovered',
  reviewed: 'Reviewed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  deferred: 'Deferred',
  hubspot_pushed: 'Pushed to HubSpot',
  note_added: 'Note added',
};

function ActionCard({
  icon: Icon,
  title,
  count,
  isLoading,
  emptyLabel,
  viewAllHref,
  children,
}: {
  icon: React.ElementType;
  title: string;
  count: number;
  isLoading: boolean;
  emptyLabel: string;
  viewAllHref?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-none border-border/60">
      <CardHeader className="py-3 px-4 border-b border-border/50 bg-muted/20 flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          {!isLoading && count > 0 && (
            <Badge className="h-5 min-w-5 px-1.5 justify-center bg-primary text-primary-foreground border-transparent">{count}</Badge>
          )}
        </div>
        {viewAllHref && count > 0 && (
          <Link href={viewAllHref} className="text-xs text-muted-foreground hover:text-primary">View all</Link>
        )}
      </CardHeader>
      <CardContent className="p-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : count === 0 ? (
          <p className="text-xs text-muted-foreground py-2 px-1">{emptyLabel}</p>
        ) : (
          <div className="space-y-1">{children}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ActionRow({ href, primary, secondary, badge }: { href: string; primary: string; secondary?: string; badge?: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 transition-colors"
      data-testid="link-action-row"
    >
      <div className="min-w-0">
        <p className="font-medium truncate">{primary}</p>
        {secondary && <p className="text-xs text-muted-foreground truncate">{secondary}</p>}
      </div>
      {badge}
    </Link>
  );
}

const MAX_ROWS_PER_CARD = 4;

export function PamActionQueue() {
  const { data: awaitingDecision, isLoading: loadingAwaiting } = useListProspects({ status: 'new' });
  const { data: deferred, isLoading: loadingDeferred } = useListProspects({ status: 'deferred' });
  const { data: recruitments, isLoading: loadingRecruitments } = useListRecruitments();
  const { data: recentActivity, isLoading: loadingActivity } = useListRecentProspectActivity({ days: 7 });

  // Deterministic, explainable rule already used elsewhere (Recruitment
  // list/Copilot): is_stalled (>14 days in an active stage, server-derived)
  // or a follow_up_date that has already passed. Never a fabricated "needs
  // update" signal.
  const today = new Date().toISOString().slice(0, 10);
  const recruitmentsNeedingAttention = (recruitments ?? []).filter(
    (r) => r.is_stalled || (r.follow_up_date && r.follow_up_date < today),
  );

  // Deferred prospects needing attention: reuse the same next_action
  // freshness signal My Prospects already shows (never "none" once stale) --
  // no new due-date concept invented. Stale ones surface first.
  const sortedDeferred = [...(deferred ?? [])].sort((a, b) => {
    const aStale = a.next_action !== 'none' ? 0 : 1;
    const bStale = b.next_action !== 'none' ? 0 : 1;
    return aStale - bStale;
  });

  return (
    <div>
      <h2 className="text-base font-semibold tracking-tight mb-1">Your Actions</h2>
      <p className="text-xs text-muted-foreground mb-3">What needs your attention right now.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <ActionCard
          icon={ListChecks}
          title="Awaiting decision"
          count={awaitingDecision?.length ?? 0}
          isLoading={loadingAwaiting}
          emptyLabel="No assigned prospects awaiting a decision."
          viewAllHref="/new-partners"
        >
          {(awaitingDecision ?? []).slice(0, MAX_ROWS_PER_CARD).map((p) => (
            <ActionRow
              key={p.id}
              href={`/new-partners?id=${p.id}`}
              primary={p.company.name}
              secondary={p.partner_type}
              badge={<Badge variant={p.priority === 'A' ? 'default' : 'outline'} className="font-normal shrink-0">{p.priority}</Badge>}
            />
          ))}
        </ActionCard>

        <ActionCard
          icon={Clock}
          title="Deferred, needs attention"
          count={sortedDeferred.length}
          isLoading={loadingDeferred}
          emptyLabel="No deferred prospects."
          viewAllHref="/new-partners"
        >
          {sortedDeferred.slice(0, MAX_ROWS_PER_CARD).map((p) => (
            <ActionRow
              key={p.id}
              href={`/new-partners?id=${p.id}`}
              primary={p.company.name}
              secondary={p.next_action !== 'none' ? 'Evidence may be stale' : 'Deferred'}
              badge={p.next_action !== 'none' ? <Badge variant="outline" className="font-normal shrink-0 border-amber-200 text-amber-700 bg-amber-50">Refresh</Badge> : undefined}
            />
          ))}
        </ActionCard>

        <ActionCard
          icon={TrendingUp}
          title="Recruitment needs attention"
          count={recruitmentsNeedingAttention.length}
          isLoading={loadingRecruitments}
          emptyLabel="No stalled or overdue recruitments."
          viewAllHref="/recruitment"
        >
          {recruitmentsNeedingAttention.slice(0, MAX_ROWS_PER_CARD).map((r) => (
            <ActionRow
              key={r.id}
              href={`/recruitment?id=${r.id}`}
              primary={r.company.name}
              secondary={r.is_stalled ? `Stalled · ${r.days_in_stage}d in ${r.stage.replace(/_/g, ' ')}` : `Follow-up overdue · ${r.follow_up_date}`}
              badge={<Badge variant="outline" className="font-normal shrink-0 border-rose-200 text-rose-700 bg-rose-50">{r.is_stalled ? 'Stalled' : 'Overdue'}</Badge>}
            />
          ))}
        </ActionCard>

        <ActionCard
          icon={Activity}
          title="Recent activity · last 7 days"
          count={recentActivity?.length ?? 0}
          isLoading={loadingActivity}
          emptyLabel="No activity logged in the last 7 days."
        >
          {(recentActivity ?? []).slice(0, MAX_ROWS_PER_CARD).map((a) => (
            <ActionRow
              key={a.id}
              href={`/new-partners?id=${a.prospect_id}`}
              primary={a.company_name}
              secondary={EVENT_TYPE_LABELS[a.event_type] ?? a.event_type}
            />
          ))}
        </ActionCard>
      </div>
    </div>
  );
}
