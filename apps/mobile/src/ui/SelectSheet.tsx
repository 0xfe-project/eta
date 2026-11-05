import { Scroll, Text, View } from "nsh";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A second line under the label. */
  hint?: string;
  /** Muted, at the right. */
  aside?: string;
  disabled?: boolean;
  /** Starts a group under this caption. */
  group?: string;
}

/** Choosing one of a list, in the look of 03p's sheet: the phone's stand-in for a select. */
export function SelectSheet<T extends string>(props: {
  open: boolean;
  title: string;
  options: SelectOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <View class="p-4">
        <Text class="text-[17px] leading-5 text-foreground">{props.title}</Text>
      </View>
      <Scroll style={{ maxHeight: 480 }}>
        <Each of={props.options}>
          {(option) => (
            <>
              <If when={option().group !== undefined}>
                <View class="h-[30px] shrink-0 flex-row items-end border-t border-border px-4 pb-[6px]">
                  <Text class="text-sm leading-[18px] text-muted-foreground">{option().group}</Text>
                </View>
              </If>
              <View
                role="button"
                accessibilityLabel={option().label}
                disabled={option().disabled === true}
                onPress={() => {
                  props.onChange(option().value);
                  props.onClose();
                }}
                class="min-h-[52px] shrink-0 flex-row items-center gap-3 border-t border-border px-4 py-2 active:bg-muted"
              >
                <View class="min-w-0 grow basis-0">
                  <Text
                    class={`text-lead leading-[18px] ${option().disabled ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {option().label}
                  </Text>
                  <If when={option().hint !== undefined}>
                    <Text class="text-sm leading-[18px] text-muted-foreground">{option().hint}</Text>
                  </If>
                </View>
                <If when={option().aside !== undefined}>
                  <Text class="shrink-0 text-sm leading-4 text-muted-foreground">
                    {option().aside}
                  </Text>
                </If>
                <If when={option().value === props.value}>
                  <Icon name="check" size={18} />
                </If>
              </View>
            </>
          )}
        </Each>
      </Scroll>
    </Sheet>
  );
}
