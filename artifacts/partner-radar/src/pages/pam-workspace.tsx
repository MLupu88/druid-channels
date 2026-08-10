import React, { useState } from 'react';
import { Link } from 'wouter';
import { useListProspects, useListCampaigns, useListTerritories, useListTeamTargets } from '@workspace/api-client-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Building2 } from 'lucide-react';
import { PeriodSelector } from '@/components/period-selector';
import { getDefaultPeriodKey } from '@/lib/period';

/**
 * Shared workspace view scoped to a single PAM's territory. Used both as the
 * PAM's own "My workspace" nav entry (no territoryId -- the server defaults
 * to the caller's own territory) and, for the head_of_channels, as the
 * detail view opened from the PAMs directory (explicit territoryId, which
 * the server allows for global-role callers only).
 */
export function PamWorkspace({ territoryId, pamName }: { territoryId?: string; pamName?: string }) {
  const { data: territories } = useListTerritories();
  const territoryName = territoryId ? territories?.find((t) => t.id === territoryId)?.name : undefined;

  const scopeParam = territoryId ? { territory: territoryId } : {};

  const { data: prospects, isLoading: prospectsLoading } = useListProspects(scopeParam);
  const { data: campaigns, isLoading: campaignsLoading } = useListCampaigns();

  const [targetsPeriod, setTargetsPeriod] = useState(getDefaultPeriodKey());
  // No explicit pam_user_id here -- for the PAM's own workspace the server
  // forces this to their own (territory, pam) scope regardless of params
  // (see GET /team-targets); for a Head/Admin drill-down (territoryId
  // passed explicitly), the territory filter is honored since the caller
  // is global. Same endpoint, same data, two views.
  const { data: targetRows, isLoading: targetsLoading } = useListTeamTargets({ period: targetsPeriod, ...scopeParam });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {pamName ? `${pamName}'s workspace` : 'My workspace'}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {territoryName ? `Territory: ${territoryName}` : 'Prospects, partners, and activities for your territory.'}
        </p>
      </div>

      <Tabs defaultValue="prospects">
        <TabsList>
          <TabsTrigger value="prospects" data-testid="tab-workspace-prospects">New partners</TabsTrigger>
          <TabsTrigger value="partners" data-testid="tab-workspace-partners">Partners</TabsTrigger>
          <TabsTrigger value="targets" data-testid="tab-workspace-targets">{pamName ? 'Targets' : 'My targets'}</TabsTrigger>
          <TabsTrigger value="activities" data-testid="tab-workspace-activities">Marketing activities</TabsTrigger>
        </TabsList>

        <TabsContent value="prospects">
          <Card className="shadow-none border-border/60">
            <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
              <CardTitle className="text-base font-medium">New partner prospects</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Company</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prospectsLoading ? (
                    <TableRow><TableCell colSpan={3}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : prospects?.length ? (
                    prospects.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.company.name}</TableCell>
                        <TableCell>{p.priority}</TableCell>
                        <TableCell><Badge variant="outline" className="font-normal">{p.status.replace(/_/g, ' ')}</Badge></TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No prospects yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="partners">
          <Card className="shadow-none border-border/60">
            <CardContent className="p-8 flex flex-col items-center text-center gap-3">
              <Building2 className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">Partners has moved to Portfolio</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Relationship status, activity history, and next actions for your partners now live in the Portfolio workspace.
                </p>
              </div>
              <Link href="/portfolio"><Button size="sm">Open Portfolio</Button></Link>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="targets">
          <Card className="shadow-none border-border/60">
            <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base font-medium">{pamName ? `${pamName}'s targets` : 'My targets'}</CardTitle>
              <PeriodSelector value={targetsPeriod} onChange={setTargetsPeriod} />
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Metric</TableHead>
                    <TableHead className="text-right">Target / Actual</TableHead>
                    <TableHead>Progress</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {targetsLoading ? (
                    <TableRow><TableCell colSpan={3}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : targetRows?.length ? (
                    targetRows.map((row) => (
                      <TableRow key={row.metric_key}>
                        <TableCell className="font-medium">{row.metric_label}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {row.actual_value ?? '—'} / {row.target_value ?? '—'}
                        </TableCell>
                        <TableCell>
                          {row.status === 'no_target' ? (
                            <Badge variant="outline" className="font-normal text-muted-foreground">No target set for this period</Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className={`font-normal ${row.status === 'ahead' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}
                            >
                              {row.progress_percent !== null ? `${row.progress_percent}%` : '—'} · {row.status === 'ahead' ? 'Ahead' : 'Behind'}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No targetable metrics for this territory yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activities">
          <Card className="shadow-none border-border/60">
            <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
              <CardTitle className="text-base font-medium">Marketing Activities</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaignsLoading ? (
                    <TableRow><TableCell colSpan={3}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : campaigns?.length ? (
                    campaigns.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell className="text-muted-foreground">{c.type.replace(/_/g, ' ')}</TableCell>
                        <TableCell><Badge variant="outline" className="font-normal">{c.status}</Badge></TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No activities yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function MyWorkspace() {
  return <PamWorkspace />;
}
