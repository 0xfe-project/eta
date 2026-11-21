import type { ViewStyle } from "nsh";
import { View } from "nsh";
import { colors, row } from "./theme";

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
      style={{ paddingVertical: 8, ...props.style }}
    >
      <Each of={[210, 140, 175, 245, 105]}>
        {(width) => (
          <View
            style={{
              ...row,
              height: 36,
              flexShrink: 0,
              paddingHorizontal: 8,
              gap: 12,
            }}
          >
            <Bar width={14} height={14} />
            <Bar width={width()} height={12} />
            <View style={{ marginLeft: "auto" }}>
              <Bar width={40} height={12} />
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
      style={{ padding: 16, gap: 12, ...props.style }}
    >
      <Bar width={184} height={20} />
      <Bar width={92} height={12} />
      <View style={{ gap: 8, paddingTop: 12 }}>
        <Each of={[211, 366, 183, 366, 122]}>
          {(width) => <Bar width={width()} height={12} />}
        </Each>
      </View>
    </View>
  );
}

function MessageBars(props: { width: number }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ ...row, gap: 8 }}>
        <Bar width={18} height={18} />
        <Bar width={96} height={12} />
      </View>
      <Bar width="100%" height={12} />
      <Bar width={props.width} height={12} />
    </View>
  );
}

/** Loading · messages: two messages around a reply bubble. */
export function MessagesSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      style={{ padding: 16, gap: 22, ...props.style }}
    >
      <MessageBars width={220} />
      <View style={{ alignItems: "flex-end" }}>
        <Bar width={150} height={36} />
      </View>
      <MessageBars width={150} />
    </View>
  );
}
