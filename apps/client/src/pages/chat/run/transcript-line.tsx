import type { LogBlock, SessionImage, ToolBlock } from "@eta/client-contracts";
import { fullOutputOf } from "@eta/client-contracts/tool-shape";
import { cleanup, effect, Image, signal, View } from "nsh";
import { Caption, colors, Label, Markdown, row } from "../../../components";
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
            <Label size={12} tone="red">
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
              line={21}
            />
          </If>
          <Each
            of={images()}
            key={(image) => `${image.entryId}:${image.index}`}
          >
            {(image) => (
              <TranscriptImage session={props.session} image={image()} />
            )}
          </Each>
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
            <Label size={12} lines={1}>
              {title().name}
            </Label>
            <Label
              size={12}
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
                <Label size={11}>
                  {typeof entry().input === "string"
                    ? String(entry().input)
                    : JSON.stringify(entry().input, null, 2)}
                </Label>
              </If>
              <If when={output()}>
                <Caption text={uiText("runOutput")} />
                <Label size={11}>{output()}</Label>
              </If>
              <Each
                of={images()}
                key={(image) => `${image.entryId}:${image.index}`}
              >
                {(image) => (
                  <TranscriptImage session={props.session} image={image()} />
                )}
              </Each>
              <If
                when={
                  entry().input === undefined && !output() && !images().length
                }
              >
                <Label size={11} tone="muted">
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

function TranscriptImage(props: {
  session: string;
  image: NonNullable<Extract<LogBlock, { type: "tool" }>["images"]>[number];
}) {
  const host = useHost();
  const source = signal(props.image.data);
  effect(() => {
    if (source() || host.state().status !== "open") return;
    let active = true;
    void host
      .call<SessionImage>("sessions", "image", {
        session: props.session,
        entryId: props.image.entryId,
        index: props.image.index,
      })
      .then(
        (image) => {
          if (active) source.set(image.data);
        },
        () => {},
      );
    cleanup(() => {
      active = false;
    });
  });
  return (
    <If
      when={source()}
      else={
        <Label size={11} tone="muted">
          {uiText("imageUnavailable")}
        </Label>
      }
    >
      <Image
        src={`data:${props.image.mimeType};base64,${source()}`}
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
