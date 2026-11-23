import type { JSX, Point, ViewRef } from "nsh";
import type { IconName } from "../components/icons";
import { View } from "nsh";
import { colors, focusRing, Icon, Label } from "../components";
import { dotSize } from "../components/status-dot";
import { control, icon, space } from "../components/tokens";

/** An unread count over a rail icon. */
const badgeHeight = 16;
/** A rail destination: its icon over its caption. */
const buttonHeight = 40;
const labelWidth = 48;

export function RailButton(props: {
  label: string;
  icon: IconName;
  size?: number;
  width?: number;
  iconSize?: number;
  selected?: boolean;
  expanded?: boolean;
  count?: number;
  attach?: (node: ViewRef | null) => void;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.count ? String(props.count) : undefined}
      accessibilityState={{
        selected: props.selected,
        expanded: props.expanded,
      }}
      ref={props.attach}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={focusRing(c())}
      style={{
        width: props.width ?? props.size ?? control.md,
        height: props.size ?? control.md,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: props.selected ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      <View
        style={{
          width: props.iconSize ?? icon.md,
          height: props.iconSize ?? icon.md,
          position: "relative",
        }}
      >
        <Icon name={props.icon} size={props.iconSize ?? icon.md} />
        <If when={(props.count ?? 0) > 0}>
          <View
            style={{
              position: "absolute",
              right: -5,
              top: -2,
              height: badgeHeight,
              minWidth: badgeHeight,
              paddingHorizontal: space[2],
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <Label variant="caption">{props.count}</Label>
          </View>
        </If>
      </View>
    </View>
  );
}

export function RailEntry(props: {
  label: string;
  selected?: boolean;
  /** One of its members is at work. */
  active?: boolean;
  onPress: () => void;
  onContextMenu?: (event: { position: Point }) => void;
  onLongPress?: (event: { position: Point }) => void;
  children: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      onContextMenu={props.onContextMenu}
      onLongPress={props.onLongPress}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={focusRing(c())}
      style={{
        position: "relative",
        height: buttonHeight,
        flexShrink: 0,
        alignItems: "center",
        paddingTop: space[4],
        paddingHorizontal: space[4],
        gap: space[2],
        borderBottomWidth: 1,
        borderColor: c().border,
        backgroundColor: props.selected ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      {props.children}
      <Label
        variant="caption"
        lines={1}
        style={{ maxWidth: labelWidth, textAlign: "center" }}
      >
        {props.label}
      </Label>
      <If when={props.active}>
        <View
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: dotSize,
            height: dotSize,
            backgroundColor: c().green,
          }}
        />
      </If>
    </View>
  );
}
