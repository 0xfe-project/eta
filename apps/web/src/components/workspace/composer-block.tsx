import type { AttachmentView } from "@eta/client-contracts";
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
import { charCount, fileSize } from "@/lib/composer";
import { cn } from "@/lib/utils";
import { dropUpload, retryUpload, useOutbox } from "@/queries/outbox";
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

/**
 * A folded paste: one bracketed line that opens the whole text it stands for. The composer
 * passes the actions its block has (take it out, put the text back); the transcript passes
 * none, where a message's paste is only read.
 */
export function PasteChip({
  text,
  actions,
}: {
  text: string;
  actions?: Partial<BlockActions>;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [open, setOpen] = useState(false);
  const title = translateText("attachments.pastedTextSummary", {
    characterCount: charCount(text),
  });
  return (
    <span className={CHIP}>
      <button type="button" className={LINK} onClick={() => setOpen(true)}>
        [{title}]
      </button>
      {actions?.remove ? (
        <button
          type="button"
          className={ACTION}
          aria-label={translateText("attachments.removePastedText")}
          onClick={actions.remove}
        >
          ×
        </button>
      ) : null}
      <Viewer
        open={open}
        onOpenChange={setOpen}
        title={title}
        actions={
          actions && (actions.remove || actions.expand) ? (
            <>
              {actions.expand ? (
                <Button variant="outline" onClick={actions.expand}>
                  {translateText("attachments.expandText")}
                </Button>
              ) : null}
              {actions.remove ? (
                <Button variant="outline" onClick={actions.remove}>
                  {translateText("common:actions.remove")}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6]">
          {text}
        </pre>
      </Viewer>
    </span>
  );
}

function FileBlock({
  part,
  remove,
}: {
  part: Extract<DraftPart, { type: "file" }>;
  remove: () => void;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const upload = useOutbox((s) => s.uploads[part.id]);
  const failure = upload?.error;
  const uploading = upload?.attachment === undefined && failure === undefined;
  return (
    <span className={CHIP}>
      <span
        className={cn(
          "min-w-0 truncate",
          uploading && "motion-safe:animate-upload-pulse",
        )}
      >
        [{part.name} · {fileSize(part.size)}]
      </span>
      {uploading ? (
        <span role="status">{translateText("common:states.uploading")}</span>
      ) : null}
      {failure ? (
        <span role="alert" className="min-w-0 truncate text-state-warning">
          {failure}
        </span>
      ) : null}
      {failure ? (
        <button
          type="button"
          className={ACTION}
          onClick={() => retryUpload(part.id)}
        >
          {translateText("common:actions.retry")}
        </button>
      ) : null}
      <button
        type="button"
        className={ACTION}
        aria-label={translateText("common:actions.removeItem", {
          name: part.name,
        })}
        onClick={() => {
          dropUpload(part.id);
          remove();
        }}
      >
        ×
      </button>
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
  if (part.type === "paste")
    return <PasteChip text={part.text} actions={actions} />;
  if (part.type === "file")
    return <FileBlock part={part} remove={actions.remove} />;
  return null;
}

/** A sent (or sending) message's attachment: its name and size, on one line. */
export function AttachmentChip({
  attachment,
}: {
  attachment: Pick<AttachmentView, "name" | "size">;
}) {
  return (
    <span className={CHIP}>
      <span className="min-w-0 truncate">
        [{attachment.name} · {fileSize(attachment.size)}]
      </span>
    </span>
  );
}
