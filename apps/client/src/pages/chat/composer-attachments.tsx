import type { ConversationResults } from "@eta/client-contracts";
import type { openComposerDraft } from "./composer-draft";
import {
  ATTACH_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} from "@eta/client-contracts";
import { Picker, View } from "nsh";
import { Button, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function composerAttachments(
  store: ReturnType<typeof openComposerDraft>,
  conversationId: string,
  blocked: () => boolean,
) {
  const host = useHost();
  const origin = host.address()?.origin;
  const { ready, uploading, failedUploads, edit } = store;
  const attachments = () => store.value().attachments;
  async function attach(pasted?: File[] | Promise<File[]>) {
    if (!ready() || blocked()) return;
    await store.updateAttachments(() =>
      host.action(async () => {
        const chosen =
          (await pasted) ??
          (
            await Picker.pickFiles({
              multiple: true,
              maxSize: MAX_ATTACHMENT_BYTES,
            })
          ).map((item) => {
            if (!item.file)
              throw new Error(
                uiText("composerFileTooLarge", { name: item.name }),
              );
            return item.file;
          });
        if (
          chosen.length + attachments().length + failedUploads().length >
          MAX_ATTACHMENTS
        )
          throw new Error(
            uiText("attachmentCountLimit", { count: MAX_ATTACHMENTS }),
          );
        const oversize = chosen.find(
          (file) => file.size > MAX_ATTACHMENT_BYTES,
        );
        if (oversize)
          throw new Error(
            uiText("composerFileTooLarge", { name: oversize.name }),
          );
        for (const file of chosen) {
          const id = crypto.randomUUID();
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            for (
              let offset = 0, index = 0;
              offset < bytes.length || index === 0;
              offset += ATTACH_CHUNK_BYTES, index++
            ) {
              if (host.address()?.origin !== origin)
                throw new Error(uiText("connectionLostReconnecting"));
              const result = await host.call<ConversationResults["attach"]>(
                "conversations",
                "attach",
                {
                  conversationId,
                  uploadId: id,
                  name: file.name,
                  contentType: file.type ?? undefined,
                  index,
                  last: offset + ATTACH_CHUNK_BYTES >= bytes.length,
                  data: Buffer.from(
                    bytes.subarray(offset, offset + ATTACH_CHUNK_BYTES),
                  ).toString("base64"),
                },
              );
              if (result.attachment)
                edit({ attachments: [...attachments(), result.attachment] });
            }
          } catch (error) {
            if (host.address()?.origin === origin)
              await host
                .call("conversations", "unattach", {
                  conversationId,
                  attachmentId: id,
                })
                .catch(() => {});
            failedUploads.update((items) => [
              ...items,
              {
                file,
                error: error instanceof Error ? error.message : String(error),
              },
            ]);
          }
        }
      }),
    );
  }
  async function detach(id: string) {
    if (uploading()) return;
    await store.updateAttachments(() =>
      host.action(async () => {
        await host.call("conversations", "unattach", {
          conversationId,
          attachmentId: id,
        });
        edit({ attachments: attachments().filter((file) => file.id !== id) });
      }),
    );
  }
  function AttachmentChips() {
    return (
      <>
        <Each of={failedUploads()}>
          {(item) => (
            <View role="alert" style={{ ...row, gap: 6, flexWrap: "wrap" }}>
              <Label variant="small" tone="amber">
                {`${item().file.name} · ${item().error}`}
              </Label>
              <Button
                label={uiText("retry")}
                disabled={uploading()}
                onPress={() => {
                  const entry = item();
                  failedUploads.update((items) =>
                    items.filter((other) => other !== entry),
                  );
                  void attach([entry.file]);
                }}
              />
              <Button
                label={uiText("discard")}
                onPress={() =>
                  failedUploads.update((items) =>
                    items.filter((other) => other !== item()),
                  )
                }
              />
            </View>
          )}
        </Each>
        <If when={attachments().length}>
          <View style={{ ...row, flexWrap: "wrap", gap: 5 }}>
            <Each of={attachments()} key={(file) => file.id}>
              {(file) => (
                <Button
                  label={file().name}
                  end="close"
                  disabled={uploading()}
                  onPress={() => void detach(file().id)}
                />
              )}
            </Each>
          </View>
        </If>
      </>
    );
  }
  return { attach, AttachmentChips };
}
