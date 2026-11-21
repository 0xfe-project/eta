import type { Pane } from "../app/pane-width";
import { PanResponder, View } from "nsh";
import {
  draggedPaneWidth,
  paneWidth,
  savePaneWidth,
  setPaneWidth,
} from "../app/pane-width";
import { useText } from "../i18n";

const grip = 6;

/**
 * The strip on a pane's inner edge the reader drags to resize it. It straddles the pane's border
 * (the sidebar's right edge, the panel's left) and takes only the pointer there, so the pane's
 * content, its scrolling and its inputs are untouched.
 */
export function PaneHandle(props: { pane: Pane }) {
  const text = useText();
  let start = 0;
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start = paneWidth(props.pane);
    },
    onPanResponderMove: (_, gesture) =>
      setPaneWidth(props.pane, draggedPaneWidth(props.pane, start, gesture.dx)),
    onPanResponderRelease: () => savePaneWidth(props.pane),
    onPanResponderTerminate: () => savePaneWidth(props.pane),
  });
  return (
    <View
      {...responder.panHandlers}
      role="adjustable"
      accessibilityLabel={text(
        props.pane === "sidebar" ? "resizeSidebar" : "resizePanel",
      )}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [props.pane === "sidebar" ? "right" : "left"]: -grip / 2,
        width: grip,
        cursor: "col-resize",
        zIndex: 1,
      }}
    />
  );
}
