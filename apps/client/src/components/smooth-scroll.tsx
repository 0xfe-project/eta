import type { ScrollProps, WheelEvent } from "nsh";
import { Scroll, split, View } from "nsh";
import { glideScroll } from "./scroll-follow";

/**
 * What a `Scroll` adds to glide on the mouse wheel. `scroll` goes on the
 * `Scroll` itself: the ref and scroll handler of `glideScroll`, run before
 * the ones in `props`. `onWheel` goes on a `View` inside it, never on the
 * `Scroll`: a listening scroll view only observes the wheel and still
 * scrolls natively, which would cover the glide; a view inside one takes the
 * wheel. None off Windows, where the system already scrolls smoothly.
 */
export function smoothScrollProps(
  props: ScrollProps,
  glide: ScrollProps = glideScroll(),
): { scroll: ScrollProps; onWheel: (event: WheelEvent) => void } | undefined {
  const { ref, onWheel, onScroll } = glide;
  if (typeof ref !== "function" || !onWheel || !onScroll) return undefined;
  return {
    scroll: {
      ref: (node) => {
        ref(node);
        if (typeof props.ref === "function") props.ref(node);
      },
      onScroll: (event) => {
        onScroll(event);
        props.onScroll?.(event);
      },
      scrollEventThrottle: 16,
    },
    onWheel: (event) => {
      onWheel(event);
      props.onWheel?.(event);
    },
  };
}

/**
 * A vertical `Scroll` whose mouse wheel glides on Windows (the desktop app
 * and a browser on Windows). It takes every prop of `Scroll` and is the same
 * `Scroll` elsewhere. Use it for every vertical scroll area; a horizontal one
 * stays a `Scroll`.
 */
export function SmoothScroll(props: ScrollProps) {
  // `split`, not a destructure: the rest keeps the getters of `props`, so a
  // style that reads a signal (a menu's `maxHeight`, a layout's margin) is
  // followed as it changes rather than frozen at its first value.
  const [own, rest] = split(props, ["children", "onWheel", "contentStyle"]);
  // Read once: a second read of children would build them twice.
  const children = own.children;
  const smooth = smoothScrollProps(props);
  if (!smooth)
    return (
      <Scroll {...rest} onWheel={own.onWheel} contentStyle={own.contentStyle}>
        {children}
      </Scroll>
    );
  // The wheel view holds the content's own style (padding, gap, flex), so the
  // layout inside is the one the content container had; the container only
  // grows, as a `contentStyle` with `flexGrow` made it. Short
  // content leaves a blank below the view, where the wheel scrolls natively.
  return (
    <Scroll
      {...rest}
      {...smooth.scroll}
      contentStyle={own.contentStyle ? { flexGrow: 1 } : undefined}
    >
      <View onWheel={smooth.onWheel} style={own.contentStyle}>
        {children}
      </View>
    </Scroll>
  );
}
