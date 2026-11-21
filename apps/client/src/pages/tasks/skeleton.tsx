import { View } from "nsh";
import { colors, grow, row } from "../../components";

/** One placeholder bar of the design's loading states: muted fill, 1px border. */
function Bar(props: { width: number; height: number }) {
  const c = colors();
  return (
    <View
      style={{
        width: props.width,
        maxWidth: "100%",
        height: props.height,
        flexShrink: 0,
        backgroundColor: c().selected,
        borderWidth: 1,
        borderColor: c().border,
      }}
    />
  );
}

/** "Loading · list": 36px rows of a square, a bar and a 40px trailing bar. */
export function TaskListSkeleton(props: { label: string }) {
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      style={{ ...grow, paddingVertical: 8 }}
    >
      <Each of={[210, 140, 175, 245, 105]}>
        {(width) => (
          <View style={{ ...row, height: 36, paddingHorizontal: 8, gap: 12 }}>
            <Bar width={14} height={14} />
            <Bar width={width()} height={12} />
            <View style={{ flex: 1 }} />
            <Bar width={40} height={12} />
          </View>
        )}
      </Each>
    </View>
  );
}

/** "Loading · detail": a title bar, a meta bar and five lines of text. */
export function TaskDetailSkeleton(props: { label: string }) {
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      style={{ ...grow, padding: 16, gap: 12 }}
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
