import React, { useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import druidLogo from '@/assets/druid-logo.png';

export default function Login() {
  const { login, isLoggingIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err?.message ?? 'Invalid email or password');
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <img src={druidLogo} alt="DRUID" className="h-10 w-auto mb-4" />
          <h1 className="text-lg font-semibold text-foreground">Channels and alliances</h1>
          <p className="text-sm text-muted-foreground mt-1">Internal workspace &mdash; sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-card border border-border/60 rounded-lg p-6 space-y-4 shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@druidai.com"
              required
              data-testid="input-email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              data-testid="input-password"
            />
          </div>

          {error && (
            <p className="text-sm text-rose-600" data-testid="text-login-error">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={isLoggingIn} data-testid="button-login">
            {isLoggingIn ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Sign in
          </Button>
        </form>

        <p className="text-xs text-muted-foreground text-center mt-6">
          Access is limited to DRUID channels &amp; alliances team members.
        </p>
      </div>
    </div>
  );
}
