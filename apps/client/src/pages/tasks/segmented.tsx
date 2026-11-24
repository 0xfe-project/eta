import type { TextVariant } from "../../components";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { space, weight } from "../../components/tokens";

/** One bordered group of choices, the chosen one filled: Board / List / Plan, Overview / Plan. */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string }[];
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
  return (
    <View
      role="tablist"
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
              role="tab"
              accessibilityLabel={option().label}
              accessibilityState={{ selected: active() }}
              onPress={() => props.onChange(option().value)}
              hoverStyle={
                active() ? undefined : { backgroundColor: c().selected }
              }
              style={{
                ...row,
                paddingHorizontal: props.paddingHorizontal ?? space[8],
                backgroundColor: active()
                  ? props.subtle
                    ? c().canvas
                    : c().button
                  : undefined,
                cursor: "pointer",
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
