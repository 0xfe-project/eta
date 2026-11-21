import type {
  AttachmentView,
  ConversationResults,
} from "@eta/client-contracts";
import { cleanup, effect, Image, signal, View } from "nsh";
import { Label } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** The picture a sent message carried, read from the host once it is drawn. */
export function AttachmentImage(props: {
  conversationId: string;
  file: AttachmentView;
}) {
  const host = useHost();
  const source = signal<string | undefined>(undefined);
  const failed = signal(false);
  effect(() => {
    if (source() || host.state().status !== "open") return;
    let active = true;
    void host
      .call<ConversationResults["attachment"]>("conversations", "attachment", {
        conversationId: props.conversationId,
        attachmentId: props.file.id,
      })
      .then(
        (picture) => {
          if (active)
            source.set(`data:${picture.contentType};base64,${picture.data}`);
        },
        () => {
          if (active) failed.set(true);
        },
      );
    cleanup(() => {
      active = false;
    });
  });
  return (
    <View>
      <If
        when={source()}
        else={
          <Label variant="caption" tone="muted">
            {`${props.file.name} · ${failed() ? uiText("imageUnavailable") : `${(props.file.size / 1024).toFixed(1)} KB`}`}
          </Label>
        }
      >
        <Image
          src={source()!}
          style={{ width: 240, height: 180, objectFit: "contain" }}
        />
      </If>
    </View>
  );
}
