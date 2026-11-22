import type {
  LogBlock,
  RunImage,
  SessionImage,
  ToolBlock,
} from "@eta/client-contracts";
import type { Signal } from "nsh";
import { fullOutputOf } from "@eta/client-contracts/tool-shape";
import { computed, effect, Image, signal, View } from "nsh";
import {
  Caption,
  colors,
  focusRing,
  Label,
  Markdown,
  row,
} from "../../../components";
import { Chip } from "../../../components/eta-editor/chip";
import { Lightbox, picturePreview } from "../../../components/picture-viewer";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { PictureModes } from "../../../services/picture-mode";
import { toolDescription } from "./run-timing";

export function TranscriptLine(props: {
  session: string;
  block: LogBlock;
  firstTool: boolean;
  afterTool: boolean;
  phone: boolean;
  selected: boolean;
  opened: boolean;
  onToggle: () => void;
}) {
  const c = colors();
  const tool = () => (props.block.type === "tool" ? props.block : undefined);
  const title = () => {
    const entry = tool();
    return entry ? toolTitle(entry) : { name: "", detail: "" };
  };
  const images = () =>
    props.block.type === "tool" || props.block.type === "user"
      ? (props.block.images ?? [])
      : [];
  const output = () => {
    const entry = tool();
    return entry && (fullOutputOf(entry) ?? entry.output);
  };
  return (
    <If
      when={tool()}
      else={
        <View
          style={{
            paddingTop: props.afterTool ? (props.phone ? 32 : 11) : 5,
            paddingBottom: 5,
            backgroundColor: props.selected ? c().selected : c().canvas,
          }}
        >
          <If when={props.block.type === "error"}>
            <Label variant="small" tone="red">
              {props.block.type === "error"
                ? [
                    props.block.aborted
                      ? uiText("runStopped")
                      : uiText("runFailed"),
                    props.block.text,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : ""}
            </Label>
          </If>
          <If
            when={
              props.block.type === "thinking" ||
              props.block.type === "summary" ||
              props.block.type === "user"
            }
          >
            <Caption
              text={
                props.block.type === "thinking"
                  ? uiText("runThinking")
                  : props.block.type === "user"
                    ? uiText("runUser")
                    : uiText("runSummary")
              }
            />
          </If>
          <If when={props.block.type !== "error"}>
            <Markdown
              value={
                props.block.type !== "error" && props.block.type !== "tool"
                  ? props.block.text
                  : ""
              }
            />
          </If>
          <If when={images().length}>
            <TranscriptImages session={props.session} images={images} />
          </If>
        </View>
      }
    >
      {(entry) => (
        <View
          style={{
            borderTopWidth: props.firstTool ? 1 : 0,
            borderLeftWidth: 1,
            borderRightWidth: 1,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            role="button"
            accessibilityLabel={
              title().detail
                ? `${title().name} · ${title().detail}`
                : title().name
            }
            accessibilityState={{
              expanded: props.opened,
              selected: props.selected,
            }}
            onPress={props.onToggle}
            hoverStyle={{ backgroundColor: c().selected }}
            focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
            style={{
              ...row,
              height: 31,
              paddingHorizontal: 10,
              gap: 4,
              cursor: "pointer",
              backgroundColor: props.selected ? c().selected : c().canvas,
            }}
          >
            <Label variant="small" lines={1}>
              {title().name}
            </Label>
            <Label
              variant="small"
              tone="muted"
              lines={1}
              style={{ flex: 1, minWidth: 0 }}
            >
              {title().detail ? `· ${title().detail}` : ""}
            </Label>
            <Caption
              text={
                entry().status === "running"
                  ? uiText("running")
                  : entry().status === "failed"
                    ? uiText("failed")
                    : uiText("done")
              }
              style={{
                color: entry().status === "failed" ? c().red : c().muted,
              }}
            />
          </View>
          <If when={props.opened}>
            <View style={{ padding: 10, gap: 6, backgroundColor: c().surface }}>
              <If when={entry().input !== undefined}>
                <Caption text={uiText("runInput")} />
                <Label variant="caption">
                  {typeof entry().input === "string"
                    ? String(entry().input)
                    : JSON.stringify(entry().input, null, 2)}
                </Label>
              </If>
              <If when={output()}>
                <Caption text={uiText("runOutput")} />
                <Label variant="caption">{output()}</Label>
              </If>
              <If when={images().length}>
                <TranscriptImages session={props.session} images={images} />
              </If>
              <If
                when={
                  entry().input === undefined && !output() && !images().length
                }
              >
                <Label variant="caption" tone="muted">
                  {uiText("noRunDetails")}
                </Label>
              </If>
            </View>
          </If>
        </View>
      )}
    </If>
  );
}

type RunPictureState = Signal<{ src?: string }>;

// The pictures runs carried, as `data:` URLs by session, entry and index: those the view left out
// are fetched once (`sessions.image`) and kept, so the preview and the lightbox show them at once.
const runPictures = new Map<string, RunPictureState>();

function runPicture(session: string, image: RunImage) {
  const key = `${session}:${image.entryId}:${image.index}`;
  let state = runPictures.get(key);
  if (!state) {
    state = signal<{ src?: string }>(
      image.data ? { src: `data:${image.mimeType};base64,${image.data}` } : {},
    );
    runPictures.set(key, state);
  }
  return { key, state };
}

/** The kind and size of a picture, as a caption: "PNG · 84 KB". */
function sizeLabel(image: RunImage): string {
  const kind = image.mimeType.replace(/^image\//, "").toUpperCase();
  const bytes = image.bytes ?? Math.floor((image.data.length * 3) / 4);
  if (bytes <= 0) return kind;
  const size =
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${kind} · ${size}`;
}

/**
 * The pictures a step carried (a screenshot a tool read back, an image the user attached), as
 * Settings › Appearance › Images in messages says: compact, a chip each ("Screenshot 1 · PNG ·
 * 84 KB") whose thumbnail shows when the pointer rests on it (desktops); expanded, 180-wide cards.
 * A press opens it over the window, where the others of the step are a swipe or an arrow key away.
 */
function TranscriptImages(props: {
  session: string;
  images: () => RunImage[];
}) {
  const host = useHost();
  const c = colors();
  const modes = PictureModes();
  const open = signal<number>();
  const asked = new Set<string>();
  const pictures = computed(() =>
    props.images().map((image, index) => {
      const { key, state } = runPicture(props.session, image);
      return {
        key,
        name: uiText("screenshotNamed", { index: index + 1 }),
        caption: sizeLabel(image),
        src: () => state().src,
        failed: () => false,
        image,
        state,
      };
    }),
  );
  // Those the view left out are asked for once they are drawn, once each.
  effect(() => {
    if (host.state().status !== "open") return;
    for (const picture of pictures()) {
      if (picture.state().src || asked.has(picture.key)) continue;
      asked.add(picture.key);
      void host
        .call<SessionImage>("sessions", "image", {
          session: props.session,
          entryId: picture.image.entryId,
          index: picture.image.index,
        })
        .then(
          (image) => {
            if (image.data)
              picture.state.set({
                src: `data:${picture.image.mimeType};base64,${image.data}`,
              });
          },
          () => asked.delete(picture.key),
        );
    }
  });
  const index = (key: string) =>
    pictures().findIndex((other) => other.key === key);
  return (
    <>
      <View
        style={{
          ...row,
          flexWrap: "wrap",
          gap: modes.mode() === "expanded" ? 8 : 4,
        }}
      >
        <Each of={pictures()} key={(picture) => picture.key}>
          {(picture) => (
            <If
              when={modes.mode() === "expanded"}
              else={
                <Chip
                  label={picture().name}
                  thumbnail={picture().src()}
                  icon="file"
                  detail={picture().caption}
                  cursor="zoom-in"
                  tooltip={picturePreview(picture(), 248, 300)}
                  accessibilityLabel={uiText("openImage", {
                    index: index(picture().key) + 1,
                    count: pictures().length,
                  })}
                  onPress={() => open.set(index(picture().key))}
                />
              }
            >
              <View
                role="button"
                testID="picture-card"
                accessibilityLabel={uiText("openImage", {
                  index: index(picture().key) + 1,
                  count: pictures().length,
                })}
                onPress={() => open.set(index(picture().key))}
                focusVisibleStyle={focusRing(c())}
                hoverStyle={{ borderColor: c().strong }}
                style={{
                  width: 180,
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().canvas,
                  cursor: "zoom-in",
                }}
              >
                <View style={{ height: 96, backgroundColor: c().selected }}>
                  <If
                    when={picture().src()}
                    else={
                      <Label variant="caption" tone="muted">
                        {uiText("imageUnavailable")}
                      </Label>
                    }
                  >
                    {(src) => (
                      <Image
                        src={src()}
                        fadeDuration={0}
                        style={{
                          width: "100%",
                          height: 96,
                          objectFit: "cover",
                        }}
                      />
                    )}
                  </If>
                </View>
                <View
                  style={{
                    borderTopWidth: 1,
                    borderColor: c().border,
                    paddingVertical: 4,
                    paddingHorizontal: 6,
                  }}
                >
                  <Label variant="caption" tone="muted" lines={1}>
                    {`${picture().name} · ${picture().caption}`}
                  </Label>
                </View>
              </View>
            </If>
          )}
        </Each>
      </View>
      <Lightbox pictures={pictures} index={open} onIndex={open.set} />
    </>
  );
}

function toolTitle(tool: ToolBlock) {
  if (
    tool.name === "esmrun" &&
    tool.details &&
    typeof tool.details === "object" &&
    "effects" in tool.details &&
    Array.isArray(tool.details.effects)
  ) {
    const actions = tool.details.effects.filter(
      (effect) =>
        effect &&
        typeof effect.name === "string" &&
        ["view", "search", "edit"].includes(effect.name) &&
        typeof effect.detail === "string",
    );
    if (actions.length === 1) {
      const action = actions[0]!;
      return {
        name: String(action.name),
        detail: toolDescription(action.detail),
      };
    }
  }
  return { name: tool.name, detail: toolDescription(tool.input) };
}
