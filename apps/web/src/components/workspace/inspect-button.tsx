import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The three things a member's session knows about itself, behind one button.
 *
 * The system prompt it is running (the split between what a provider can cache and what is
 * rewritten), the tools it can call (and how often one was stopped by an approval), and the
 * session as raw JSON. eta-old has this per session in the Context panel; here the session is
 * the member, so the button lives on the member's card.
 */
export function InspectButton({ sessionId }: { sessionId: string }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
        title={translateText("chat:panel.inspect")}
      >
        {translateText("chat:panel.inspect")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-xs">{sessionId}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <PromptSection sessionId={sessionId} />
            <ToolsSection sessionId={sessionId} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PromptSection({ sessionId }: { sessionId: string }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { data } = useQuery({
    queryKey: ["session-prompt", sessionId],
    enabled: true,
    queryFn: async () => {
      const response = await fetch(`/sessions/${sessionId}/prompt`);
      if (!response.ok) return null;
      return (await response.json()) as {
        sections: {
          name: string;
          stable: boolean;
          chars: number;
          text: string;
        }[];
        stable_chars: number;
        adaptive_chars: number;
        blocks: number;
      };
    },
  });
  return (
    <section>
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {translateText("chat:panel.prompt")}
      </h3>
      {data === null || data === undefined ? (
        <p className="text-xs text-muted-foreground">
          {translateText("common:states.hasErrors")}
        </p>
      ) : (
        <>
          <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
            stable {data.stable_chars} / adaptive {data.adaptive_chars} ·{" "}
            {data.blocks} blocks
          </p>
          <ul className="mt-1 space-y-0.5">
            {data.sections.map((section) => (
              <li key={section.name} className="flex gap-2 text-[10px]">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {section.name}
                </span>
                <span className="shrink-0 font-mono text-faint tabular-nums">
                  {section.stable ? "stable" : "adaptive"} · {section.chars}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ToolsSection({ sessionId }: { sessionId: string }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { data } = useQuery({
    queryKey: ["session-tools", sessionId],
    enabled: true,
    queryFn: async () => {
      const response = await fetch(`/sessions/${sessionId}/tools`);
      if (!response.ok) return null;
      return (await response.json()) as {
        tools: string[];
        active: string[];
        blocked: string[];
        asked: number;
        refused: number;
      };
    },
  });
  return (
    <section>
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {translateText("chat:panel.tools")}
      </h3>
      {data === null || data === undefined ? (
        <p className="text-xs text-muted-foreground">
          {translateText("common:states.hasErrors")}
        </p>
      ) : (
        <>
          <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {data.tools.length} tools
            {data.refused > 0
              ? ` · ${data.refused} ${translateText("chat:tools.refused")}`
              : ""}
          </p>
          <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5">
            {data.tools.map((tool) => (
              <li
                key={tool}
                className="flex gap-2 font-mono text-[10px] text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{tool}</span>
                {data.active.includes(tool) ? (
                  <span aria-hidden="true" className="shrink-0 text-faint">
                    ●
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
