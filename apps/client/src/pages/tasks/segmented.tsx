import { View } from "nsh";
import { colors, Label, row } from "../../components";

/** One bordered group of choices, the chosen one filled: Board / List / Plan, Overview / Plan. */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string }[];
  value: T;
  height?: number;
  labelSize?: number;
  paddingHorizontal?: number;
  bordered?: boolean;
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
        height: props.height ?? 24,
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
                paddingHorizontal: props.paddingHorizontal ?? 9,
                backgroundColor: active() ? c().button : undefined,
                cursor: "pointer",
              }}
            >
              <Label
                size={props.labelSize ?? 12}
                line={16}
                weight={active() && props.labelSize === 10 ? 600 : 400}
                tone={active() ? "buttonInk" : "muted"}
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
