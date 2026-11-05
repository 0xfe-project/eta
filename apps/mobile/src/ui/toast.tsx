import { signal, Text, View } from "nsh";

const message = signal<string | undefined>(undefined);
let timer: ReturnType<typeof setTimeout> | undefined;

/** One line over the tab bar for a moment: what a press could not do. */
export function toast(text: string): void {
  clearTimeout(timer);
  message.set(text);
  timer = setTimeout(() => message.set(undefined), 3000);
}

export function ToastHost() {
  return (
    <If when={message() !== undefined}>
      <View
        class="absolute left-4 right-4 bottom-[96px] bg-primary px-3 py-[10px]"
      >
        <Text class="text-md leading-[18px] text-primary-foreground">{message()}</Text>
      </View>
    </If>
  );
}
