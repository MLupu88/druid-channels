import { Card, CardContent } from '@/components/ui/card';
import { ShieldAlert } from 'lucide-react';

export default function AccessDenied() {
  return (
    <div className="min-h-full w-full flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-3 items-center">
            <ShieldAlert className="h-8 w-8 text-rose-500 shrink-0" />
            <h1 className="text-xl font-semibold text-foreground">You don't have access to this workspace</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            This area is limited to certain roles. If you believe this is a mistake, contact your head of channels.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
