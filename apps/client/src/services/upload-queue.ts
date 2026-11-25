import type { AttachmentView } from "@eta/client-contracts";
import type { UploadState } from "@eta/client-contracts/composer-doc";
import type { Uploads } from "../components/eta-editor";
import type { useHost } from "./host";
import { ATTACH_CHUNK_BYTES } from "@eta/client-contracts";
import { signal } from "nsh";
import { uiText } from "../i18n";
import { forgetPicture, rememberPicture } from "./pictures";
import { problemText } from "./problem-text";

type Host = ReturnType<typeof useHost>;

/** One chunk of an upload, as `conversations.attach` and `tasks.attach` take it (less the owner). */
interface UploadChunk {
  uploadId: string;
  name: string;
  contentType: string | undefined;
  index: number;
  last: boolean;
  data: string;
}

/** Where a draft's files go: a conversation's `attach` and `unattach`, or a task's. */
export interface UploadTarget {
  attach: (
    chunk: UploadChunk,
  ) => Promise<{ attachment: AttachmentView | null }>;
  unattach: (id: string) => Promise<unknown>;
}

/** A conversation's files: `conversations.attach`. */
export const conversationUploads = (
  host: Host,
  conversationId: string,
): UploadTarget => ({
  attach: (chunk) =>
    host.call("conversations", "attach", { conversationId, ...chunk }),
  unattach: (attachmentId) =>
    host.call("conversations", "unattach", { conversationId, attachmentId }),
});

/** A task's comment's files: `tasks.attach`. */
export const taskUploads = (host: Host, taskId: string): UploadTarget => ({
  attach: (chunk) => host.call("tasks", "attach", { taskId, ...chunk }),
  unattach: (attachmentId) =>
    host.call("tasks", "unattach", { taskId, attachmentId }),
});

/**
 * A draft's uploads: each file's state by its block id (uploading, failed, done), the files in
 * chunks one after another, a picture's thumbnail from its own bytes while the app has them. The
 * chat's composer and a task's comment box each keep one per draft; `onDone` is where a draft keeps
 * the finished ones, `onIdle` tells it the last upload ended.
 */
export function createUploadQueue(
  options: {
    onDone?: (id: string, attachment: AttachmentView) => void;
    onIdle?: () => void;
  } = {},
) {
  const states = signal<Record<string, UploadState>>({});
  const progresses = signal<Record<string, number>>({});
  const uploading = signal(false);
  const bytes = new Map<string, File>();
  const thumbnails = new Map<string, string>();
  let jobs = Promise.resolve();
  let count = 0;
  function clearProgress(id: string) {
    progresses.update((all) => {
      if (!(id in all)) return all;
      const { [id]: _, ...rest } = all;
      return rest;
    });
  }
  function setState(id: string, state: UploadState) {
    states.update((all) => ({ ...all, [id]: state }));
    if (state.state !== "uploading") clearProgress(id);
    if (state.state === "done") options.onDone?.(id, state.attachment);
  }
  /** Uploads one file in chunks as the attachment `id`, after the uploads before it. */
  function queue(id: string, file: File, host: Host, target: UploadTarget) {
    const origin = host.address()?.origin;
    count++;
    uploading.set(true);
    progresses.update((all) => ({ ...all, [id]: 0 }));
    setState(id, { state: "uploading" });
    const job = async () => {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        for (
          let offset = 0, index = 0;
          offset < data.length || index === 0;
          offset += ATTACH_CHUNK_BYTES, index++
        ) {
          if (host.address()?.origin !== origin)
            throw new Error(uiText("connectionLostReconnecting"));
          const chunk = data.subarray(offset, offset + ATTACH_CHUNK_BYTES);
          const result = await target.attach({
            uploadId: id,
            name: file.name,
            contentType: file.type || undefined,
            index,
            last: offset + ATTACH_CHUNK_BYTES >= data.length,
            data: Buffer.from(chunk).toString("base64"),
          });
          progresses.update((all) => ({
            ...all,
            [id]:
              data.length > 0
                ? Math.min(1, (offset + chunk.length) / data.length)
                : 1,
          }));
          if (result.attachment) {
            // The draft shows the picture from the bytes it sent, not the host's copy (#735).
            if (origin)
              rememberPicture(
                origin,
                result.attachment.id,
                data,
                result.attachment.contentType,
              );
            setState(id, { state: "done", attachment: result.attachment });
          }
        }
      } catch (error) {
        if (host.address()?.origin === origin)
          await target.unattach(id).catch(() => {});
        setState(id, {
          state: "failed",
          error: problemText(error),
          retry: true,
        });
      }
    };
    jobs = jobs.then(job).finally(() => {
      if (--count === 0) {
        uploading.set(false);
        options.onIdle?.();
      }
    });
  }
  return {
    states,
    uploading,
    setState,
    /** Whether an upload failed (its bytes are kept here for a retry, while the app runs). */
    failed: () =>
      Object.values(states()).some((upload) => upload.state === "failed"),
    /** The attachment plugin's view of these uploads, for one host and owner. */
    uploads(host: Host, target: UploadTarget): Uploads {
      return {
        state: (id) => states()[id],
        progress: (id) => progresses()[id],
        thumbnail: (id) => {
          // Read with the states: a thumbnail made later shows on the block.
          states();
          return thumbnails.get(id);
        },
        start(id, file, error) {
          if (error) {
            setState(id, { state: "failed", error });
            return;
          }
          bytes.set(id, file);
          if (file.type.startsWith("image/") && file.size <= 4 * 1024 * 1024)
            void file.arrayBuffer().then((data) => {
              thumbnails.set(
                id,
                `data:${file.type};base64,${Buffer.from(new Uint8Array(data)).toString("base64")}`,
              );
              // The block reads its thumbnail with its state: tell it.
              states.update((all) => ({ ...all }));
            });
          queue(id, file, host, target);
        },
        retry(id) {
          const file = bytes.get(id);
          if (!file) return false;
          queue(id, file, host, target);
          return true;
        },
      };
    },
    /** Files uploaded already (a draft read back, a message brought back to edit). */
    remember(attachments: readonly AttachmentView[]) {
      for (const attachment of attachments)
        setState(attachment.id, { state: "done", attachment });
    },
    /**
     * The draft went: the uploads it did not carry (`left`) are taken back from the host and
     * their pictures forgotten, and the queue starts empty.
     */
    clear(host: Host, target: UploadTarget, left: readonly string[]) {
      const origin = host.address()?.origin;
      for (const id of left) {
        void target.unattach(id).catch(() => {});
        // A picture taken out of the draft goes with it (#735).
        if (origin) forgetPicture(origin, id);
      }
      states.set({});
      progresses.set({});
      bytes.clear();
      thumbnails.clear();
    },
  };
}
