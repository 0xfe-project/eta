import type { AttachmentView } from "@eta/client-contracts";
import type { SerializedDraft } from "@eta/client-contracts/composer-doc";
import type { EtaEditorHandle } from "../editor";
import type { TextPlugin } from "../plugin";
import type { Uploads } from "./attachment";
import { serializeDoc } from "@eta/client-contracts/composer-doc";
import { docToMarkdown } from "@eta/client-contracts/composer-markdown";
import { signal } from "nsh";
import { docToStoredMarkdown } from "../markdown";

export interface Outgoing extends Omit<SerializedDraft, "files"> {
  attachments: AttachmentView[];
}

/**
 * The document as the host takes it — `conversations.send`'s `{ text, mentions, attachments,
 * blocks }` — with each folded paste's place as a `PasteRange`, so the sent message folds it the
 * same way. `files` tells whether every attachment block has finished uploading (a message
 * waits for them; a failed one has to be retried or taken out first). Formatted text goes as
 * Markdown (`docToStoredMarkdown`, read back to check it); plain text as its lines.
 */
export function serialize(uploads?: Uploads): TextPlugin & {
  read: () => Outgoing;
  /** The document as it is now: words to send, files still uploading or failed. */
  state: () => {
    blank: boolean;
    uploading: number;
    failed: number;
    files: number;
  };
  /** Re-reads the upload states (an upload ended without changing the document). */
  refresh: () => void;
  /** The text as written now, unchecked: what the recipients' mentions are read from. */
  text: () => string;
} {
  let editor: EtaEditorHandle | undefined;
  const state = signal({ blank: true, uploading: 0, failed: 0, files: 0 });
  /** What goes, cheaply: Markdown as written, unchecked (the words and files, not their escaping). */
  const quick = (handle: EtaEditorHandle) =>
    handle.rich ? docToMarkdown(handle.doc()) : serializeDoc(handle.doc());
  function measure() {
    if (!editor) return;
    const sent = quick(editor);
    let uploading = 0;
    let failed = 0;
    for (const id of sent.files) {
      const upload = uploads?.state(id);
      if (upload?.state === "uploading") uploading++;
      else if (upload?.state !== "done") failed++;
    }
    state.set({
      blank: !sent.text && !sent.files.length,
      uploading,
      failed,
      files: sent.files.length,
    });
  }
  return {
    name: "serialize",
    state,
    editor: {
      setup(handle) {
        editor = handle;
        measure();
        return handle.session.on("revision", measure);
      },
    },
    refresh: measure,
    text: () => (editor ? quick(editor).text : ""),
    read() {
      const sent = editor!.rich
        ? docToStoredMarkdown(editor!.doc())
        : serializeDoc(editor!.doc());
      const attachments: AttachmentView[] = [];
      for (const id of sent.files) {
        const upload = uploads?.state(id);
        if (upload?.state === "done") attachments.push(upload.attachment);
      }
      return {
        text: sent.text,
        blocks: sent.blocks,
        mentions: sent.mentions,
        attachments,
      };
    },
  };
}
