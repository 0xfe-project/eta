import type { DocNode } from "@eta/client-contracts/composer-doc";
import type { TextPlugin } from "../plugin";

/**
 * Keeps the document where the place keeps its draft (each chat, each task, each popover its
 * own), on every change: the draft comes back after switching away, closing the app or a crash.
 * The place opens the editor with the saved document (`createEtaEditor({ doc })`), so a restored
 * draft is not an undo step. Reading the old composer's drafts once is the store's job
 * (`legacyDraftToDoc`).
 */
export function draft(store: { save: (doc: DocNode) => void }): TextPlugin {
  return {
    name: "draft",
    editor: {
      setup(editor) {
        let queued = false;
        return editor.session.on("revision", () => {
          if (queued) return;
          queued = true;
          // A burst of changes (a paste, fast typing) is saved once.
          queueMicrotask(() => {
            queued = false;
            store.save(editor.doc());
          });
        });
      },
    },
  };
}
