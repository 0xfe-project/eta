import type { RunBlock } from "@eta/client-contracts";
import type { JSX, ScrollRef } from "nsh";
import { signal, View } from "nsh";
import {
  Caption,
  colors,
  Icon,
  Label,
  Markdown,
  row,
  SmoothScroll,
} from "../../components";
import { Spinner } from "../../components/spinner";
import { icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { ToolOutput } from "./run/tool-code";
import { toolTitle } from "./run/transcript-line";

/** A step's row in a reply's process. */
const stepRowHeight = 32;

export function ProcessStep(props: { value: RunBlock }) {
  const c = colors();
  const tool = () => (props.value.type === "tool" ? props.value : undefined);
  // A list recycles a step's view for another step: what was opened is kept
  // for the step it was opened on.
  const opened = signal<string | undefined>(undefined);
  const expanded = () => opened() === props.value.id;
  const toggle = () => opened.set(expanded() ? undefined : props.value.id);
  const title = () => {
    const step = tool();
    if (!step) return "";
    const { name, detail } = toolTitle(step);
    return name + (detail ? ` · ${detail}` : "");
  };
  return (
    <If
      when={tool()}
      else={
        <If
          when={props.value.type === "steer"}
          else={
            <TextStep
              id={props.value.id}
              kind={props.value.type === "thinking" ? "thinking" : "note"}
              text={
                props.value.type === "thinking" || props.value.type === "text"
                  ? props.value.text
                  : ""
              }
            />
          }
        >
          {/* Where the run took words inserted into it: a trace, not the words again. */}
          <View
            style={{
              paddingVertical: space[4],
              paddingHorizontal: space[12],
              borderBottomWidth: 1,
              borderColor: c().border,
              alignItems: "center",
            }}
          >
            <Label variant="caption" tone="faint">
              {uiText("insertReceived")}
            </Label>
          </View>
        </If>
      }
    >
      {(step) => (
        <View>
          <View
            role={step().output ? "button" : undefined}
            onPress={step().output ? toggle : undefined}
            style={{
              ...row,
              minHeight: stepRowHeight,
              paddingHorizontal: space[12],
              gap: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="small" lines={1} style={{ flex: 1 }}>
              {title()}
            </Label>
            <If
              when={step().status === "running"}
              else={
                <If
                  when={step().status === "completed"}
                  else={
                    <View
                      testID="step-failed"
                      accessibilityLabel={uiText("failed")}
                    >
                      <Icon name="warning" size={icon.md} tone="red" />
                    </View>
                  }
                >
                  <View testID="step-check" accessibilityLabel={uiText("done")}>
                    <Icon name="check" size={icon.md} tone="green" />
                  </View>
                </If>
              }
            >
              <View
                testID="step-spinner"
                accessibilityLabel={uiText("inProgress")}
              >
                <Spinner size={icon.md} tone="ink" />
              </View>
            </If>
          </View>
          <If when={expanded() && step().output}>
            <View style={{ padding: space[8], backgroundColor: c().surface }}>
              <ToolOutput text={step().output ?? ""} tone="muted" />
            </View>
          </If>
        </View>
      )}
    </If>
  );
}

/**
 * A thought or something the agent said on the way: a small title that opens
 * to it. A thought starts folded, words start open, in small type.
 */
function TextStep(props: {
  id: string;
  kind: "thinking" | "note";
  text: string;
}) {
  const c = colors();
  // Toggled away from how it starts, for the step it was toggled on.
  const toggled = signal<string | undefined>(undefined);
  const open = () => (props.kind === "note") !== (toggled() === props.id);
  const label = () =>
    uiText(props.kind === "thinking" ? "runThinking" : "processNote");
  return (
    <View style={{ borderBottomWidth: 1, borderColor: c().border }}>
      <View
        role="button"
        accessibilityLabel={label()}
        accessibilityState={{ expanded: open() }}
        onPress={() =>
          toggled.set(toggled() === props.id ? undefined : props.id)
        }
        style={{
          ...row,
          gap: space[4],
          paddingVertical: space[4],
          paddingHorizontal: space[12],
          cursor: "pointer",
        }}
      >
        <Icon name={open() ? "down" : "right"} size={icon.sm} tone="faint" />
        <Caption text={label()} style={{ color: c().faint }} />
      </View>
      <If when={open()}>
        <View style={{ paddingHorizontal: space[12], paddingBottom: space[8] }}>
          <If
            when={props.kind === "note"}
            else={
              <Label variant="small" tone="muted">
                {props.text}
              </Label>
            }
          >
            <Markdown
              value={props.text}
              dense
              heading={{
                variant: "small",
                weight: weight.strong,
                space: 4,
                after: 2,
              }}
              streaming
            />
          </If>
        </View>
      </If>
    </View>
  );
}

/**
 * The steps of a reply at work, in a frame of a fixed height that scrolls
 * inside itself: glued to its newest step as they come, unless the reader
 * scrolled up, and glued again once they are back at the bottom.
 */
export function ProcessWindow(props: {
  height: number;
  children: JSX.Element;
}) {
  let scroll: ScrollRef | undefined;
  let pinned = true;
  return (
    <SmoothScroll
      ref={(node) => {
        scroll = node;
      }}
      style={{ height: props.height, flexShrink: 0 }}
      scrollEventThrottle={16}
      onScroll={(event) => {
        pinned =
          event.contentSize.height - event.offset.y - event.size.height < 16;
      }}
    >
      <View
        onLayout={(event) => {
          if (pinned)
            scroll?.scrollTo({ y: event.bounds.size.height, animated: false });
        }}
      >
        {props.children}
      </View>
    </SmoothScroll>
  );
}
