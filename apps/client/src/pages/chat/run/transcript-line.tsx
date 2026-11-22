import type {
  LogBlock,
  RunImage,
  SessionImage,
  ToolBlock,
} from "@eta/client-contracts";
import type { Signal } from "nsh";
import { fullOutputOf } from "@eta/client-contracts/tool-shape";
import { cleanup, computed, effect, Image, signal, View } from "nsh";
import {
  Caption,
  colors,
  focusRing,
  Label,
  Markdown,
  row,
} from "../../../components";
import { Lightbox, picturePreview } from "../../../components/picture-viewer";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
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
 * The pictures a step carried (a screenshot a tool read back, an image the user attached). Resting
 * on one shows it larger beside it (desktops); pressing it opens it over the window, where the
 * others of the step are a swipe or an arrow key away.
 */
function TranscriptImages(props: {
  session: string;
  images: () => RunImage[];
}) {
  const c = colors();
  const open = signal<number>();
  const pictures = computed(() =>
    props.images().map((image) => {
      const { key, state } = runPicture(props.session, image);
      return {
        key,
        caption: sizeLabel(image),
        src: () => state().src,
        failed: () => false,
        image,
        state,
      };
    }),
  );
  return (
    <>
      <Each of={pictures()} key={(picture) => picture.key}>
        {(picture) => {
          const index = () =>
            pictures().findIndex((other) => other.key === picture().key);
          return (
            <View
              role="button"
              accessibilityLabel={uiText("openImage", {
                index: index() + 1,
                count: pictures().length,
              })}
              tooltip={picturePreview(picture())}
              onPress={() => open.set(index())}
              focusVisibleStyle={focusRing(c())}
              style={{ cursor: "zoom-in" }}
            >
              <TranscriptImage
                session={props.session}
                image={picture().image}
                state={picture().state}
              />
            </View>
          );
        }}
      </Each>
      <Lightbox pictures={pictures} index={open} onIndex={open.set} />
    </>
  );
}

function TranscriptImage(props: {
  session: string;
  image: RunImage;
  state: RunPictureState;
}) {
  const host = useHost();
  effect(() => {
    if (props.state().src || host.state().status !== "open") return;
    let active = true;
    void host
      .call<SessionImage>("sessions", "image", {
        session: props.session,
        entryId: props.image.entryId,
        index: props.image.index,
      })
      .then(
        (image) => {
          if (active && image.data)
            props.state.set({
              src: `data:${props.image.mimeType};base64,${image.data}`,
            });
        },
        () => {},
      );
    cleanup(() => {
      active = false;
    });
  });
  return (
    <If
      when={props.state().src}
      else={
        <Label variant="caption" tone="muted">
          {uiText("imageUnavailable")}
        </Label>
      }
    >
      <Image
        src={props.state().src}
        style={{ width: "100%", height: 220, objectFit: "contain" }}
      />
    </If>
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
