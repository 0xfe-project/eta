import type { ViewStyle } from "nsh";
import type { TextVariant } from "../components/theme";
import { View } from "nsh";
import { colors, focusRing, row } from "../components/theme";
import { border, space, weight } from "../components/tokens";
import { createRovingFocus } from "./behaviors";
import { Label } from "./text";

interface TabOption<T extends string = string> {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
}

/**
 * Underline or vertical sidebar tablist backed by `createRovingFocus` (single tab-stop,
 * Arrow/Home/End keyboard navigation, focus-visible ring, `role="tablist"` + `role="tab"`).
 */
export function Tabs<T extends string>(props: {
  options: readonly TabOption<T>[];
  value: T;
  variant?: "underline" | "sidebar";
  /** Equal-width tabs stretched across the bar (phone underline layout). */
  stretch?: boolean;
  labelVariant?: TextVariant;
  boldActive?: boolean;
  style?: ViewStyle;
  onChange: (value: T) => void;
}) {
  const c = colors();
  const sidebar = () => props.variant === "sidebar";
  const roving = createRovingFocus<T>({
    orientation: props.variant === "sidebar" ? "vertical" : "horizontal",
    activeId: () => props.value,
    items: () =>
      props.options.map((option) => ({
        id: option.value,
        disabled: option.disabled,
      })),
    onFocusChange: (id) => props.onChange(id),
  });
  return (
    <View
      role="tablist"
      captureKeys={roving.captureKeys}
      onKeyDown={roving.onKeyDown}
      style={
        sidebar()
          ? {
              flexDirection: "column",
              padding: space[8],
              gap: space[2],
              flexShrink: 0,
              borderRightWidth: 1,
              borderColor: c().border,
              ...props.style,
            }
          : {
              ...row,
              alignItems: "stretch",
              height: space[40],
              flexShrink: 0,
              gap: props.stretch ? 0 : space[20],
              paddingHorizontal: props.stretch ? 0 : space[16],
              borderBottomWidth: 1,
              borderColor: c().border,
              ...props.style,
            }
      }
    >
      <Each of={props.options} key={(option) => option.value}>
        {(option) => {
          const active = () => props.value === option().value;
          return (
            <View
              ref={(node) => roving.register(option().value, node)}
              role="tab"
              focusable={roving.isTabStop(option().value)}
              accessibilityLabel={option().label}
              accessibilityState={{
                selected: active(),
                disabled: option().disabled,
              }}
              onPress={() => {
                if (!option().disabled) props.onChange(option().value);
              }}
              hoverStyle={
                sidebar() && !option().disabled
                  ? { backgroundColor: c().selected }
                  : undefined
              }
              focusVisibleStyle={focusRing(c(), "inset")}
              style={
                sidebar()
                  ? {
                      ...row,
                      height: space[32],
                      paddingHorizontal: space[12],
                      backgroundColor: active() ? c().selected : c().canvas,
                      cursor: option().disabled ? "default" : "pointer",
                    }
                  : {
                      ...row,
                      gap: space[4],
                      ...(props.stretch
                        ? { flex: 1, justifyContent: "center" }
                        : {}),
                      borderBottomWidth: border.thick,
                      borderColor: active() ? c().ink : "transparent",
                      cursor: option().disabled ? "default" : "pointer",
                    }
              }
            >
              <Label
                variant={
                  props.labelVariant ?? (props.stretch ? "small" : undefined)
                }
                weight={
                  active() && (props.boldActive ?? props.stretch)
                    ? weight.strong
                    : weight.regular
                }
                tone={
                  active()
                    ? "ink"
                    : sidebar() || props.stretch
                      ? "mutedInk"
                      : "muted"
                }
              >
                {option().label}
              </Label>
              <If when={option().count !== undefined}>
                <Label variant="small" tone="muted">
                  {option().count}
                </Label>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** One bordered group of choices, backed by `createRovingFocus`: Board / List / Plan, Overview / Plan. */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string; disabled?: boolean }[];
  value: T;
  height?: number;
  /** The labels' role; `small` by default. */
  labelVariant?: TextVariant;
  /** Draw the chosen label semibold. */
  boldActive?: boolean;
  paddingHorizontal?: number;
  bordered?: boolean;
  /** A lighter chosen state: the selected fill instead of the solid button colour. */
  subtle?: boolean;
  /** The darker outline the tablet header draws. */
  strong?: boolean;
  onChange: (value: T) => void;
}) {
  const c = colors();
  const roving = createRovingFocus<T>({
    orientation: "horizontal",
    activeId: () => props.value,
    items: () =>
      props.options.map((option) => ({
        id: option.value,
        disabled: option.disabled,
      })),
    onFocusChange: (id) => props.onChange(id),
  });
  return (
    <View
      role="tablist"
      captureKeys={roving.captureKeys}
      onKeyDown={roving.onKeyDown}
      style={{
        ...row,
        alignItems: "stretch",
        height: props.height ?? space[24],
        borderWidth: props.bordered === false ? 0 : 1,
        borderColor: props.strong ? c().strong : c().border,
        backgroundColor: props.bordered === false ? undefined : c().canvas,
        flexShrink: 0,
      }}
    >
      <Each of={props.options} key={(option) => option.value}>
        {(option) => {
          const active = () => props.value === option().value;
          return (
            <View
              ref={(node) => roving.register(option().value, node)}
              role="tab"
              focusable={roving.isTabStop(option().value)}
              accessibilityLabel={option().label}
              accessibilityState={{
                selected: active(),
                disabled: option().disabled,
              }}
              onPress={() => {
                if (!option().disabled) props.onChange(option().value);
              }}
              hoverStyle={
                active() || option().disabled
                  ? undefined
                  : { backgroundColor: c().selected }
              }
              focusVisibleStyle={focusRing(c(), "inset")}
              style={{
                ...row,
                paddingHorizontal: props.paddingHorizontal ?? space[8],
                backgroundColor: active()
                  ? props.subtle
                    ? c().canvas
                    : c().button
                  : undefined,
                cursor: option().disabled ? "default" : "pointer",
              }}
            >
              <Label
                variant={props.labelVariant ?? "small"}
                weight={
                  active() && props.boldActive ? weight.strong : weight.regular
                }
                tone={active() ? (props.subtle ? "ink" : "buttonInk") : "muted"}
              >
                {option().label}
              </Label>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
