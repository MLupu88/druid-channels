import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import type { ProspectRemovalReason } from '@workspace/api-client-react';

// Phase 11.5A: shared between prospects.tsx (Discovery) and
// my-prospects.tsx (My Prospects) -- same reason list, same "don't suggest
// again" behavior, same Duplicate special-case, so it's written once. This
// is deliberately just a confirmation dialog, not a general-purpose form:
// the actual delete/exclude call stays in each page's own useDeleteProspect
// mutation (they're wired to different query invalidations), this
// component only collects the reason and calls onConfirm.
const REASON_OPTIONS: { value: ProspectRemovalReason; label: string }[] = [
  { value: 'not_relevant', label: 'Not a relevant partner' },
  { value: 'wrong_match', label: 'Wrong company or bad match' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'bad_source', label: 'Bad source or garbage result' },
  { value: 'other', label: 'Other' },
];

interface RemoveProspectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName?: string;
  isPending: boolean;
  onConfirm: (args: { reason: ProspectRemovalReason; excludeCompany: boolean }) => void;
}

export function RemoveProspectDialog({ open, onOpenChange, companyName, isPending, onConfirm }: RemoveProspectDialogProps) {
  const [reason, setReason] = useState<ProspectRemovalReason>('not_relevant');
  const [excludeCompany, setExcludeCompany] = useState(false);
  const isDuplicate = reason === 'duplicate';

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setReason('not_relevant');
      setExcludeCompany(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Remove {companyName ?? 'this prospect'} from results?</DialogTitle>
          <DialogDescription>
            This permanently removes the prospect and its activity history. This cannot be undone.
            Prospects already in the recruitment process can't be removed this way — update the
            recruitment stage instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-2 block">Why are you removing this?</Label>
            <RadioGroup value={reason} onValueChange={(v) => setReason(v as ProspectRemovalReason)} className="space-y-1.5">
              {REASON_OPTIONS.map((option) => (
                <div key={option.value} className="flex items-center gap-2">
                  <RadioGroupItem value={option.value} id={`remove-reason-${option.value}`} />
                  <Label htmlFor={`remove-reason-${option.value}`} className="font-normal cursor-pointer">{option.label}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-border/60 p-3">
            <Checkbox
              id="exclude-company"
              checked={excludeCompany && !isDuplicate}
              disabled={isDuplicate}
              onCheckedChange={(checked) => setExcludeCompany(checked === true)}
            />
            <div className="grid gap-0.5">
              <Label htmlFor="exclude-company" className={isDuplicate ? 'text-muted-foreground cursor-not-allowed' : 'cursor-pointer'}>
                Don't suggest this company again
              </Label>
              <p className="text-xs text-muted-foreground">
                {isDuplicate
                  ? "Duplicate results won't block this company from future research."
                  : 'Prevents this company from showing up in future Discovery results.'}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm({ reason, excludeCompany: excludeCompany && !isDuplicate })}
            disabled={isPending}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Remove from results
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
