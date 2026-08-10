import React, { useState } from 'react';
import {
  useListTeamTargets,
  getListTeamTargetsQueryKey,
  useUpsertMetricTarget,
} from '@workspace/api-client-react';
import type { TeamTargetRow } from '@workspace/api-client-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PeriodSelector } from '@/components/period-selector';
import { getDefaultPeriodKey } from '@/lib/period';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';

function ProgressBadge({ row }: { row: TeamTargetRow }) {
  if (row.status === 'no_target') {
    return <Badge variant="outline" className="font-normal text-muted-foreground">No target set</Badge>;
  }
  const styles = row.status === 'ahead' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200';
  const label = row.status === 'ahead' ? 'Ahead' : 'Behind';
  return (
    <Badge variant="outline" className={`font-normal ${styles}`}>
      {row.progress_percent !== null ? `${row.progress_percent}%` : '—'} · {label}
    </Badge>
  );
}

export default function TeamTargets() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState(getDefaultPeriodKey());
  const [editingRow, setEditingRow] = useState<TeamTargetRow | null>(null);

  const { data: rows, isLoading } = useListTeamTargets({ period });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListTeamTargetsQueryKey() });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team Targets</h1>
          <p className="text-sm text-muted-foreground mt-1">What each PAM has been asked to achieve this period, and how they're doing against it.</p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      <Card className="shadow-none border-border/70">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>PAM</TableHead>
                <TableHead>Territory</TableHead>
                <TableHead>KPI</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              ) : rows && rows.length > 0 ? (
                rows.map((row) => (
                  <TableRow key={`${row.pam_user_id}-${row.metric_key}`}>
                    <TableCell className="font-medium">{row.pam_name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.territory_name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.metric_label}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.target_value ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.actual_value ?? '—'}</TableCell>
                    <TableCell><ProgressBadge row={row} /></TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditingRow(row)}>
                        {row.target_value === null ? <Plus className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">No PAMs own a territory yet -- assign one from Settings &gt; Team.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editingRow && (
        <EditTargetDialog
          row={editingRow}
          period={period}
          onClose={() => setEditingRow(null)}
          onSaved={() => { invalidate(); setEditingRow(null); }}
        />
      )}
    </div>
  );
}

function EditTargetDialog({ row, period, onClose, onSaved }: { row: TeamTargetRow; period: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [targetValue, setTargetValue] = useState(row.target_value !== null ? String(row.target_value) : '');
  const [note, setNote] = useState('');

  const upsertMutation = useUpsertMetricTarget({
    mutation: {
      onSuccess: () => { toast({ title: 'Target saved' }); onSaved(); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not save target', description: err?.message ?? 'Please try again.' }),
    },
  });

  const canSubmit = targetValue.trim() !== '' && !Number.isNaN(Number(targetValue)) && Number(targetValue) >= 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    upsertMutation.mutate({
      data: {
        metric_key: row.metric_key,
        period: period as any,
        territory_id: row.territory_id,
        pam_user_id: row.pam_user_id,
        target_value: Number(targetValue),
        note: note.trim() || null,
      },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{row.target_value === null ? 'Set target' : 'Edit target'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-border/60 p-3 text-sm space-y-0.5">
            <p className="font-medium">{row.pam_name} · {row.territory_name}</p>
            <p className="text-muted-foreground">{row.metric_label}</p>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Target</Label>
            <Input type="number" min="0" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder="e.g. 15" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Note (optional)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="text-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || upsertMutation.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
