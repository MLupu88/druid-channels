import React, { useState } from 'react';
import { useGetPamCommercialRollup, type PamCommercialRollupCounts } from '@workspace/api-client-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { WorkspaceSubNav } from '@/components/workspace-subnav';
import { PageHeader } from '@/components/page-header';
import { MetricTile } from '@/components/metric-tile';
import { PamCommercialWorkspace } from '@/components/pam-commercial-workspace';
import { REPORTING_SUBNAV_ITEMS } from '@/lib/navigation';
import {
  OTHER_ASSIGNEES_LABEL,
  OTHER_ASSIGNEES_NOTE,
  ROLLUP_COUNT_KEYS,
  ROLLUP_CRM_NOTE,
  ROLLUP_SCOPE_NOTE,
  ROLLUP_TOTAL_LABELS,
  UNASSIGNED_LABEL,
  UNASSIGNED_NOTE,
  formatTerritories,
  hasRelationships,
} from '@/lib/team-commercial';

/**
 * Slice E: Head/Admin team commercial roll-up (Reporting). The roll-up
 * itself is DB-only (GET /pam-commercial/rollup) -- no HubSpot request is
 * made by loading this page. Selecting a PAM opens the existing
 * PamCommercialWorkspace with that PAM's pam_user_id, where HubSpot deals
 * stay lazy, per relationship, exactly as in the PAM's own Commercial tab.
 */
export default function TeamCommercial() {
  const { data, isLoading, isError } = useGetPamCommercialRollup();
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <WorkspaceSubNav items={REPORTING_SUBNAV_ITEMS} />
        <PageHeader title="Commercial" description={ROLLUP_SCOPE_NOTE} />
        <p className="text-xs text-muted-foreground max-w-3xl" data-testid="team-commercial-crm-note">{ROLLUP_CRM_NOTE}</p>

        {isLoading ? (
          <Skeleton className="h-24 w-full max-w-4xl" />
        ) : isError || !data ? (
          <p className="text-sm text-muted-foreground">Could not load the commercial roll-up.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 max-w-4xl" data-testid="team-commercial-totals">
              {ROLLUP_COUNT_KEYS.map((key) => (
                <MetricTile key={key} label={ROLLUP_TOTAL_LABELS[key]} value={data.totals[key]} />
              ))}
            </div>

            <div className="border border-border/60 rounded-md bg-card max-w-5xl overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>PAM</TableHead>
                    <TableHead>Territories</TableHead>
                    {ROLLUP_COUNT_KEYS.map((key) => (
                      <TableHead key={key} className="text-right">{ROLLUP_TOTAL_LABELS[key]}</TableHead>
                    ))}
                    <TableHead className="w-[140px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.pams.map((p) => (
                    <TableRow key={p.pam_user_id} data-testid={`team-commercial-pam-${p.pam_user_id}`}>
                      <TableCell className="font-medium">{p.pam_name}</TableCell>
                      <TableCell className="text-muted-foreground">{formatTerritories(p.territories)}</TableCell>
                      <CountCells counts={p.counts} />
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelected({ id: p.pam_user_id, name: p.pam_name })}
                          data-testid={`button-open-commercial-${p.pam_user_id}`}
                        >
                          Open commercial
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {hasRelationships(data.unassigned) && (
                    <BucketRow label={UNASSIGNED_LABEL} note={UNASSIGNED_NOTE} counts={data.unassigned} testId="team-commercial-unassigned" />
                  )}
                  {hasRelationships(data.other_assignees) && (
                    <BucketRow label={OTHER_ASSIGNEES_LABEL} note={OTHER_ASSIGNEES_NOTE} counts={data.other_assignees} testId="team-commercial-other-assignees" />
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="w-[640px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10 shrink-0">
            <h3 className="font-medium">{selected.name} · Commercial</h3>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setSelected(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-auto p-5">
            <PamCommercialWorkspace key={selected.id} pamUserId={selected.id} pamName={selected.name} />
          </div>
        </div>
      )}
    </div>
  );
}

function CountCells({ counts }: { counts: PamCommercialRollupCounts }) {
  return (
    <>
      {ROLLUP_COUNT_KEYS.map((key) => (
        <TableCell key={key} className="text-right tabular-nums">{counts[key]}</TableCell>
      ))}
    </>
  );
}

// Unassigned / other-assignee buckets: shown as facts, never attributed to a
// PAM and never openable as a PAM workspace.
function BucketRow({ label, note, counts, testId }: { label: string; note: string; counts: PamCommercialRollupCounts; testId: string }) {
  return (
    <TableRow className="bg-muted/20" data-testid={testId}>
      <TableCell className="font-medium text-muted-foreground">{label}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{note}</TableCell>
      <CountCells counts={counts} />
      <TableCell />
    </TableRow>
  );
}
