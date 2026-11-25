import type { JSX, ViewRef, ViewStyle } from "nsh";
import { View } from "nsh";
import { colors } from "../components/theme";
import { createPressable } from "./behaviors";

export function Separator(props: {
  orientation?: "horizontal" | "vertical";
  tone?: "border" | "strong";
  style?: ViewStyle;
}) {
  const c = colors();
  const vertical = () => props.orientation === "vertical";
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: vertical() ? 1 : "100%",
        height: vertical() ? "100%" : 1,
        backgroundColor: c()[props.tone ?? "border"],
        flexShrink: 0,
        ...props.style,
      }}
    />
  );
}

export function Card(props: {
  surface?: "canvas" | "surface" | "selected";
  padding?: number;
  gap?: number;
  selected?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  controlRef?: (node: ViewRef) => void;
  style?: ViewStyle;
  children?: JSX.Element;
}) {
  const c = colors();
  const press = createPressable({
    label: () => props.accessibilityLabel,
    selected: () => props.selected,
    onPress: props.onPress,
  });
  const baseStyle = (): ViewStyle => ({
    borderWidth: 1,
    borderColor: props.selected ? c().ink : c().border,
    backgroundColor: props.surface ? c()[props.surface] : undefined,
    padding: props.padding,
    gap: props.gap,
    cursor: props.onPress ? "pointer" : undefined,
    ...props.style,
  });
  if (!props.onPress) {
    return (
      <View ref={props.controlRef} style={baseStyle()}>
        {props.children}
      </View>
    );
  }
  return (
    <View
      ref={props.controlRef}
      role="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={press.accessibilityState()}
      onMouseEnter={press.onMouseEnter}
      onMouseLeave={press.onMouseLeave}
      onPress={press.press}
      hoverStyle={press.hoverStyle()}
      focusVisibleStyle={press.focusVisibleStyle()}
      style={baseStyle()}
    >
      {props.children}
    </View>
  );
}
