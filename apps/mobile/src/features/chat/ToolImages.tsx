import type { SessionImage } from "@eta/client-contracts";
import type { RunImage } from "./run";
import { Image, signal, Text, View } from "nsh";
import { t } from "../../i18n";
import { call } from "../../wire/target";

/** Pictures fetched from the host, by session, row and part: a picture never changes. */
const pictures = new Map<string, Promise<string>>();

const uri = (mimeType: string, data: string) => `data:${mimeType};base64,${data}`;

function picture(sessionId: string, image: RunImage): Promise<string> {
  const key = `${sessionId}:${image.entryId}:${image.index}`;
  let request = pictures.get(key);
  if (request === undefined) {
    request = call<SessionImage>("sessions", "image", {
      session: sessionId,
      entryId: image.entryId,
      index: image.index,
    }).then((found) => uri(found.mimeType, found.data));
    // A failed fetch is not kept: the next time the picture is drawn it asks again.
    request.catch(() => pictures.delete(key));
    pictures.set(key, request);
  }
  return request;
}

/** One picture a tool returned: carried in the view, or asked for once when it was left out. */
function ToolImage(props: { sessionId: string; image: RunImage }) {
  const { image } = props;
  const src = signal(image.data === "" ? undefined : uri(image.mimeType, image.data));
  const failed = signal(false);
  if (src() === undefined) {
    picture(props.sessionId, image).then(
      (found) => src.set(found),
      () => failed.set(true),
    );
  }
  return (
    <If
      when={src() !== undefined}
      else={
        <View class="h-[160px] items-center justify-center bg-muted">
          <If when={failed()}>
            <Text class="text-sm leading-[18px] text-muted-foreground">
              {t("chat.tool.imageFailed")}
            </Text>
          </If>
        </View>
      }
    >
      <Image
        testID="tool-image"
        src={src()}
        class="h-[240px] w-full"
        style={{ objectFit: "contain" }}
      />
    </If>
  );
}

export function ToolImages(props: { sessionId: string; images: readonly RunImage[] }) {
  return (
    <View class="gap-2 px-4 py-2">
      <Each of={[...props.images]} key={(image) => `${image.entryId}:${image.index}`}>
        {(image) => <ToolImage sessionId={props.sessionId} image={image()} />}
      </Each>
    </View>
  );
}
