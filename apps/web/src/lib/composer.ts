import type { Attachment as WireAttachment } from "@/api/control-plane.gen";
import { translate } from "@/lib/i18n";

/**
 * An uploaded file, with the one thing the host added: where it landed in the project.
 *
 * The path is what makes an attachment mean something — the message references it, and the agent
 * opens it the way it opens any other file. The web's generated types still come from the old
 * control plane's document, which has no such field, so it is added here rather than faked.
 */
export interface Attachment extends WireAttachment {
  id: string;
  name: string;
  content_type: string;
  size: number;
  /** Where it landed, relative to the group's folder. */
  path?: string | null;
}

// What the chat composer holds: text the user typed, with blocks among it
// where they pasted long text or files. Blocks are the composer's own: a
// long paste goes out as the text it stands for, a file as an attachment
// uploaded the moment it was pasted.

/**
 * A paste longer than this (in characters, counted as Unicode code points,
 * or in lines) folds into a block. The composer grows to 40% of the
 * window's height, about 12 lines on a phone; 1000 characters is about a
 * screenful of code or log, past which editing it in place stops helping.
 */
export const LONG_PASTE = { chars: 1000, lines: 12 };
/** A message's text at most (the control plane's MaxMessageText). */
export const MAX_MESSAGE_CHARS = 100_000;
/** One attachment, and a message's attachments, at most (chat/attachments.go). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** A paste too long to send as text goes as a file of this name. */
export const pasteFileName = () => translate("chat:attachments.pastedFileName");

export type DraftPart =
  | { type: "text"; text: string }
  /** Long text pasted as a block; sent as the text itself. */
  | { type: "paste"; id: string; text: string }
  /** A file being, or already, uploaded (its state is in the outbox's uploads). */
  | {
      type: "file";
      id: string;
      name: string;
      contentType: string;
      size: number;
    };
export type Draft = DraftPart[];
export type FilePart = Extract<DraftPart, { type: "file" }>;

/** A message's part on its way: text, or an uploaded attachment. */
export type OutgoingPart =
  | { type: "text"; text: string }
  | { type: "attachment"; attachment: Attachment };

export const EMPTY_DRAFT: Draft = [];

export function charCount(text: string) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function isLongPaste(text: string) {
  return (
    text.split("\n").length > LONG_PASTE.lines ||
    charCount(text) > LONG_PASTE.chars
  );
}

export function plainDraft(text: string): Draft {
  return text ? [{ type: "text", text }] : [];
}

/** The draft's text, blocks of pasted text included. */
export function draftText(draft: Draft) {
  return draft.map((p) => (p.type === "file" ? "" : p.text)).join("");
}

/** The draft as one plain string, when it holds no blocks. */
export function onlyText(draft: Draft): string | null {
  return draft.every((p) => p.type === "text")
    ? draft.map((p) => p.text).join("")
    : null;
}

export function isBlank(draft: Draft) {
  return !draft.some((p) => p.type === "file") && !draftText(draft).trim();
}

/**
 * The draft as the message to send, each file as its upload's attachment;
 * undefined for a file that is not uploaded yet. A long paste stays a part
 * of its own, so the transcript folds it again.
 */
export function messageParts(
  draft: Draft,
  uploaded: (id: string) => Attachment | undefined,
): OutgoingPart[] | undefined {
  const parts: OutgoingPart[] = [];
  for (const part of draft) {
    if (part.type !== "file") {
      if (part.text) parts.push({ type: "text", text: part.text });
      continue;
    }
    const attachment = uploaded(part.id);
    if (!attachment) return undefined;
    // A file is a file in the project: the message carries the reference, and the text beside it
    // says the same thing, so what the agent reads and what the person sees agree.
    if (typeof attachment.path === "string" && attachment.path.length > 0) {
      parts.push({ type: "text", text: `@${attachment.path}` });
    }
    parts.push({ type: "attachment", attachment });
  }
  return parts;
}

/** The message's parts with the text after a slash command's name. */
export function afterCommand(
  parts: OutgoingPart[],
  name: string,
): OutgoingPart[] {
  const [first, ...rest] = parts;
  if (first?.type !== "text") return parts;
  const text = first.text.slice(name.length).trimStart();
  return text ? [{ type: "text", text }, ...rest] : rest;
}

export function partsText(parts: OutgoingPart[]) {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * A message's parts back as a draft, to edit and send again: its uploaded
 * attachments as file blocks, long text as a block again.
 */
export function draftOf(parts: OutgoingPart[]): {
  draft: Draft;
  attachments: Record<string, Attachment>;
} {
  const draft: Draft = [];
  const attachments: Record<string, Attachment> = {};
  for (const part of parts) {
    if (part.type === "text") {
      draft.push(
        isLongPaste(part.text)
          ? { type: "paste", id: crypto.randomUUID(), text: part.text }
          : { type: "text", text: part.text },
      );
      continue;
    }
    const id = crypto.randomUUID();
    const { attachment } = part;
    attachments[id] = attachment;
    draft.push({
      type: "file",
      id,
      name: attachment.name,
      contentType: attachment.content_type,
      size: attachment.size,
    });
  }
  return { draft, attachments };
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Shown as an image (a thumbnail) rather than a file. */
export function isImage(contentType: string) {
  return /^image\/(?:png|jpeg|gif|webp)$/.test(contentType);
}

export function attachmentURL(id: string) {
  return `/api/v1/chat/attachments/${id}`;
}
