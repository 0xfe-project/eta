import type { RunBlock } from "@eta/client-contracts";
import type { JSX, ScrollRef, ViewProps } from "nsh";
import { context, signal, View } from "nsh";
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
import { icon, layer, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { ProcessDetails } from "../../services/process-detail";
import { ToolOutput } from "./run/tool-code";
import { toolTitle } from "./run/transcript-line";

/** A step's row in a reply's process. */
const stepRowHeight = 32;

/** The process window's scroll, for a step folded while it holds the window's top. */
const ProcessScroll = context<{ reveal: (top: number) => void } | undefined>(
  undefined,
);

/**
 * Where a step's row is in the process window, and folding it: when the
 * window is scrolled past that row, it scrolls back to it, not to wherever
 * the shorter content leaves it.
 */
function stepRow() {
  const window = ProcessScroll();
  let top = 0;
  return {
    onLayout: (event: Parameters<NonNullable<ViewProps["onLayout"]>>[0]) => {
      top = event.bounds.origin.y;
    },
    reveal: () => window?.reveal(top),
  };
}

/** A step's title row while its content is open: it stays at the top of the window until the step ends. */
const stuck = (borderColor: string) =>
  ({
    position: "sticky",
    top: 0,
    zIndex: layer.sticky,
    borderBottomWidth: 1,
    borderColor,
  }) as const;

export function ProcessStep(props: { value: RunBlock }) {
  const c = colors();
  const rowBox = stepRow();
  const tool = () => (props.value.type === "tool" ? props.value : undefined);
  // A list recycles a step's view for another step: what was opened is kept
  // for the step it was opened on.
  const opened = signal<string | undefined>(undefined);
  const expanded = () => opened() === props.value.id;
  const toggle = () => {
    if (expanded()) rowBox.reveal();
    opened.set(expanded() ? undefined : props.value.id);
  };
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
        <View onLayout={rowBox.onLayout}>
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
              ...(expanded() && step().output
                ? { ...stuck(c().border), backgroundColor: c().canvas }
                : {}),
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
 * to it. Words start open, in small type; a thought starts folded, or open
 * when the process shows in detail. Once toggled, the reader's choice holds.
 */
function TextStep(props: {
  id: string;
  kind: "thinking" | "note";
  text: string;
}) {
  const c = colors();
  const rowBox = stepRow();
  const processDetail = ProcessDetails();
  const opensAtFirst = () =>
    props.kind === "note" || processDetail.detail() === "detailed";
  // What the reader set it to, for the step they set.
  const chosen = signal<{ id: string; open: boolean } | undefined>(undefined);
  const open = () => {
    const choice = chosen();
    return choice?.id === props.id ? choice.open : opensAtFirst();
  };
  const label = () =>
    uiText(props.kind === "thinking" ? "runThinking" : "processNote");
  return (
    <View
      onLayout={rowBox.onLayout}
      style={{ borderBottomWidth: 1, borderColor: c().border }}
    >
      <View
        role="button"
        accessibilityLabel={label()}
        accessibilityState={{ expanded: open() }}
        onPress={() => {
          if (open() && props.kind === "thinking") rowBox.reveal();
          chosen.set({ id: props.id, open: !open() });
        }}
        style={{
          ...row,
          gap: space[4],
          paddingVertical: space[4],
          paddingHorizontal: space[12],
          cursor: "pointer",
          ...(open() && props.kind === "thinking"
            ? { ...stuck(c().border), backgroundColor: c().canvas }
            : {}),
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

/** A reply's tool calls by kind, most first, ties by name. */
function toolTally(steps: readonly RunBlock[]) {
  const counts = new Map<string, number>();
  for (const step of steps) {
    if (step.type !== "tool") continue;
    const { name } = toolTitle(step);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) =>
      a.count !== b.count ? b.count - a.count : a.name < b.name ? -1 : 1,
    );
}

/** The most kinds a tally line names before the rest becomes "+N more". */
const tallyKinds = 3;
/** Wide enough for any tally line, so an unseen one lays out at its own width. */
const unboundedWidth = 10000; // design-value: a measuring width, never drawn

/**
 * A step count followed by the reply's tool calls by kind, on one line: as
 * many kinds as fit, down to one, and the count alone when none does. Each
 * candidate line is laid out unseen to learn its width.
 */
export function ProcessTally(props: {
  count: string;
  steps: readonly RunBlock[];
  line: (text: string) => JSX.Element;
  align?: "flex-start" | "flex-end";
}) {
  const tally = () => toolTally(props.steps);
  const text = (kinds: number) => {
    const named = tally().slice(0, kinds);
    const rest = tally().length - named.length;
    return [
      props.count,
      ...named.map((kind) => uiText("processToolCount", kind)),
      ...(rest && kinds ? [uiText("processToolMore", { count: rest })] : []),
    ].join(" · ");
  };
  const choices = () =>
    Array.from(
      { length: Math.min(tallyKinds, tally().length) },
      (_, index) => index + 1,
    );
  const room = signal(0);
  const widths = signal<Record<number, number>>({});
  const kinds = () =>
    choices()
      .filter((kinds) => (widths()[kinds] ?? Infinity) <= room())
      .at(-1) ?? 0;
  return (
    <View
      style={{ flex: 1, minWidth: 0, alignItems: props.align }}
      onLayout={(event) => room.set(event.bounds.size.width)}
    >
      {props.line(text(kinds()))}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          overflow: "hidden",
        }}
      >
        <View style={{ width: unboundedWidth, alignItems: "flex-start" }}>
          <Each of={choices()} key={(kinds) => String(kinds)}>
            {(kinds) => (
              <View
                onLayout={(event) =>
                  widths.update((known) => ({
                    ...known,
                    [kinds()]: event.bounds.size.width,
                  }))
                }
              >
                {props.line(text(kinds()))}
              </View>
            )}
          </Each>
        </View>
      </View>
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
  let offset = 0;
  return (
    <SmoothScroll
      ref={(node) => {
        scroll = node;
      }}
      style={{ height: props.height, flexShrink: 0 }}
      scrollEventThrottle={16}
      onScroll={(event) => {
        offset = event.offset.y;
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
        <ProcessScroll.Provider
          value={{
            reveal: (top) => {
              if (offset <= top) return;
              pinned = false;
              scroll?.scrollTo({ y: top, animated: false });
            },
          }}
        >
          {props.children}
        </ProcessScroll.Provider>
      </View>
    </SmoothScroll>
  );
}
