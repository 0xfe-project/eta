import { Text, View } from "nsh";

/** 群聊 / 私聊, 外观 / 机器 / 连接: 36 high on a muted strip, the chosen one lifted to the page. */
export function Segmented<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View class="h-9 shrink-0 flex-row bg-muted p-[3px]">
      <Each of={props.options}>
        {(option) => (
          <View
            role="tab"
            accessibilityLabel={option().label}
            onPress={() => props.onChange(option().value)}
            class={`grow basis-0 items-center justify-center ${props.value === option().value ? "bg-background" : ""}`}
          >
            <Text
              class={`text-md leading-[18px] ${props.value === option().value ? "text-foreground" : "text-muted-foreground"}`}
            >
              {option().label}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}
