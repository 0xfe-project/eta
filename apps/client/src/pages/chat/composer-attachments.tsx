import type { ConversationResults } from "@eta/client-contracts";
import type { openComposerDraft } from "./composer-draft";
import {
  ATTACH_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} from "@eta/client-contracts";
import { computed, Picker, signal, View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { Lightbox } from "../../components/picture-viewer";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import {
  fileSize,
  forgetPicture,
  isPicture,
  rememberPicture,
  useAttachmentPictures,
} from "../../services/pictures";
import { PictureChip } from "./picture-chip";

export function composerAttachments(
  store: ReturnType<typeof openComposerDraft>,
  conversationId: string,
  blocked: () => boolean,
) {
  const host = useHost();
  const origin = host.address()?.origin;
  const { ready, uploading, failedUploads, edit } = store;
  const attachments = () => store.value().attachments;
  async function attach(pasted?: File[]) {
    if (!ready() || blocked()) return;
    await store.updateAttachments(() =>
      host.action(async () => {
        const chosen =
          pasted ??
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
              if (result.attachment) {
                // The draft shows the picture from the bytes it sent, not the host's copy.
                if (origin)
                  rememberPicture(
                    origin,
                    result.attachment.id,
                    bytes,
                    result.attachment.contentType,
                  );
                edit({ attachments: [...attachments(), result.attachment] });
              }
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
        if (origin) forgetPicture(origin, id);
      }),
    );
  }
  function AttachmentChips() {
    const c = colors();
    const pictureOf = useAttachmentPictures();
    const open = signal<number>();
    const pictures = computed(() =>
      attachments().filter(isPicture).map(pictureOf),
    );
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
                <If
                  when={isPicture(file())}
                  else={
                    <Button
                      label={file().name}
                      end="close"
                      disabled={uploading()}
                      onPress={() => void detach(file().id)}
                    />
                  }
                >
                  {/* A picture opens on a press, so taking it out is a button of its own. */}
                  <View
                    style={{
                      ...row,
                      flexShrink: 0,
                      height: 24,
                      maxWidth: "100%",
                      borderWidth: 1,
                      borderColor: c().strong,
                      backgroundColor: c().canvas,
                    }}
                  >
                    <PictureChip
                      picture={pictureOf(file())}
                      name={file().name}
                      size={fileSize(file().size)}
                      text={file().name}
                      variant="small"
                      style={{
                        height: "100%",
                        justifyContent: "center",
                        paddingLeft: 8,
                        paddingRight: 2,
                      }}
                      onOpen={() =>
                        open.set(
                          pictures().findIndex(
                            (picture) => picture.key === file().id,
                          ),
                        )
                      }
                    />
                    <Button
                      label={uiText("removeAttachment", { name: file().name })}
                      icon="close"
                      iconOnly
                      iconSize={10}
                      tone="ghost"
                      labelTone="muted"
                      size={22}
                      disabled={uploading()}
                      style={{ paddingHorizontal: 5 }}
                      onPress={() => void detach(file().id)}
                    />
                  </View>
                </If>
              )}
            </Each>
          </View>
        </If>
        <Lightbox pictures={pictures} index={open} onIndex={open.set} />
      </>
    );
  }
  return { attach, AttachmentChips };
}
