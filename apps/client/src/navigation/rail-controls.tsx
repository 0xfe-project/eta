import type { JSX, Point, ViewRef } from "nsh";
import type { IconName } from "../components/icons";
import { View } from "nsh";
import { colors, focusRing, Icon, Label } from "../components";

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
        width: props.width ?? props.size ?? 28,
        height: props.size ?? 28,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: props.selected ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      <View
        style={{
          width: props.iconSize ?? 14,
          height: props.iconSize ?? 14,
          position: "relative",
        }}
      >
        <Icon name={props.icon} size={props.iconSize} />
        <If when={(props.count ?? 0) > 0}>
          <View
            style={{
              position: "absolute",
              right: -5,
              top: -2,
              height: 13,
              minWidth: 10,
              paddingHorizontal: 2,
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
        height: 41,
        flexShrink: 0,
        alignItems: "center",
        paddingTop: 5,
        paddingHorizontal: 4,
        gap: 3,
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
        style={{ maxWidth: 49, textAlign: "center" }}
      >
        {props.label}
      </Label>
      <If when={props.active}>
        <View
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: 6,
            height: 6,
            backgroundColor: c().green,
          }}
        />
      </If>
    </View>
  );
}
