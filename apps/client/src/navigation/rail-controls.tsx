import type { JSX, ViewRef } from "nsh";
import type { IconName } from "../components/icons";
import { View } from "nsh";
import { colors, Icon, Label } from "../components";

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
      focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
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
            <Label size={9} line={12}>
              {props.count}
            </Label>
          </View>
        </If>
      </View>
    </View>
  );
}

export function RailEntry(props: {
  label: string;
  agent?: boolean;
  selected?: boolean;
  status?: "active" | "waiting" | "idle";
  onPress: () => void;
  children: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: c().blue,
        outlineOffset: -1,
      }}
      style={{
        position: "relative",
        height: props.agent ? 48 : 41,
        flexShrink: 0,
        alignItems: "center",
        paddingTop: props.agent ? 6 : 5,
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
        size={10}
        line={12}
        lines={1}
        style={{ maxWidth: props.agent ? "100%" : 49, textAlign: "center" }}
      >
        {props.label}
      </Label>
      <If when={props.status}>
        <View
          style={{
            position: "absolute",
            top: 2,
            right: props.agent ? 2 : undefined,
            left: props.agent ? undefined : 2,
            width: 6,
            height: 6,
            opacity: props.status === "idle" ? 0.4 : 1,
            backgroundColor:
              props.status === "idle"
                ? c().muted
                : props.status === "waiting"
                  ? c().amber
                  : props.agent
                    ? c().blue
                    : c().green,
          }}
        />
      </If>
    </View>
  );
}
