import type { Attachment, DraftPart } from "@/lib/composer";
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
import { attachmentURL, charCount, fileSize, isImage } from "@/lib/composer";
import {
  dropUpload,
  pastedFile,
  pastedPreview,
  retryUpload,
  useOutbox,
} from "@/queries/outbox";

// Blocks as the composer and the transcript show them: one bracketed line,
// like the terminals' own `[Pasted text #1 +42 lines]`, that opens what it
// stands for.

const CHIP =
  "inline-flex max-w-full items-center gap-[0.5ch] align-bottom text-[var(--terminal-muted)]";
const LINK =
  "min-w-0 truncate underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring";
const ACTION =
  "shrink-0 underline-offset-2 outline-none hover:text-[var(--terminal-foreground)] hover:underline focus-visible:ring-1 focus-visible:ring-ring";

function Thumbnail({ src }: { src: string | undefined }) {
  return src ? (
    <img
      src={src}
      alt=""
      className="h-[1.2em] w-auto max-w-[3em] shrink-0 object-cover"
    />
  ) : null;
}

/** An image at full size, or a paste's whole text. */
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

function FileBlock({
  part,
  remove,
}: {
  part: Extract<DraftPart, { type: "file" }>;
} & BlockActions) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const upload = useOutbox((s) => s.uploads[part.id]);
  const local = isImage(part.contentType) ? pastedPreview(part.id) : undefined;
  const attachment = upload?.attachment;
  const failure = upload?.error;
  const uploading = !attachment && !failure;
  return (
    <span className={CHIP}>
      <AttachmentLink
        attachment={attachment}
        name={part.name}
        contentType={part.contentType}
        size={part.size}
        thumbnail={local}
      />
      {uploading ? (
        <span role="status">{translateText("common:states.uploading")}</span>
      ) : null}
      {failure ? (
        <span
          role="alert"
          className="min-w-0 truncate text-[var(--terminal-warning)]"
        >
          {failure}
        </span>
      ) : null}
      {failure && pastedFile(part.id) ? (
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
  part: Exclude<DraftPart, { type: "text" }>;
} & BlockActions) {
  return part.type === "paste" ? (
    <PasteBlock part={part} {...actions} />
  ) : (
    <FileBlock part={part} {...actions} />
  );
}

/**
 * A file as `[name · size]`: images open at full size, other files download.
 * Before it is uploaded, only its name.
 */
function AttachmentLink({
  attachment,
  name,
  contentType,
  size,
  thumbnail,
}: {
  attachment?: Attachment;
  name: string;
  contentType: string;
  size: number;
  thumbnail?: string;
}) {
  const [open, setOpen] = useState(false);
  const image = isImage(contentType);
  const src =
    thumbnail ??
    (attachment && image ? attachmentURL(attachment.id) : undefined);
  const label = (
    <>
      <Thumbnail src={src} />
      <span className="min-w-0 truncate">
        [{name} · {fileSize(size)}]
      </span>
    </>
  );
  if (!attachment && !src)
    return (
      <span className="inline-flex min-w-0 items-center gap-[0.5ch]">
        {label}
      </span>
    );
  if (!image && attachment)
    return (
      <a
        href={attachmentURL(attachment.id)}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-[0.5ch] ${LINK}`}
      >
        {label}
      </a>
    );
  return (
    <>
      <button
        type="button"
        className={`inline-flex items-center gap-[0.5ch] ${LINK}`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <Viewer open={open} onOpenChange={setOpen} title={name}>
        <img src={src} alt={name} className="mx-auto max-h-[70dvh] w-auto" />
      </Viewer>
    </>
  );
}

/** A sent message's long text, folded as it was pasted. */
export function PastedText({ text }: { text: string }) {
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
      <Viewer open={open} onOpenChange={setOpen} title={title}>
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6]">
          {text}
        </pre>
      </Viewer>
    </span>
  );
}

/** A sent message's attachment. */
export function AttachmentChip({ attachment }: { attachment: Attachment }) {
  return (
    <span className={CHIP}>
      <AttachmentLink
        attachment={attachment}
        name={attachment.name}
        contentType={attachment.content_type}
        size={attachment.size}
      />
    </span>
  );
}
