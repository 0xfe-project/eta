import { Text, View } from "nsh";

/** Group / Private, Appearance / Machine / Connection: 36 high on a muted strip, the chosen one lifted to the page. */
export function Segmented<T extends string>(props: {
  options: { value: T; label: string; count?: number | undefined }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const tone = (value: T) =>
    `text-md leading-[18px] ${props.value === value ? "text-foreground" : "text-muted-foreground"}`;
  return (
    <View class="h-9 shrink-0 flex-row bg-muted p-[3px]">
      <Each of={props.options}>
        {(option) => (
          <View
            role="tab"
            accessibilityLabel={
              option().count === undefined
                ? option().label
                : `${option().label} ${option().count}`
            }
            onPress={() => props.onChange(option().value)}
            class={`grow basis-0 flex-row items-center justify-center gap-[6px] ${props.value === option().value ? "bg-background" : ""}`}
          >
            <Text class={tone(option().value)}>{option().label}</Text>
            <If when={option().count !== undefined}>
              <Text class={tone(option().value)}>{option().count}</Text>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}
