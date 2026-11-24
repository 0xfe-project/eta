import type { AttachmentView } from "@eta/client-contracts";
import type { useHost } from "../../services/host";
import { signal, Storage } from "nsh";
import { createUploadQueue, taskUploads } from "../../services/upload-queue";

type Host = ReturnType<typeof useHost>;

const opened = new Map<string, ReturnType<typeof createCommentFiles>>();

function createCommentFiles(key: string) {
  const ready = signal(false);
  /** The finished uploads, by block id: kept beside the comment's draft, as the chat keeps its. */
  let saved: Record<string, AttachmentView> = {};
  let writes = Promise.resolve();
  function write() {
    const next = saved;
    writes = writes
      .then(() =>
        Object.keys(next).length
          ? Storage.setItem(key, JSON.stringify(next))
          : Storage.removeItem(key),
      )
      .catch(() => {});
  }
  const queue = createUploadQueue({
    onDone(id, attachment) {
      saved = { ...saved, [id]: attachment };
      write();
    },
  });
  void Storage.getItem(key)
    .then((raw) => {
      if (!raw) return;
      saved = JSON.parse(raw) as Record<string, AttachmentView>;
      queue.remember(Object.values(saved));
    })
    .catch(() => {})
    .finally(() => ready.set(true));
  return {
    ready,
    queue,
    /** The attachment plugin's view of the box's uploads. */
    uploads: (host: Host, taskId: string) =>
      queue.uploads(host, taskUploads(host, taskId)),
    /** The comment went with `kept`: the uploads it did not carry are taken back. */
    sent(host: Host, taskId: string, kept: readonly string[]) {
      const left = Object.keys(saved).filter((id) => !kept.includes(id));
      queue.clear(host, taskUploads(host, taskId), left);
      saved = {};
      write();
    },
  };
}

/**
 * The files of a task's comment box (`tasks.attach`): their uploads, and the finished ones kept in
 * `Storage` under `key` beside the box's document, so a draft with a picture outlives the view.
 */
export function openCommentFiles(key: string) {
  let files = opened.get(key);
  if (!files) {
    files = createCommentFiles(key);
    opened.set(key, files);
  }
  return files;
}
