import React, { useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import * as XLSX from 'xlsx';
import {
  useListTerritories,
  useCreatePortfolioImport,
  useGetPortfolioImport,
  getGetPortfolioImportQueryKey,
  useUpdatePortfolioImportRow,
  useConfirmPortfolioImportRow,
  useConfirmPortfolioImportReady,
  useSearchCompanies,
  getSearchCompaniesQueryKey,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, AlertCircle } from 'lucide-react';
import { Link } from 'wouter';

const MATCH_STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  matched_existing_company: 'Matched existing company',
  possible_duplicate: 'Possible duplicate',
  existing_relationship: 'Already in portfolio',
  needs_review: 'Needs review',
  invalid: 'Invalid',
};

const MATCH_STATUS_STYLES: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  matched_existing_company: 'bg-blue-50 text-blue-700 border-blue-200',
  possible_duplicate: 'bg-amber-50 text-amber-700 border-amber-200',
  existing_relationship: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  needs_review: 'bg-amber-50 text-amber-700 border-amber-200',
  invalid: 'bg-rose-50 text-rose-700 border-rose-200',
};

function parseSpreadsheetFile(file: File): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        resolve(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '')]))));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });
}

export default function PortfolioImport() {
  const { isGlobalUser, user } = useAuth();
  const { toast } = useToast();
  const { data: territories } = useListTerritories();
  // Canonical, not users.territory free text -- same resolution as
  // Portfolio's Manual Add: a PAM's own territory is whichever territories
  // row they own (territories.owner_user_id), never something they pick.
  const myTerritory = !isGlobalUser ? territories?.find((t) => t.owner_user_id === user?.id) : undefined;
  const territoriesLoaded = !!territories;
  const pamHasNoTerritory = !isGlobalUser && territoriesLoaded && !myTerritory;

  const [territoryId, setTerritoryId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [batchId, setBatchId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (myTerritory && !territoryId) setTerritoryId(myTerritory.id);
  }, [myTerritory]);

  const createMutation = useCreatePortfolioImport({
    mutation: {
      onSuccess: (data) => { setBatchId(data.id); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Import failed', description: err?.message ?? 'Please try again.' }),
    },
  });

  const handleSubmit = async () => {
    if (!territoryId) {
      toast({ variant: 'destructive', title: 'Select a territory first' });
      return;
    }
    if (mode === 'file') {
      if (!file) {
        toast({ variant: 'destructive', title: 'Choose a file first' });
        return;
      }
      const isCsv = file.name.toLowerCase().endsWith('.csv');
      try {
        const rows = await parseSpreadsheetFile(file);
        if (rows.length === 0) {
          toast({ variant: 'destructive', title: 'No rows found in that file' });
          return;
        }
        createMutation.mutate({ data: { territory_id: territoryId, source_format: isCsv ? 'csv' : 'excel', original_filename: file.name, rows } });
      } catch {
        toast({ variant: 'destructive', title: 'Could not read that file' });
      }
    } else {
      if (!pastedText.trim()) {
        toast({ variant: 'destructive', title: 'Paste a description first' });
        return;
      }
      createMutation.mutate({ data: { territory_id: territoryId, source_format: 'pasted_text', original_filename: null, rows: [{ text: pastedText.trim() }] } });
    }
  };

  if (batchId) {
    return <ImportReview batchId={batchId} onBack={() => setBatchId(null)} />;
  }

  if (pamHasNoTerritory) {
    return (
      <div className="p-6">
        <Card className="shadow-none border-amber-200 bg-amber-50 max-w-lg">
          <CardContent className="p-5 space-y-1">
            <p className="font-medium text-amber-900">No territory assigned</p>
            <p className="text-sm text-amber-800">
              Your account has no canonical territory yet, so a book import cannot be scoped. Contact an admin to have a territory assigned to you.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/portfolio"><Button variant="ghost" size="icon" className="h-8 w-8"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Import your book</h1>
          <p className="text-sm text-muted-foreground mt-1">Excel, CSV, or a pasted partner description. Every row is reviewed before it becomes a Portfolio record.</p>
        </div>
      </div>

      <Card className="shadow-none border-border/70">
        <CardContent className="p-5 space-y-4">
          {isGlobalUser && (
            <div>
              <Label className="text-xs mb-1.5 block">Territory</Label>
              <Select value={territoryId} onValueChange={setTerritoryId}>
                <SelectTrigger><SelectValue placeholder="Select territory" /></SelectTrigger>
                <SelectContent>
                  {territories?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <Tabs value={mode} onValueChange={(v) => setMode(v as 'file' | 'text')}>
            <TabsList>
              <TabsTrigger value="file">Excel / CSV</TabsTrigger>
              <TabsTrigger value="text">Paste description</TabsTrigger>
            </TabsList>
            <TabsContent value="file" className="pt-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground mt-2">Up to 300 rows. First row must be column headers (e.g. Partner, Owner, Country, Status).</p>
            </TabsContent>
            <TabsContent value="text" className="pt-3">
              <Textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder='e.g. "Accenture Romania — active relationship, mostly Microsoft work, spoke to Andrei in May, potential healthcare opportunity."'
                className="min-h-[120px]"
              />
              <p className="text-xs text-muted-foreground mt-2">One partner relationship description per import in v1.</p>
            </TabsContent>
          </Tabs>

          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Processing...' : 'Import & normalize'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ImportReview({ batchId, onBack }: { batchId: string; onBack: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: batch, isLoading } = useGetPortfolioImport(batchId, { query: { queryKey: getGetPortfolioImportQueryKey(batchId) } });
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [companyQuery, setCompanyQuery] = useState('');
  const { data: companyResults } = useSearchCompanies(
    { q: companyQuery },
    { query: { enabled: companyQuery.trim().length >= 2, queryKey: getSearchCompaniesQueryKey({ q: companyQuery }) } },
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetPortfolioImportQueryKey(batchId) });

  const updateRowMutation = useUpdatePortfolioImportRow({
    mutation: { onSuccess: () => { invalidate(); setEditingRowId(null); setCompanyQuery(''); }, onError: (err: any) => toast({ variant: 'destructive', title: 'Could not update row', description: err?.message }) },
  });
  const confirmRowMutation = useConfirmPortfolioImportRow({
    mutation: { onSuccess: () => { invalidate(); toast({ title: 'Row confirmed' }); }, onError: (err: any) => toast({ variant: 'destructive', title: 'Could not confirm', description: err?.message }) },
  });
  const confirmReadyMutation = useConfirmPortfolioImportReady({
    mutation: {
      onSuccess: (data) => { invalidate(); toast({ title: `Imported ${data.confirmed_count} partner${data.confirmed_count === 1 ? '' : 's'}`, description: data.skipped_count ? `${data.skipped_count} row(s) skipped.` : undefined }); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Bulk import failed', description: err?.message }),
    },
  });

  const confirmableReadyCount = useMemo(() => (batch?.counts.ready ?? 0) + (batch?.counts.matched_existing_company ?? 0), [batch]);

  if (isLoading || !batch) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Review import</h1>
            <p className="text-sm text-muted-foreground mt-1">{batch.original_filename ?? 'Pasted description'} · {batch.row_count} row{batch.row_count === 1 ? '' : 's'}</p>
          </div>
        </div>
        {confirmableReadyCount > 0 && (
          <Button onClick={() => confirmReadyMutation.mutate({ id: batchId })} disabled={confirmReadyMutation.isPending}>
            Import all ready ({confirmableReadyCount})
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {Object.entries(batch.counts).map(([status, count]) => (
          <Badge key={status} variant="outline" className={`font-normal ${MATCH_STATUS_STYLES[status] ?? ''}`}>
            {count} {MATCH_STATUS_LABELS[status] ?? status}
          </Badge>
        ))}
      </div>

      <div className="space-y-3">
        {batch.rows.map((row) => {
          const proposal = (row.normalized_proposal ?? {}) as Record<string, any>;
          const confirmable = ['ready', 'matched_existing_company', 'existing_relationship'].includes(row.match_status);
          return (
            <Card key={row.id} className="shadow-none border-border/70">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{proposal.company_name ?? '(no company name)'}</p>
                    <p className="text-xs text-muted-foreground">
                      {proposal.country ?? '—'} · {proposal.partner_type ?? 'unknown type'} · started {proposal.relationship_started_at ?? 'unknown'} ({proposal.started_at_precision ?? 'unknown'})
                    </p>
                  </div>
                  <Badge variant="outline" className={`font-normal ${MATCH_STATUS_STYLES[row.match_status] ?? ''}`}>
                    {MATCH_STATUS_LABELS[row.match_status] ?? row.match_status}
                  </Badge>
                </div>
                {proposal.relationship_summary && <p className="text-sm text-muted-foreground">{proposal.relationship_summary}</p>}
                {row.matched_company && (
                  <p className="text-xs text-muted-foreground">Matched: {row.matched_company.name} ({row.matched_company.domain ?? 'no domain'})</p>
                )}
                {row.resulting_relationship_id ? (
                  <div className="flex items-center gap-1.5 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Confirmed</div>
                ) : (
                  <div className="flex items-center gap-2">
                    {(row.match_status === 'possible_duplicate' || row.match_status === 'needs_review') && (
                      <Button size="sm" variant="outline" onClick={() => setEditingRowId(editingRowId === row.id ? null : row.id)}>
                        {editingRowId === row.id ? 'Cancel' : 'Resolve'}
                      </Button>
                    )}
                    <Button size="sm" disabled={!confirmable || confirmRowMutation.isPending} onClick={() => confirmRowMutation.mutate({ id: batchId, rowId: row.id })}>
                      Confirm
                    </Button>
                    {row.match_status === 'invalid' && (
                      <span className="text-xs text-rose-600 flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" /> No usable company name</span>
                    )}
                  </div>
                )}
                {editingRowId === row.id && (
                  <div className="rounded-md border border-border/60 p-3 space-y-2 bg-muted/20">
                    <Input value={companyQuery} onChange={(e) => setCompanyQuery(e.target.value)} placeholder="Search existing companies..." />
                    {companyResults && companyResults.length > 0 && (
                      <div className="border border-border/60 rounded-md divide-y max-h-[120px] overflow-auto">
                        {companyResults.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted/50"
                            onClick={() => updateRowMutation.mutate({ id: batchId, rowId: row.id, data: { matched_company_id: c.id } })}
                          >
                            {c.name} <span className="text-muted-foreground">({c.domain ?? 'no domain'})</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => updateRowMutation.mutate({ id: batchId, rowId: row.id, data: { matched_company_id: null } })}
                    >
                      No match -- create new company
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
