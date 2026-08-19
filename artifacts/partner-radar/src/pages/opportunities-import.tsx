import React, { useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import * as XLSX from 'xlsx';
import {
  useListUsers,
  useListTerritories,
  useListOpportunities,
  getListOpportunitiesQueryKey,
  getGetHeadOfChannelsKpisQueryKey,
  getGetKpiDetailsQueryKey,
  getListMetricTargetsQueryKey,
  getListTeamTargetsQueryKey,
  reconcileOpportunityImport,
  ensureOpportunityImportCompany,
  createOpportunity,
  ApiError,
} from '@workspace/api-client-react';
import type { CompanyRef } from '@workspace/api-client-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, AlertCircle } from 'lucide-react';
import {
  IMPORT_CSV_COLUMNS,
  buildCsvTemplate,
  buildActivePamsByEmail,
  buildTerritoriesByOwnerUserId,
  buildAlreadyImportedExternalIds,
  normalizeDomainForLookup,
  normalizeImportRows,
  validateHeaders,
  validateImportRows,
  type ValidatedImportRow,
  type ImportRowOutcome,
  type ImportReferenceData,
  type ImportReconciliation,
} from '@/lib/opportunity-import';

// Reads a .csv file into row objects keyed by header text -- same XLSX-based
// approach as pages/portfolio-import.tsx's parseSpreadsheetFile, just scoped
// to CSV only (this importer's contract, see IMPORT_CSV_COLUMNS).
function parseCsvFile(file: File): Promise<Record<string, string>[]> {
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

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const STATUS_STYLES: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  needs_review: 'bg-amber-50 text-amber-700 border-amber-200',
  duplicate: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
};

const STATUS_LABELS: Record<string, string> = { ready: 'Ready', needs_review: 'Needs review', duplicate: 'Duplicate', error: 'Error' };

export default function OpportunitiesImport() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<ValidatedImportRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [headerErrors, setHeaderErrors] = useState<string[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportRowOutcome[] | null>(null);
  const [providerWarning, setProviderWarning] = useState<string | null>(null);

  const { data: users } = useListUsers();
  const { data: territories } = useListTerritories();
  // Unfiltered (Head/Admin) list returns every opportunity, including
  // source_system/external_id -- the same data this page needs to
  // pre-detect "already imported" duplicates client-side (see
  // opportunity-import.ts's buildAlreadyImportedExternalIds).
  const { data: existingOpportunities } = useListOpportunities({});

  const readyRows = useMemo(() => rows?.filter((r) => r.status === 'ready') ?? [], [rows]);
  const duplicateRows = useMemo(() => rows?.filter((r) => r.status === 'duplicate') ?? [], [rows]);
  const needsReviewRows = useMemo(() => rows?.filter((r) => r.status === 'needs_review') ?? [], [rows]);
  const errorRows = useMemo(() => rows?.filter((r) => r.status === 'error') ?? [], [rows]);

  const referenceReady = !!users && !!territories && !!existingOpportunities;

  const resetImport = () => {
    setRows(null);
    setFileName(null);
    setHeaderErrors([]);
    setOutcomes(null);
    setProviderWarning(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFile = async (file: File) => {
    if (!referenceReady) {
      toast({ variant: 'destructive', title: 'Still loading reference data', description: 'Try again in a moment.' });
      return;
    }
    setIsResolving(true);
    setOutcomes(null);
    setProviderWarning(null);
    try {
      const rawRows = await parseCsvFile(file);
      if (rawRows.length === 0) {
        toast({ variant: 'destructive', title: 'No rows found in that file' });
        setIsResolving(false);
        return;
      }

      const headerKeys = Object.keys(rawRows[0]!);
      const missing = validateHeaders(headerKeys);
      if (missing.length > 0) {
        setHeaderErrors(missing);
        setRows(null);
        setFileName(file.name);
        setIsResolving(false);
        return;
      }
      setHeaderErrors([]);

      // Normalize every row's keys ONCE, immediately, before any
      // field-specific read (Phase 5B-3 blocker A1) -- a header like
      // "Partner_Domain" already passes validateHeaders above (which
      // normalizes for its own comparison), so every later read must go
      // through this same normalized shape, never a raw r.partner_domain
      // property access.
      const normalizedRows = normalizeImportRows(rawRows);

      const reconciliation = await reconcileOpportunityImport(normalizedRows.map((row, index) => ({
        row_number: index + 1,
        partner_domain: row.partner_domain,
        opportunity_name: row.opportunity_name,
      })));
      setProviderWarning(reconciliation.provider_warning);
      const companiesByDomain = new Map<string, CompanyRef>();
      const ambiguousDomains = new Set<string>();
      const reconciliationByRow = new Map<number, ImportReconciliation>();
      for (const result of reconciliation.rows) {
        const normalizedDomain = normalizeDomainForLookup(normalizedRows[result.row_number - 1]?.partner_domain);
        if (normalizedDomain && result.company_source === 'local' && result.company) companiesByDomain.set(normalizedDomain, result.company);
        if (normalizedDomain && result.company_source === 'ambiguous') ambiguousDomains.add(normalizedDomain);
        reconciliationByRow.set(result.row_number, {
          company: result.company,
          companySource: result.company_source,
          hubspotCompanyId: result.hubspot_company_id,
          hubspotCompanyName: result.hubspot_company_name,
          hubspotCompanyCountry: result.hubspot_company_country,
          deal: result.deal,
          dealAmbiguous: result.deal_ambiguous,
          notes: [],
        });
      }

      const ref: ImportReferenceData = {
        companiesByDomain,
        ambiguousDomains,
        activePamsByEmail: buildActivePamsByEmail(users!),
        territoriesByOwnerUserId: buildTerritoriesByOwnerUserId(territories!),
        alreadyImportedExternalIds: buildAlreadyImportedExternalIds(existingOpportunities!),
        reconciliationByRow,
      };

      setRows(validateImportRows(normalizedRows, ref));
      setFileName(file.name);
    } catch {
      toast({ variant: 'destructive', title: 'Could not read that file' });
    } finally {
      setIsResolving(false);
    }
  };

  const invalidateCommercialQueries = () => {
    queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetHeadOfChannelsKpisQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetKpiDetailsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListMetricTargetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTeamTargetsQueryKey() });
  };

  const handleConfirm = async () => {
    if (readyRows.length === 0) return;
    setIsConfirming(true);
    // Bounded, strictly sequential -- one POST /opportunities at a time,
    // never fired concurrently. Every row's outcome is recorded
    // individually; a failure partway through never silently drops the
    // remaining rows or gets reported as a full success.
    const results: ImportRowOutcome[] = [];
    for (const row of readyRows) {
      const externalId = row.input!.external_id!;
      try {
        let input = row.input!;
        if (row.pendingCompany) {
          const company = await ensureOpportunityImportCompany({
            domain: row.pendingCompany.domain,
            name: row.pendingCompany.name,
            country: row.pendingCompany.country,
            hubspot_company_id: row.pendingCompany.hubspotCompanyId,
          });
          input = { ...input, company_id: company.id };
        }
        await createOpportunity(input);
        results.push({ rowNumber: row.rowNumber, externalId, outcome: 'imported' });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          results.push({ rowNumber: row.rowNumber, externalId, outcome: 'duplicate', reason: 'Already imported (detected on confirm).' });
        } else {
          const reason = err instanceof Error ? err.message : 'Unknown error';
          results.push({ rowNumber: row.rowNumber, externalId, outcome: 'failed', reason });
        }
      }
    }
    setOutcomes(results);
    setIsConfirming(false);
    invalidateCommercialQueries();
    const imported = results.filter((r) => r.outcome === 'imported').length;
    const skipped = results.filter((r) => r.outcome === 'duplicate').length;
    const failed = results.filter((r) => r.outcome === 'failed').length;
    toast({
      title: `Imported ${imported} opportunit${imported === 1 ? 'y' : 'ies'}`,
      description: skipped || failed ? `${skipped} duplicate(s) skipped, ${failed} failed.` : undefined,
    });
  };

  if (outcomes) {
    const imported = outcomes.filter((r) => r.outcome === 'imported').length;
    const skipped = outcomes.filter((r) => r.outcome === 'duplicate').length;
    const failed = outcomes.filter((r) => r.outcome === 'failed');
    return (
      <div className="p-6 max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/opportunities"><Button variant="ghost" size="icon" className="h-8 w-8"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Import results</h1>
            <p className="text-sm text-muted-foreground mt-1">{fileName}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="font-normal bg-emerald-50 text-emerald-700 border-emerald-200">{imported} Imported</Badge>
          <Badge variant="outline" className="font-normal bg-indigo-50 text-indigo-700 border-indigo-200">{skipped} Duplicate (skipped)</Badge>
          <Badge variant="outline" className="font-normal bg-rose-50 text-rose-700 border-rose-200">{failed.length} Failed</Badge>
        </div>

        {failed.length > 0 && (
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4 space-y-2">
              <p className="text-sm font-medium">Failed rows</p>
              {failed.map((r) => (
                <div key={r.rowNumber} className="text-sm text-muted-foreground flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-rose-600 mt-0.5 shrink-0" />
                  <span>Row {r.rowNumber} ({r.externalId}): {r.reason}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="flex gap-2">
          <Link href="/opportunities"><Button>Return to Opportunities</Button></Link>
          <Button variant="outline" onClick={resetImport}>Import another file</Button>
        </div>
      </div>
    );
  }

  if (rows) {
    return (
      <div className="p-6 max-w-5xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={resetImport}><ArrowLeft className="h-4 w-4" /></Button>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Review import</h1>
              <p className="text-sm text-muted-foreground mt-1">{fileName} · {rows.length} row{rows.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          {readyRows.length > 0 && (
            <Button onClick={handleConfirm} disabled={isConfirming}>
              {isConfirming ? 'Importing...' : `Import ${readyRows.length} ready row${readyRows.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="font-normal">{rows.length} Total</Badge>
          <Badge variant="outline" className={`font-normal ${STATUS_STYLES.ready}`}>{readyRows.length} Ready</Badge>
          <Badge variant="outline" className={`font-normal ${STATUS_STYLES.needs_review}`}>{needsReviewRows.length} Needs review</Badge>
          <Badge variant="outline" className={`font-normal ${STATUS_STYLES.duplicate}`}>{duplicateRows.length} Duplicate</Badge>
          <Badge variant="outline" className={`font-normal ${STATUS_STYLES.error}`}>{errorRows.length} Error</Badge>
        </div>

        {providerWarning && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">{providerWarning}</p>}

        <Card className="shadow-none border-border/70">
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Row</TableHead>
                  <TableHead>External ID</TableHead>
                  <TableHead>Partner</TableHead>
                  <TableHead>PAM</TableHead>
                  <TableHead>Opportunity</TableHead>
                  <TableHead>Attribution</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Opp. date</TableHead>
                  <TableHead>Close date</TableHead>
                  <TableHead>Credit date</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.rowNumber}>
                    <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
                    <TableCell className="font-mono text-xs">{r.input?.external_id || r.raw.external_id || '—'}</TableCell>
                    <TableCell>{r.resolved?.companyName ?? (r.pendingCompany ? `${r.pendingCompany.name} (HubSpot)` : (r.raw.partner_domain || '—'))}</TableCell>
                    <TableCell>{r.resolved?.userName ?? (r.raw.pam_email || '—')}</TableCell>
                    <TableCell className="max-w-[180px] truncate">{r.raw.opportunity_name || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.raw.attribution_type || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.raw.status || 'open'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.raw.deal_value || '—'} {r.raw.currency || ''}</TableCell>
                    <TableCell className="text-muted-foreground">{r.raw.opportunity_date || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.raw.closed_at || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.raw.credit_date || '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`font-normal ${STATUS_STYLES[r.status]}`}>{STATUS_LABELS[r.status]}</Badge>
                      {r.errors.length > 0 && (
                        <div className="text-xs text-muted-foreground mt-1 space-y-0.5 max-w-[220px]">
                          {r.errors.map((e, i) => <div key={i}>{e}</div>)}
                        </div>
                      )}
                      {r.notes.length > 0 && (
                        <div className="text-xs text-muted-foreground mt-1 space-y-0.5 max-w-[260px]">
                          {r.notes.map((note, i) => <div key={i}>{note}</div>)}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/opportunities"><Button variant="ghost" size="icon" className="h-8 w-8"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Import historical opportunities</h1>
          <p className="text-sm text-muted-foreground mt-1">Use this import for historical opportunities from before Druid Channels became the ongoing system of record.</p>
        </div>
      </div>

      <Card className="shadow-none border-border/70">
        <CardContent className="p-5 space-y-4">
          <div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => downloadTextFile('opportunities_import_template.csv', buildCsvTemplate(), 'text/csv')}
            >
              <Download className="h-3.5 w-3.5" /> Download CSV template
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Required columns: {IMPORT_CSV_COLUMNS.join(', ')}. Common status, currency, attribution, email-display, slash-date, and Excel-date formats are normalized. Company and PAM matching remain exact; HubSpot reconciliation is read-only and optional.
            </p>
          </div>

          <div>
            <input ref={fileInputRef} type="file" accept=".csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} className="text-sm" disabled={isResolving} />
            {isResolving && <p className="text-xs text-muted-foreground mt-2">Validating rows...</p>}
          </div>

          {headerErrors.length > 0 && (
            <div className="text-sm text-rose-600 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Could not read {fileName}</p>
                {headerErrors.map((e, i) => <p key={i}>{e}</p>)}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
