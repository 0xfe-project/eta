import type { DocNode } from "@eta/client-contracts/composer-doc";
import { isBlankDoc } from "@eta/client-contracts/composer-doc";
import { signal, Storage } from "nsh";

const opened = new Map<string, ReturnType<typeof createDocDraft>>();

function createDocDraft(key: string) {
  const ready = signal(false);
  let doc: DocNode | null = null;
  let writes = Promise.resolve();
  void Storage.getItem(key)
    .then((raw) => {
      if (raw) doc = JSON.parse(raw) as DocNode;
    })
    .catch(() => {})
    .finally(() => ready.set(true));
  return {
    ready,
    doc: () => doc,
    save(next: DocNode) {
      doc = next;
      writes = writes
        .then(() =>
          isBlankDoc(next)
            ? Storage.removeItem(key)
            : Storage.setItem(key, JSON.stringify(next)),
        )
        .catch(() => {});
    },
  };
}

/**
 * A draft that is only a document (a task's comment, a popover's words), kept in `Storage` under
 * `key` so it outlives the view and the app. The chat's composer has its own store, which also
 * holds its uploads and outbox.
 */
export function openDocDraft(key: string) {
  let draft = opened.get(key);
  if (!draft) {
    draft = createDocDraft(key);
    opened.set(key, draft);
  }
  return draft;
}
