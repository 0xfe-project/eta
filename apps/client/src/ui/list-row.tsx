import type { JSX, ViewRef, ViewStyle } from "nsh";
import { View } from "nsh";
import { colors, row } from "../components/theme";
import { control, icon, space, weight } from "../components/tokens";
import { createPressable } from "./behaviors";
import { Icon, Label } from "./text";

const listRowHeight = 56;

/**
 * Unified list / settings row backed by `createPressable` (keyboard focus ring, hover feedback,
 * pointer cursor, leading slot, title/detail stack, trailing slot or chevron).
 */
export function ListRow(props: {
  title: string;
  detail?: string;
  detailLines?: number;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  chevron?: boolean;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  controlRef?: (node: ViewRef) => void;
  style?: ViewStyle;
  onPress?: () => void;
}) {
  const c = colors();
  const press = createPressable({
    label: () => props.accessibilityLabel ?? props.title,
    disabled: () => Boolean(props.disabled),
    selected: () => props.selected,
    focusRingKind: "inset",
    onPress: props.onPress,
  });
  const baseStyle = (): ViewStyle => ({
    ...row,
    minHeight: listRowHeight,
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[8],
    borderBottomWidth: 1,
    borderColor: c().border,
    backgroundColor: props.selected ? c().selected : undefined,
    cursor: props.onPress && !props.disabled ? "pointer" : undefined,
    ...props.style,
  });
  const inner = () => (
    <>
      {props.leading}
      <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
        <Label weight={weight.regular}>{props.title}</Label>
        <If when={props.detail}>
          <Label variant="small" tone="muted" lines={props.detailLines ?? 2}>
            {props.detail}
          </Label>
        </If>
      </View>
      {props.trailing}
      <If when={props.chevron ?? (props.onPress && !props.trailing)}>
        <Icon name="right" size={icon.sm} tone="muted" />
      </If>
    </>
  );
  if (!props.onPress) {
    return (
      <View ref={props.controlRef} style={baseStyle()}>
        {inner()}
      </View>
    );
  }
  return (
    <View
      ref={props.controlRef}
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      accessibilityState={press.accessibilityState()}
      onMouseEnter={press.onMouseEnter}
      onMouseLeave={press.onMouseLeave}
      onPress={press.press}
      hoverStyle={press.hoverStyle()}
      focusVisibleStyle={press.focusVisibleStyle()}
      style={baseStyle()}
    >
      {inner()}
    </View>
  );
}

/** The header that opens a pane or section: title, count, actions, description. */
export function SectionHeader(props: {
  title: string;
  count?: string | number;
  description?: string;
  muted?: boolean;
  /** The phone's header row is 28px, fitting its 28px buttons. */
  phone?: boolean;
  /** The header row's height when it differs, e.g. 20 for a bare title in a sheet. */
  rowHeight?: number;
  leading?: JSX.Element;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        flexShrink: 0,
        gap: space[2],
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        style={{
          ...row,
          height: props.rowHeight ?? (props.phone ? control.md : space[24]),
          gap: space[8],
        }}
      >
        {props.leading}
        <View
          style={{
            ...row,
            alignItems: "baseline",
            flex: 1,
            minWidth: 0,
            gap: space[8],
          }}
        >
          <Label
            weight={weight.strong}
            lines={1}
            tone={props.muted ? "muted" : "ink"}
          >
            {props.title}
          </Label>
          <If when={props.count !== undefined}>
            <Label variant="small" tone="muted">
              {props.count}
            </Label>
          </If>
        </View>
        <If when={props.children}>
          <View style={{ ...row, gap: space[8] }}>{props.children}</View>
        </If>
      </View>
      <If when={props.description}>
        <Label variant="small" tone="muted">
          {props.description}
        </Label>
      </If>
    </View>
  );
}
