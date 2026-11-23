import type { AttachmentView } from "@eta/client-contracts";
import type { useHost } from "./host";
import { attachmentPicturePath } from "@eta/client-contracts";
import { context, signal } from "nsh";
import { showToast } from "../components/toast";
import { uiText } from "../i18n";
import { createFileSaver } from "../pages/chat/artifacts/file";

// A file a message carried, saved on a press: the host's copy (`GET /attachments/<id>`, served as
// bytes to save), through the share sheet where there is one, else into the app's storage; a
// browser downloads it. One at a time; the app mounts `writer` once.

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
    try {
      const path = attachmentPicturePath(file.id);
      const response = await fetch(new URL(path, address.origin), {
        credentials: "same-origin",
        redirect: "error",
        headers: address.token
          ? { Authorization: `Bearer ${address.token}` }
          : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`${file.name}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await saver.save(
        bytes,
        savedName(file.name),
        file.contentType || "application/octet-stream",
      );
      if (saver.savedPath())
        showToast({
          title: uiText("fileSaved", { name: file.name }),
          body: saver.savedPath(),
          tone: "green",
        });
    } catch (error) {
      showToast({
        title: uiText("fileSaveFailed", { name: file.name }),
        body: error instanceof Error ? error.message : String(error),
        tone: "red",
      });
    } finally {
      busy.set(undefined);
    }
  }
  return { save, busy: () => busy(), writer: saver.writer };
}

/** The app's saver of message files; none in a test that does not provide one. */
export const AttachmentFiles = context<
  ReturnType<typeof createAttachmentFiles> | undefined
>(undefined);
