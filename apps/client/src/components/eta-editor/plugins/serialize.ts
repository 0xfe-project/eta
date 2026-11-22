import type { AttachmentView } from "@eta/client-contracts";
import type { SerializedDraft } from "@eta/client-contracts/composer-doc";
import type { EtaEditorHandle, EtaPlugin } from "../editor";
import type { Uploads } from "./attachment";
import { serializeDoc } from "@eta/client-contracts/composer-doc";
import { signal } from "nsh";

export interface Outgoing extends Omit<SerializedDraft, "files"> {
  attachments: AttachmentView[];
}

/**
 * The document as the host takes it — `conversations.send`'s `{ text, mentions, attachments,
 * blocks }` — with each folded paste's place as a `PasteRange`, so the sent message folds it the
 * same way. `files` tells whether every attachment block has finished uploading (a message
 * waits for them; a failed one has to be retried or taken out first).
 */
export function serialize(uploads?: Uploads): EtaPlugin & {
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
} {
  let editor: EtaEditorHandle | undefined;
  const state = signal({ blank: true, uploading: 0, failed: 0, files: 0 });
  function measure() {
    if (!editor) return;
    const sent = serializeDoc(editor.doc());
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
    setup(handle) {
      editor = handle;
      measure();
      return handle.session.on("revision", measure);
    },
    refresh: measure,
    read() {
      const sent = serializeDoc(editor!.doc());
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
