import React from 'react';
import { useListProspects, useListPartners, useListCampaigns, useListTerritories } from '@workspace/api-client-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
  const { data: partners, isLoading: partnersLoading } = useListPartners(scopeParam);
  const { data: campaigns, isLoading: campaignsLoading } = useListCampaigns();

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
          <TabsTrigger value="activities" data-testid="tab-workspace-activities">Activities</TabsTrigger>
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
            <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
              <CardTitle className="text-base font-medium">Partners</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Company</TableHead>
                    <TableHead>Last researched</TableHead>
                    <TableHead>Help needed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {partnersLoading ? (
                    <TableRow><TableCell colSpan={3}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : partners?.length ? (
                    partners.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.company.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {p.last_researched_at ? new Date(p.last_researched_at).toLocaleDateString() : 'Never'}
                        </TableCell>
                        <TableCell>
                          {p.help_needed_type === 'none' ? '—' : (
                            <Badge variant="outline" className="font-normal text-amber-700 bg-amber-50 border-amber-200">
                              {p.help_needed_type.replace(/_/g, ' ')}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No partners yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activities">
          <Card className="shadow-none border-border/60">
            <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
              <CardTitle className="text-base font-medium">Activities</CardTitle>
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
