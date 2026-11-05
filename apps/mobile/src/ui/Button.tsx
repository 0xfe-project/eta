import type { JSX } from "nsh";
import { Text, View } from "nsh";

export type ButtonVariant =
  | "primary"
  | "outline"
  | "danger"
  | "ghost"
  | "disabled";

const box: Record<ButtonVariant, string> = {
  primary: "bg-primary active:opacity-80",
  outline: "border border-border-strong active:bg-muted",
  danger: "bg-state-error active:opacity-80",
  ghost: "active:opacity-60",
  disabled: "bg-muted",
};
const label: Record<ButtonVariant, string> = {
  primary: "text-primary-foreground",
  outline: "text-foreground",
  danger: "text-primary-foreground",
  ghost: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

/** Paper's 40 (in a row) and 44 / 52 (a page's own) high buttons. Square, one line of 14. */
export function Button(props: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  height?: number;
  /** Fills the row with its siblings; off, it hugs its label with 16 of padding. */
  grow?: boolean;
  disabled?: boolean;
  icon?: JSX.Element;
  testID?: string;
}) {
  const variant = (): ButtonVariant =>
    props.disabled ? "disabled" : (props.variant ?? "outline");
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      testID={props.testID}
      onPress={() => {
        if (!props.disabled) props.onPress?.();
      }}
      class={`flex-row items-center justify-center gap-2 ${props.grow === false ? "px-4" : "grow basis-0"} ${box[variant()]}`}
      style={{ height: props.height ?? 40 }}
    >
      {props.icon}
      <Text class={`text-base leading-[18px] ${label[variant()]}`}>
        {props.title}
      </Text>
    </View>
  );
}
