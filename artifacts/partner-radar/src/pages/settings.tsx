import React, { useState, useEffect } from 'react';
import {
  useListUsers,
  useListTerritories,
  useUpdateUser,
  useUpdateTerritory,
  useListScanConfigs,
  useGetScanConfig,
  useUpdateScanConfig,
  useGetIntegrationsStatus,
  getListUsersQueryKey,
  getListTerritoriesQueryKey,
  getListScanConfigsQueryKey,
  getGetScanConfigQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Pencil, Save, Database, Sparkles, Unplug, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import type { User } from '@workspace/api-client-react';

const SIGNAL_OPTIONS = [
  { id: 'new_partners', label: 'New partner prospects' },
  { id: 'rfps', label: 'RFPs / tenders' },
  { id: 'events', label: 'Events' },
  { id: 'ai_moves', label: 'AI moves & investments' },
  { id: 'customer_wins', label: 'Customer wins' },
  { id: 'partnerships', label: 'Partnership announcements' },
];

const INTEGRATION_ICONS: Record<string, React.ElementType> = {
  hubspot: Database,
  ai_scanner: Sparkles,
};

function TeamTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: users, isLoading: usersLoading } = useListUsers();
  const { data: territories, isLoading: territoriesLoading } = useListTerritories();

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [userRole, setUserRole] = useState('');
  const [userTerritory, setUserTerritory] = useState('');
  const [userActive, setUserActive] = useState(true);

  const [editingTerritoryId, setEditingTerritoryId] = useState<string | null>(null);
  const [territoryName, setTerritoryName] = useState('');
  const [territoryOwner, setTerritoryOwner] = useState('');

  const updateUserMutation = useUpdateUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        setEditingUser(null);
        toast({ title: 'User updated' });
      },
    },
  });

  const updateTerritoryMutation = useUpdateTerritory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTerritoriesQueryKey() });
        setEditingTerritoryId(null);
        toast({ title: 'Territory updated' });
      },
    },
  });

  const openUserEdit = (user: User) => {
    setEditingUser(user);
    setUserRole(user.role);
    setUserTerritory(user.territory || '');
    setUserActive(user.active);
  };

  const saveUser = () => {
    if (!editingUser) return;
    updateUserMutation.mutate({
      id: editingUser.id,
      data: {
        role: userRole as any,
        territory: userTerritory || null,
        active: userActive,
      },
    });
  };

  const territoryById = new Map(territories?.map((t) => [t.id, t]));
  const openTerritoryEdit = (id: string) => {
    const t = territoryById.get(id);
    if (!t) return;
    setEditingTerritoryId(id);
    setTerritoryName(t.name);
    setTerritoryOwner(t.owner_user_id || '');
  };

  const saveTerritory = () => {
    if (!editingTerritoryId) return;
    updateTerritoryMutation.mutate({
      id: editingTerritoryId,
      data: {
        name: territoryName,
        owner_user_id: territoryOwner || null,
      },
    });
  };

  return (
    <div className="space-y-8">
      <div className="border border-border/60 rounded-md bg-card">
        <div className="p-4 border-b border-border/50 bg-muted/20">
          <h3 className="font-medium text-sm">Users</h3>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Territory</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : (
              users?.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell className="capitalize">{user.role.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="text-muted-foreground">{user.territory || '-'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={user.active ? 'text-emerald-700 bg-emerald-50 border-emerald-200 font-normal' : 'text-muted-foreground font-normal'}>
                      {user.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openUserEdit(user)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="border border-border/60 rounded-md bg-card">
        <div className="p-4 border-b border-border/50 bg-muted/20">
          <h3 className="font-medium text-sm">Territories</h3>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Countries</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {territoriesLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : (
              territories?.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {users?.find((u) => u.id === t.owner_user_id)?.name || 'Unassigned'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{t.countries.join(', ')}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openTerritoryEdit(t.id)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Edit {editingUser?.name}</DialogTitle>
            <DialogDescription>Update role, territory assignment, or active status.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={userRole} onValueChange={setUserRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="head_of_channels">Head of Channels</SelectItem>
                  <SelectItem value="pam">PAM</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Territory</Label>
              <Select value={userTerritory} onValueChange={setUserTerritory}>
                <SelectTrigger><SelectValue placeholder="No territory" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Global">Global</SelectItem>
                  {territories?.map((t) => (
                    <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label>Active</Label>
              <Switch checked={userActive} onCheckedChange={setUserActive} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingUser(null)}>Cancel</Button>
            <Button onClick={saveUser} disabled={updateUserMutation.isPending}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingTerritoryId} onOpenChange={(open) => !open && setEditingTerritoryId(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Edit territory</DialogTitle>
            <DialogDescription>Update the territory name or its assigned owner.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={territoryName} onChange={(e) => setTerritoryName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Owner</Label>
              <Select value={territoryOwner} onValueChange={setTerritoryOwner}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  {users?.map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingTerritoryId(null)}>Cancel</Button>
            <Button onClick={saveTerritory} disabled={updateTerritoryMutation.isPending}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WhatToLookForTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: configs, isLoading: isConfigsLoading } = useListScanConfigs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localConfig, setLocalConfig] = useState<any>(null);

  const { data: detail, isLoading: isDetailLoading } = useGetScanConfig(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetScanConfigQueryKey(selectedId || '') } }
  );

  const updateMutation = useUpdateScanConfig({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListScanConfigsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetScanConfigQueryKey(data.id) });
        setLocalConfig(data);
        toast({ title: 'Preferences saved' });
      }
    }
  });

  useEffect(() => {
    if (configs && configs.length > 0 && !selectedId) {
      setSelectedId(configs[0].id);
    }
  }, [configs, selectedId]);

  useEffect(() => {
    if (detail) {
      setLocalConfig(JSON.parse(JSON.stringify(detail)));
    }
  }, [detail]);

  const handleSave = () => {
    if (!selectedId || !localConfig) return;
    updateMutation.mutate({
      id: selectedId,
      data: {
        partner_types: localConfig.partner_types,
        industries: localConfig.industries,
        technologies: localConfig.technologies,
        excluded_domains: localConfig.excluded_domains,
        target_signals: localConfig.target_signals,
        max_results: localConfig.max_results,
        min_checks_required: localConfig.min_checks_required,
        recency_window_days: localConfig.recency_window_days
      }
    });
  };

  const handleArrayChange = (field: string, val: string) => {
    setLocalConfig((prev: any) => ({
      ...prev,
      [field]: val.split(',').map(s => s.trim()).filter(Boolean)
    }));
  };

  return (
    <div className="flex gap-6">
      <div className="w-56 shrink-0">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Territory</div>
        <div className="space-y-1">
          {isConfigsLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)
          ) : (
            configs?.map(config => (
              <button
                key={config.id}
                onClick={() => setSelectedId(config.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${selectedId === config.id ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted text-foreground/80'}`}
              >
                {config.territory_name}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 space-y-6">
        {isDetailLoading || !localConfig ? (
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">What to look for</CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-5">
                <div className="grid grid-cols-2 gap-2">
                  {SIGNAL_OPTIONS.map(opt => {
                    const selected: string[] = localConfig.target_signals || [];
                    const checked = selected.includes(opt.id);
                    return (
                      <div key={opt.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`sig-${opt.id}`}
                          checked={checked}
                          onCheckedChange={(value) => {
                            setLocalConfig((prev: any) => ({
                              ...prev,
                              target_signals: value
                                ? [...(prev.target_signals || []), opt.id]
                                : (prev.target_signals || []).filter((s: string) => s !== opt.id),
                            }));
                          }}
                        />
                        <Label htmlFor={`sig-${opt.id}`} className="font-normal cursor-pointer">{opt.label}</Label>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">Market focus</CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-5">
                <div className="grid grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <Label>Partner types (comma separated)</Label>
                    <Input
                      value={localConfig.partner_types?.join(', ') || ''}
                      onChange={e => handleArrayChange('partner_types', e.target.value)}
                      placeholder="e.g. SI, VAR, Consulting"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Industries (comma separated)</Label>
                    <Input
                      value={localConfig.industries?.join(', ') || ''}
                      onChange={e => handleArrayChange('industries', e.target.value)}
                      placeholder="e.g. Finance, Healthcare, Retail"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Technologies / adjacencies (comma separated)</Label>
                  <Input
                    value={localConfig.technologies?.join(', ') || ''}
                    onChange={e => handleArrayChange('technologies', e.target.value)}
                    placeholder="e.g. Microsoft 365, Azure, SAP"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Excluded domains (comma separated)</Label>
                  <Input
                    value={localConfig.excluded_domains?.join(', ') || ''}
                    onChange={e => handleArrayChange('excluded_domains', e.target.value)}
                    placeholder="e.g. microsoft.com, amazon.com"
                  />
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={updateMutation.isPending}>
                <Save className="h-4 w-4 mr-2" />
                Save preferences
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const { data, isLoading } = useGetIntegrationsStatus();

  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-sm text-muted-foreground">
        Phase 0 integrations run in mock mode — no live third-party API calls are made yet, but the
        connection state below reflects real activity recorded in Partner Radar.
      </p>
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          {data?.integrations.map((integration) => {
            const Icon = INTEGRATION_ICONS[integration.id] ?? Unplug;
            return (
              <Card key={integration.id} className="shadow-none border-border/60">
                <CardHeader className="flex flex-row items-start justify-between py-4 px-5 border-b border-border/50 bg-muted/20 space-y-0">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base font-medium">{integration.name}</CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5">{integration.description}</p>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      integration.connected
                        ? 'text-emerald-700 bg-emerald-50 border-emerald-200 font-normal shrink-0'
                        : 'text-muted-foreground font-normal shrink-0'
                    }
                  >
                    {integration.connected ? (
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Connected
                      </span>
                    ) : (
                      'Not connected'
                    )}
                  </Badge>
                </CardHeader>
                <CardContent className="p-5 grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Mode</p>
                    <p className="text-sm font-medium mt-1 capitalize">{integration.mode}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Records synced</p>
                    <p className="text-sm font-medium mt-1 tabular-nums">{integration.records_synced}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Last sync</p>
                    <p className="text-sm font-medium mt-1">
                      {integration.last_sync_at ? format(new Date(integration.last_sync_at), 'MMM d, HH:mm') : 'Never'}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your team, what Partner Radar looks for, and connected integrations.
        </p>
      </div>

      <Tabs defaultValue="team">
        <TabsList>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="what-to-look-for">What to look for</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>
        <TabsContent value="team" className="mt-6">
          <TeamTab />
        </TabsContent>
        <TabsContent value="what-to-look-for" className="mt-6">
          <WhatToLookForTab />
        </TabsContent>
        <TabsContent value="integrations" className="mt-6">
          <IntegrationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
