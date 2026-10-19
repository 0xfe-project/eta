import type { DraftPart } from "@/lib/composer";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { charCount } from "@/lib/composer";
// Blocks as the composer and the transcript show them: one bracketed line,
// like the terminals' own `[Pasted text #1 +42 lines]`, that opens what it
// stands for.

const CHIP =
  "inline-flex max-w-full items-center gap-[0.5ch] align-bottom text-muted-foreground";
const LINK =
  "min-w-0 truncate underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring";
const ACTION =
  "shrink-0 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring";

/** A paste's whole text. */
function Viewer({
  open,
  onOpenChange,
  title,
  children,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden sm:max-w-3xl">
        <DialogTitle className="truncate pr-8">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {translateText("attachments.fullContentLabel", { name: title })}
        </DialogDescription>
        <div className="min-h-0 overflow-auto">{children}</div>
        {actions ? <DialogFooter>{actions}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

/** What a block in the composer can do to itself. */
export interface BlockActions {
  remove: () => void;
  /** Put a paste's text in its place. */
  expand: () => void;
}

function PasteBlock({
  part,
  remove,
  expand,
}: {
  part: Extract<DraftPart, { type: "paste" }>;
} & BlockActions) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [open, setOpen] = useState(false);
  const title = translateText("attachments.pastedTextSummary", {
    characterCount: charCount(part.text),
  });
  return (
    <span className={CHIP}>
      <button type="button" className={LINK} onClick={() => setOpen(true)}>
        [{title}]
      </button>
      <button
        type="button"
        className={ACTION}
        aria-label={translateText("attachments.removePastedText")}
        onClick={remove}
      >
        ×
      </button>
      <Viewer
        open={open}
        onOpenChange={setOpen}
        title={title}
        actions={
          <>
            <Button variant="outline" onClick={expand}>
              {translateText("attachments.expandText")}
            </Button>
            <Button variant="outline" onClick={remove}>
              {translateText("common:actions.remove")}
            </Button>
          </>
        }
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6]">
          {part.text}
        </pre>
      </Viewer>
    </span>
  );
}

/** A block in the composer. */
export function ComposerBlock({
  part,
  ...actions
}: {
  part: DraftPart;
} & BlockActions) {
  return part.type === "paste" ? <PasteBlock part={part} {...actions} /> : null;
}
