import React, { useState } from 'react';
import {
  useListUsers,
  useListTerritories,
  useUpdateUser,
  useUpdateTerritory,
  getListUsersQueryKey,
  getListTerritoriesQueryKey,
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Pencil } from 'lucide-react';
import type { User } from '@workspace/api-client-react';

export default function SettingsPage() {
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
    <div className="p-6 space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage users, roles, and territory ownership for Partner Radar.
        </p>
      </div>

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

      {/* Edit user dialog */}
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

      {/* Edit territory dialog */}
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
