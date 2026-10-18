import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/queries/sessions";

/**
 * The three things a member's session knows about itself, behind one button.
 *
 * The system prompt it is running (the split between what a provider can cache and what is
 * rewritten) and the tools it can call. eta-old has this per session in the Context panel; here the session is
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
  const prompt = useSession(sessionId)?.prompt;
  return (
    <section>
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {translateText("chat:panel.prompt")}
      </h3>
      {prompt === undefined ? (
        <p className="text-xs text-muted-foreground">
          {translateText("common:states.hasErrors")}
        </p>
      ) : (
        <>
          <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
            stable {prompt.stableChars} / adaptive {prompt.adaptiveChars} ·{" "}
            {prompt.sections.length} blocks
          </p>
          <ul className="mt-1 space-y-0.5">
            {prompt.sections.map((section) => (
              <li key={section.name} className="flex gap-2 text-[10px]">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {section.name}
                </span>
                <span className="shrink-0 font-mono text-faint tabular-nums">
                  {section.stable ? "stable" : "adaptive"} ·{" "}
                  {section.text.length}
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
  const tools = useSession(sessionId)?.tools;
  return (
    <section>
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {translateText("chat:panel.tools")}
      </h3>
      {tools === undefined ? (
        <p className="text-xs text-muted-foreground">
          {translateText("common:states.hasErrors")}
        </p>
      ) : (
        <>
          <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {tools.length} tools
          </p>
          <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5">
            {tools.map((tool) => (
              <li
                key={tool.name}
                title={tool.description}
                className="truncate font-mono text-[10px] text-muted-foreground"
              >
                {tool.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
