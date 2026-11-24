import { View } from "nsh";
import { grow, Revealed, row, SkeletonBar } from "../../components";
import { space } from "../../components/tokens";

/** The bars' sizes: a line of text, a title, a status glyph's square, the list's trailing bar and
 * the detail's title and meta lines; a list row. */
const barHeight = { text: 12, title: 20, glyph: 16 } as const;
const barWidth = { glyph: 16, trailing: 40, title: 184, meta: 92 } as const;
const listRowHeight = 36;

/** "Loading · list": 36px rows of a square, a bar and a 40px trailing bar. */
export function TaskListSkeleton(props: { label: string }) {
  return (
    <Revealed>
      <View
        role="progressbar"
        accessibilityLabel={props.label}
        accessibilityState={{ busy: true }}
        style={{ ...grow, paddingVertical: space[8] }}
      >
        <Each of={[212, 140, 176, 244, 104]}>
          {(width) => (
            <View
              style={{
                ...row,
                height: listRowHeight,
                paddingHorizontal: space[8],
                gap: space[12],
              }}
            >
              <SkeletonBar width={barWidth.glyph} height={barHeight.glyph} />
              <SkeletonBar width={width()} height={barHeight.text} />
              <View style={{ flex: 1 }} />
              <SkeletonBar width={barWidth.trailing} height={barHeight.text} />
            </View>
          )}
        </Each>
      </View>
    </Revealed>
  );
}

/** "Loading · detail": a title bar, a meta bar and five lines of text. */
export function TaskDetailSkeleton(props: { label: string }) {
  return (
    <Revealed>
      <View
        role="progressbar"
        accessibilityLabel={props.label}
        accessibilityState={{ busy: true }}
        style={{ ...grow, padding: space[16], gap: space[12] }}
      >
        <SkeletonBar width={barWidth.title} height={barHeight.title} />
        <SkeletonBar width={barWidth.meta} height={barHeight.text} />
        <View style={{ gap: space[8], paddingTop: space[12] }}>
          <Each of={[212, 368, 184, 368, 124]}>
            {(width) => <SkeletonBar width={width()} height={barHeight.text} />}
          </Each>
        </View>
      </View>
    </Revealed>
  );
}
