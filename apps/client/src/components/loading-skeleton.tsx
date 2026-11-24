import type { JSX, ViewStyle } from "nsh";
import { cleanup, createMotion, effect, reduceMotion, signal, View } from "nsh";
import { shownWhile } from "./pending";
import { colors, row } from "./theme";
import { avatar, icon, opacity, space } from "./tokens";

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

const shimmerWidth = 64;
const shimmerTravel = 384;
const SHIMMER_MS = 1200;
const REVEAL_FADE_MS = 200;
const REVEAL_STAGGER_MS = 40;

/**
 * A skeleton drawn only once its wait has lasted `motion.reveal` (300 ms): a quicker load shows
 * nothing in its place, not a flash of grey. Its region keeps it at least `motion.minShown`
 * (500 ms) with `settled` (pending.ts).
 */
export function Revealed(props: { children: JSX.Element }) {
  const shown = shownWhile(() => true);
  return <If when={shown()}>{props.children}</If>;
}

/**
 * Staggered fade-in (200 ms fade, 40 ms stagger per index) for real content arriving after a
 * skeleton. Lands instantly when reduced motion is enabled, and drops its animation layer once
 * settled so text keeps subpixel rendering.
 */
export function SkeletonReveal(props: {
  index?: number;
  style?: ViewStyle;
  children: JSX.Element;
}) {
  const reduced = reduceMotion();
  const playing = signal(!reduced);
  const fade = createMotion({ initial: reduced ? undefined : { opacity: 0 } });
  if (!reduced) {
    void fade
      .play({
        keyframes: { opacity: [0, 1] },
        duration: REVEAL_FADE_MS,
        delay: (props.index ?? 0) * REVEAL_STAGGER_MS,
        easing: "easeOut",
      })
      .then(() => playing.set(false));
  }
  cleanup(() => fade.stop());
  return (
    <View style={{ ...(playing() ? fade.style : {}), ...props.style }}>
      {props.children}
    </View>
  );
}

/**
 * A square placeholder bar using Eta's palette tokens with a synchronized 1.2 s shimmer sweep
 * (static when reduced motion is enabled).
 */
export function SkeletonBar(props: {
  width: ViewStyle["width"];
  height: number;
  borderless?: boolean;
  style?: ViewStyle;
}) {
  const c = colors();
  const sweep = createMotion();
  effect(() => {
    if (reduceMotion()) {
      sweep.stop();
      sweep.reset();
      return;
    }
    void sweep.play({
      keyframes: { translateX: [-shimmerWidth, shimmerTravel] },
      duration: SHIMMER_MS,
      easing: "easeInOut",
      iterations: "infinite",
    });
  });
  cleanup(() => sweep.stop());
  return (
    <View
      style={{
        width: props.width,
        maxWidth: "100%",
        height: props.height,
        flexShrink: 0,
        overflow: "hidden",
        borderWidth: props.borderless ? 0 : 1,
        borderColor: c().border,
        backgroundColor: c().selected,
        ...props.style,
      }}
    >
      <If when={!reduceMotion()}>
        <View
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: shimmerWidth,
            backgroundColor: c().surface,
            opacity: opacity.muted,
            transform: sweep.transform,
          }}
        />
      </If>
    </View>
  );
}

/** Loading · list: 36pt rows of a glyph, a title bar and a trailing bar. */
export function ListSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <Revealed>
      <View
        role="progressbar"
        accessibilityLabel={props.label}
        accessibilityState={{ busy: true }}
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
              <SkeletonBar width={icon.md} height={icon.md} />
              <SkeletonBar width={width()} height={barHeight.line} />
              <View style={{ marginLeft: "auto" }}>
                <SkeletonBar
                  width={barWidth.trailing}
                  height={barHeight.line}
                />
              </View>
            </View>
          )}
        </Each>
      </View>
    </Revealed>
  );
}

/** Loading · detail: a title bar, a meta bar and five lines of text. */
export function DetailSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <Revealed>
      <View
        role="progressbar"
        accessibilityLabel={props.label}
        accessibilityState={{ busy: true }}
        style={{ padding: space[16], gap: space[12], ...props.style }}
      >
        <SkeletonBar width={barWidth.title} height={barHeight.title} />
        <SkeletonBar width={barWidth.meta} height={barHeight.line} />
        <View style={{ gap: space[8], paddingTop: space[12] }}>
          <Each of={[212, 364, 184, 364, 120]}>
            {(width) => <SkeletonBar width={width()} height={barHeight.line} />}
          </Each>
        </View>
      </View>
    </Revealed>
  );
}

/** Loading · compact inline preview: three short bars, delayed by `motion.reveal`. */
export function CompactSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <Revealed>
      <View
        role="progressbar"
        accessibilityLabel={props.label}
        accessibilityState={{ busy: true }}
        style={{ gap: space[8], ...props.style }}
      >
        <SkeletonBar width={barWidth.title} height={barHeight.line} />
        <SkeletonBar width={barWidth.message} height={barHeight.line} />
        <SkeletonBar width={barWidth.meta} height={barHeight.line} />
      </View>
    </Revealed>
  );
}

function MessageBars(props: { width: number }) {
  return (
    <View style={{ gap: space[8] }}>
      <View style={{ ...row, gap: space[8] }}>
        <SkeletonBar width={avatar.sm} height={avatar.sm} />
        <SkeletonBar width={barWidth.name} height={barHeight.line} />
      </View>
      <SkeletonBar width="100%" height={barHeight.line} />
      <SkeletonBar width={props.width} height={barHeight.line} />
    </View>
  );
}

/** Loading · messages: two messages around a reply bubble. */
export function MessagesSkeleton(props: { label: string; style?: ViewStyle }) {
  return (
    <Revealed>
      <View
        role="progressbar"
        accessibilityLabel={props.label}
        accessibilityState={{ busy: true }}
        style={{ padding: space[16], gap: space[20], ...props.style }}
      >
        <MessageBars width={barWidth.message} />
        <View style={{ alignItems: "flex-end" }}>
          <SkeletonBar width={barWidth.reply} height={barHeight.reply} />
        </View>
        <MessageBars width={barWidth.reply} />
      </View>
    </Revealed>
  );
}
