import type { AttachmentView } from "@eta/client-contracts";
import type { useHost } from "./host";
import { attachmentPicturePath } from "@eta/client-contracts";
import { Clipboard, context, signal } from "nsh";
import { startProgress } from "../components/progress-notification";
import { showToast } from "../components/toast";
import { uiText } from "../i18n";
import { createFileSaver } from "../pages/chat/artifacts/file";
import { problemText } from "./problem-text";

// A file a message carried, saved on a press: the host's copy (`GET /attachments/<id>`, served as
// bytes to save), through the share sheet where there is one, else into the app's storage; a
// browser downloads it. One at a time; the app mounts `writer` once.

/** Reads a fetch response body into bytes, reporting determinate 0..1 progress when Content-Length is known. */
export async function readResponseBytes(
  response: Response,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  const total = lengthHeader ? Number(lengthHeader) : 0;
  const reader =
    total > 0 && Number.isFinite(total) && response.body?.getReader
      ? response.body.getReader()
      : undefined;
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress?.(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(Math.min(1, received / total));
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A file's name as it can be saved: no path separators or control characters. */
function savedName(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").trim();
  return cleaned.replace(/^\.+/, "") || "file";
}

export function createAttachmentFiles(host: ReturnType<typeof useHost>) {
  const saver = createFileSaver();
  const busy = signal<string>();
  async function save(
    file: Pick<AttachmentView, "id" | "name" | "contentType">,
  ) {
    const address = host.address();
    if (!address || busy()) return;
    busy.set(file.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const progress = startProgress({
      id: `attachment-${file.id}`,
      icon: "download",
      title: uiText("download"),
      detail: file.name,
      onCancel: () => controller.abort(),
    });
    try {
      const path = attachmentPicturePath(file.id);
      const response = await fetch(new URL(path, address.origin), {
        credentials: "same-origin",
        redirect: "error",
        headers: address.token
          ? { Authorization: `Bearer ${address.token}` }
          : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${file.name}: ${response.status}`);
      const bytes = await readResponseBytes(response, (fraction) =>
        progress.update({ progress: fraction }),
      );
      if (controller.signal.aborted) {
        progress.dismiss();
        return;
      }
      await saver.save(
        bytes,
        savedName(file.name),
        file.contentType || "application/octet-stream",
        controller.signal,
      );
      if (controller.signal.aborted) {
        progress.dismiss();
        return;
      }
      const saved = saver.savedPath();
      progress.complete({
        title: uiText("fileSaved", { name: file.name }),
        detail: saved || file.name,
        onOpen: saved
          ? () =>
              void Clipboard.writeText(saved)
                .then(() => showToast({ title: uiText("copied") }))
                .catch(() => {})
          : undefined,
        showWhenQuick: Boolean(saved),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        progress.dismiss();
      } else {
        progress.fail({
          title: uiText("fileSaveFailed", { name: file.name }),
          detail: problemText(error),
          onRetry: () => void save(file),
        });
      }
    } finally {
      clearTimeout(timeout);
      busy.set(undefined);
    }
  }
  return { save, busy: () => busy(), writer: saver.writer };
}

/** The app's saver of message files; none in a test that does not provide one. */
export const AttachmentFiles = context<
  ReturnType<typeof createAttachmentFiles> | undefined
>(undefined);
