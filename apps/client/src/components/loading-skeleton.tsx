import type { ViewStyle } from "nsh";
import { View } from "nsh";
import { colors, row } from "./theme";
import { avatar, icon, space } from "./tokens";

/** The bars stand in for a line of text, a title, a list row and a reply bubble. */
const barHeight = { line: 12, title: 20, row: 36, reply: 36 } as const;
const barWidth = {
  trailing: 40,
  title: 184,
  meta: 92,
  name: 96,
  message: 220,
  reply: 152,
} as const;

/** A placeholder bar: the muted fill inside a border, as the design's loading states draw it. */
function Bar(props: { width: ViewStyle["width"]; height: number }) {
  const c = colors();
  return (
    <View
      style={{
        width: props.width,
        maxWidth: "100%",
        height: props.height,
        flexShrink: 0,
        borderWidth: 1,
        borderColor: c().border,
        backgroundColor: c().selected,
      }}
    />
  );
}

/** Loading · list: 36pt rows of a glyph, a title bar and a trailing bar. */
export function ListSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      style={{ paddingVertical: space[8], ...props.style }}
    >
      <Each of={[208, 140, 176, 244, 104]}>
        {(width) => (
          <View
            style={{
              ...row,
              height: barHeight.row,
              flexShrink: 0,
              paddingHorizontal: space[8],
              gap: space[12],
            }}
          >
            <Bar width={icon.md} height={icon.md} />
            <Bar width={width()} height={barHeight.line} />
            <View style={{ marginLeft: "auto" }}>
              <Bar width={barWidth.trailing} height={barHeight.line} />
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

/** Loading · detail: a title bar, a meta bar and five lines of text. */
export function DetailSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      style={{ padding: space[16], gap: space[12], ...props.style }}
    >
      <Bar width={barWidth.title} height={barHeight.title} />
      <Bar width={barWidth.meta} height={barHeight.line} />
      <View style={{ gap: space[8], paddingTop: space[12] }}>
        <Each of={[212, 364, 184, 364, 120]}>
          {(width) => <Bar width={width()} height={barHeight.line} />}
        </Each>
      </View>
    </View>
  );
}

function MessageBars(props: { width: number }) {
  return (
    <View style={{ gap: space[8] }}>
      <View style={{ ...row, gap: space[8] }}>
        <Bar width={avatar.sm} height={avatar.sm} />
        <Bar width={barWidth.name} height={barHeight.line} />
      </View>
      <Bar width="100%" height={barHeight.line} />
      <Bar width={props.width} height={barHeight.line} />
    </View>
  );
}

/** Loading · messages: two messages around a reply bubble. */
export function MessagesSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      style={{ padding: space[16], gap: space[20], ...props.style }}
    >
      <MessageBars width={barWidth.message} />
      <View style={{ alignItems: "flex-end" }}>
        <Bar width={barWidth.reply} height={barHeight.reply} />
      </View>
      <MessageBars width={barWidth.reply} />
    </View>
  );
}
