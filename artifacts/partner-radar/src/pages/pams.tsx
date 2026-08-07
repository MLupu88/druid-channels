import React, { useState } from 'react';
import { useListUsers, useListTerritories } from '@workspace/api-client-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import { PamWorkspace } from '@/pages/pam-workspace';

export default function Pams() {
  const { data: users, isLoading } = useListUsers();
  const { data: territories } = useListTerritories();
  const [selected, setSelected] = useState<{ id: string; name: string; territoryId?: string } | null>(null);

  const pams = users?.filter((u) => u.role === 'pam') ?? [];
  const territoryByName = new Map((territories ?? []).map((t) => [t.name, t]));

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PAMs</h1>
          <p className="text-sm text-muted-foreground mt-1">Your channels and alliances team, by territory.</p>
        </div>

        <div className="border border-border/60 rounded-md bg-card max-w-3xl">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Territory</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[120px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ))
              ) : (
                pams.map((u) => {
                  const territory = u.territory ? territoryByName.get(u.territory) : undefined;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.name}</TableCell>
                      <TableCell className="text-muted-foreground">{u.territory || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{u.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={u.active ? 'text-emerald-700 bg-emerald-50 border-emerald-200 font-normal' : 'text-muted-foreground font-normal'}>
                          {u.active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!territory}
                          onClick={() => territory && setSelected({ id: u.id, name: u.name, territoryId: territory.id })}
                          data-testid={`button-view-workspace-${u.id}`}
                        >
                          View workspace
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {selected && (
        <div className="w-[640px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10 shrink-0">
            <h3 className="font-medium">{selected.name}</h3>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setSelected(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-auto">
            <PamWorkspace territoryId={selected.territoryId} pamName={selected.name} />
          </div>
        </div>
      )}
    </div>
  );
}
