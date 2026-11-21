import type { Edges, JSX, ViewStyle } from "nsh";
import { keyboardFrame, safeAreaInsets, View } from "nsh";
import { grow } from "./theme";

/**
 * The edges of the screen nothing interactive may sit under: the system UI
 * (status bar, notch or Dynamic Island, home indicator, and the sides in
 * landscape) and, while it is up, the on-screen keyboard.
 *
 * NSH reports both: `safeAreaInsets()` where this is called (the surface's
 * safe area at the app's root), `keyboardFrame()` the keyboard's height over
 * the surface, measured from its bottom edge, so it already covers the home
 * indicator under it. Neither iOS (UIKit and WKWebView keep the layout
 * viewport under the keyboard) nor Android (NSH draws edge to edge, so
 * `adjustResize` resizes nothing) shrinks the app for the keyboard: the
 * bottom inset is the larger of the two.
 *
 * Call it in the component body, outside any `Overlay` it pads.
 */
export function screenInsets(): () => Edges {
  const safe = safeAreaInsets();
  return () => {
    const { top, right, bottom, left } = safe();
    return {
      top,
      right,
      left,
      bottom: Math.max(bottom, keyboardFrame().height),
    };
  };
}

/** Whether the on-screen keyboard is up. */
export const keyboardShown = () => keyboardFrame().height > 0;

/**
 * The one place the app keeps clear of the screen's unsafe edges: a view
 * padded by `screenInsets()` around a view that holds the content. The app's
 * root is one, so every page, header, composer and tab bar inside it is laid
 * out in the safe part of the screen, and so is a control floating
 * (`position: "absolute"`) in the content view: an absolute child of the
 * padded view itself would reach the screen's edge, as CSS lays it out
 * against the padding box. A surface drawn over the whole screen (an
 * `Overlay`) holds its content in one of its own.
 */
export function SafeArea(props: {
  /** The insets to keep clear, when the caller read them outside an
   * `Overlay` (whose content no longer sees the surface's safe area). */
  insets?: () => Edges;
  /** The padded view's style: what shows under the system UI (a fill). */
  style?: ViewStyle;
  /** The content view's style (its alignment). */
  contentStyle?: ViewStyle;
  testID?: string;
  children?: JSX.Element;
}) {
  const own = props.insets ? undefined : screenInsets();
  const insets = () => (props.insets ?? own!)();
  return (
    <View
      style={{
        ...grow,
        ...props.style,
        paddingTop: insets().top,
        paddingRight: insets().right,
        paddingBottom: insets().bottom,
        paddingLeft: insets().left,
      }}
    >
      <View testID={props.testID} style={{ ...grow, ...props.contentStyle }}>
        {props.children}
      </View>
    </View>
  );
}
