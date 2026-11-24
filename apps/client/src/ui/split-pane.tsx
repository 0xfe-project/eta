import type { Pane } from "../app/pane-width";
import { PanResponder, View } from "nsh";
import {
  draggedPaneWidth,
  paneLimits,
  paneWidth,
  savePaneWidth,
  setPaneWidth,
} from "../app/pane-width";
import { colors, focusRing } from "../components/theme";
import { useText } from "../i18n";
import { createAdjustable } from "./behaviors";

const gripWidth = 8;
const labels = {
  sidebar: "resizeSidebar",
  panel: "resizePanel",
  task: "resizeTaskRail",
} as const;

/**
 * The strip on a pane's inner edge the reader drags (or adjusts via keyboard arrows / Home / End)
 * to resize it. It straddles the pane's border (the sidebar's right edge, the panel's and task
 * rail's left) and takes only the pointer there, so the pane's content, its scrolling and its inputs
 * are untouched.
 */
export function PaneHandle(props: { pane: Pane }) {
  const c = colors();
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
  const limits = () => paneLimits[props.pane];
  const adjustable = createAdjustable({
    min: () => limits().min,
    max: () => limits().max,
    value: () => paneWidth(props.pane),
    onChange: (next) => {
      setPaneWidth(props.pane, next);
      savePaneWidth(props.pane);
    },
  });
  return (
    <View
      {...responder.panHandlers}
      role="adjustable"
      focusable
      captureKeys={adjustable.captureKeys}
      onKeyDown={(event) => {
        adjustable.onKeyDown(event);
      }}
      accessibilityLabel={text(labels[props.pane])}
      accessibilityValue={adjustable.accessibilityValue()}
      focusVisibleStyle={focusRing(c(), "inset")}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [props.pane === "sidebar" ? "right" : "left"]: -gripWidth / 2,
        width: gripWidth,
        cursor: "col-resize",
        zIndex: 1,
      }}
    />
  );
}
