import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useChatWithPamCopilot, ApiError } from '@workspace/api-client-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MessageCircle, Send, Loader2 } from 'lucide-react';
import { getDefaultPeriodKey } from '@/lib/period';

interface ChatEvidenceItem {
  label: string;
  value: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  evidence?: ChatEvidenceItem[];
  suggestedRoute?: string | null;
  followUps?: string[];
  isError?: boolean;
}

const STARTER_PROMPTS = [
  'What should I focus on?',
  'Why am I behind target?',
  'Which recruitments need attention?',
  'Any important Radar signals?',
  'How do I import my partner book?',
];

const FALLBACK_ERROR_MESSAGE = "I couldn't generate an answer right now. Your workspace data is still available; please try again.";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `copilot-msg-${idCounter}`;
}

/**
 * Stage 6.4: floating PAM Workspace Copilot. Grounded, read-only chat over a
 * controlled backend context (see copilotContextService.ts) -- never a
 * generic chatbot, never a write action from chat. History is session-only
 * (component state, cleared on unmount/reload) -- no backend persistence
 * (see the 6.4 report's "chat persistence decision").
 *
 * Rendered inside PamWorkspace (pam-workspace.tsx) so it's always scoped to
 * a real PAM context: with no props, it's the caller's own workspace ("My
 * workspace"); with pamUserId/pamName, it's a Head/Admin's drill-down into
 * that specific PAM's workspace (see pams.tsx).
 */
export function PamCopilot({ pamUserId, pamName }: { pamUserId?: string; pamName?: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [, setLocation] = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);

  const chatMutation = useChatWithPamCopilot();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, chatMutation.isPending]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatMutation.isPending) return;

    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: trimmed }]);
    setInput('');

    chatMutation.mutate(
      {
        data: {
          message: trimmed,
          period: getDefaultPeriodKey(),
          ...(pamUserId ? { pam_user_id: pamUserId } : {}),
        },
      },
      {
        onSuccess: (data) => {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              content: data.answer,
              evidence: data.evidence,
              suggestedRoute: data.suggested_route,
              followUps: data.follow_ups,
            },
          ]);
        },
        onError: (err) => {
          const description = err instanceof ApiError && err.message ? err.message : FALLBACK_ERROR_MESSAGE;
          setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', content: description, isError: true }]);
        },
      },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const goTo = (route: string) => {
    setOpen(false);
    setLocation(route);
  };

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 h-12 rounded-full shadow-lg px-5 gap-2"
        data-testid="button-open-pam-copilot"
      >
        <MessageCircle className="h-5 w-5" />
        <span className="hidden sm:inline">Ask Channel Copilot</span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0 gap-0">
          <SheetHeader className="px-5 py-4 border-b border-border/50 text-left space-y-1 shrink-0">
            <SheetTitle>Channel Copilot</SheetTitle>
            <SheetDescription>{pamName ? `Scoped to ${pamName}'s workspace` : 'Scoped to your workspace'}</SheetDescription>
          </SheetHeader>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Ask about your targets, recruitments, portfolio, Radar signals, or how to use the app.
                </p>
                <div className="flex flex-col gap-2">
                  {STARTER_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => send(p)}
                      className="text-left text-sm rounded-md border border-border/60 px-3 py-2 hover:bg-muted transition-colors"
                      data-testid={`button-copilot-starter-${p.slice(0, 10).replace(/\s+/g, '-').toLowerCase()}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : m.isError
                        ? 'bg-destructive/10 text-destructive border border-destructive/20'
                        : 'bg-muted text-foreground'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>

                  {m.evidence && m.evidence.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
                      {m.evidence.map((e, i) => (
                        <div key={i} className="text-xs text-muted-foreground flex justify-between gap-3">
                          <span>{e.label}</span>
                          <span className="font-medium text-foreground text-right">{e.value}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {m.suggestedRoute && (
                    <button
                      type="button"
                      onClick={() => goTo(m.suggestedRoute!)}
                      className="mt-2 block text-xs font-medium underline underline-offset-2"
                    >
                      Open {m.suggestedRoute}
                    </button>
                  )}

                  {m.followUps && m.followUps.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.followUps.map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => send(f)}
                          className="text-xs rounded-full border border-border/60 bg-background/60 px-2 py-1 hover:bg-background transition-colors"
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {chatMutation.isPending && (
              <div className="flex justify-start">
                <div className="rounded-lg px-3 py-2 bg-muted text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking...
                </div>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="border-t border-border/50 p-3 flex gap-2 shrink-0">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question..."
              className="flex-1 min-w-0"
              data-testid="input-pam-copilot-message"
            />
            <Button type="submit" size="icon" disabled={!input.trim() || chatMutation.isPending} data-testid="button-send-pam-copilot-message">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
