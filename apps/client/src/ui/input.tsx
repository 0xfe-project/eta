import type { InputRef, JSX, TextStyle, ViewStyle } from "nsh";
import { View } from "nsh";
import { Input } from "nsh/base";
import { pickerTarget } from "../components/element-picker";
import {
  colors,
  fontFamily,
  Fonts,
  textFaces,
  textStyle,
} from "../components/theme";
import { control, space, weight } from "../components/tokens";
import { Label } from "./text";

type FieldInputProps = Pick<
  Parameters<typeof Input>[0],
  | "role"
  | "autoFocus"
  | "accessibilityState"
  | "accessibilityControls"
  | "accessibilityActiveDescendant"
  | "readonly"
  | "onContentSizeChange"
  | "onSelectionChange"
  | "onFocus"
  | "onCompositionChange"
  | "pasteBehavior"
  | "onPaste"
>;

export function Field(
  props: FieldInputProps & {
    label: string;
    value: string;
    placeholder?: string;
    masked?: boolean;
    maxLength?: number;
    multiline?: boolean;
    /** Compact 28px single-line height with `small` text and strong resting border. */
    compact?: boolean;
    /** Highlights the border in red when validation failed. */
    invalid?: boolean;
    style?: TextStyle;
    inputRef?: (ref: InputRef) => void;
    onChange: (value: string) => void;
    onSubmit?: () => void;
    onBlur?: () => void;
  },
) {
  const color = colors();
  const fonts = Fonts();
  const type = textFaces();
  const picker = pickerTarget("Field", "apps/client/src/ui/input.tsx", false);
  return (
    <Input
      ref={(ref) => {
        picker.ref(ref);
        props.inputRef?.(ref);
      }}
      role={props.role}
      autoFocus={props.autoFocus}
      accessibilityState={props.accessibilityState}
      accessibilityControls={props.accessibilityControls}
      accessibilityActiveDescendant={props.accessibilityActiveDescendant}
      readonly={props.readonly}
      onContentSizeChange={props.onContentSizeChange}
      onSelectionChange={props.onSelectionChange}
      onFocus={props.onFocus}
      onCompositionChange={props.onCompositionChange}
      pasteBehavior={props.pasteBehavior}
      onPaste={props.onPaste}
      onMouseEnter={picker.onMouseEnter}
      onMouseLeave={picker.onMouseLeave}
      accessibilityLabel={props.label}
      value={props.value}
      placeholder={props.placeholder}
      masked={props.masked}
      maxLength={props.maxLength}
      multiline={props.multiline}
      submitBehavior={
        props.onSubmit
          ? "submit"
          : props.multiline
            ? "newline"
            : "blurAndSubmit"
      }
      onChange={({ value }) => props.onChange(value)}
      onSubmit={() => props.onSubmit?.()}
      onBlur={props.onBlur}
      focusStyle={{ borderColor: props.invalid ? color().red : color().ink }}
      style={{
        color: color().ink,
        placeholderColor: props.compact ? color().faint : color().muted,
        backgroundColor: color().canvas,
        fontFamily: fontFamily(fonts().interface),
        ...textStyle(type(props.compact ? "small" : "body")),
        height: props.compact ? control.md : space[32],
        paddingHorizontal: space[8],
        paddingVertical: props.compact ? 0 : space[4],
        borderWidth: 1,
        borderColor: props.invalid
          ? color().red
          : props.compact
            ? color().strong
            : color().border,
        borderRadius: 0,
        ...(props.multiline ? { overflow: "hidden" as const } : {}),
        ...props.style,
      }}
    />
  );
}

/**
 * Standard form field container: label, control slot, optional hint, and accessible error line.
 */
export function FormField(props: {
  label: string;
  hint?: string;
  error?: string;
  style?: ViewStyle;
  children?: JSX.Element;
}) {
  return (
    <View style={{ gap: space[4], ...props.style }}>
      <Label variant="small" weight={weight.strong}>
        {props.label}
      </Label>
      {props.children}
      <If when={props.error}>
        <Label variant="small" tone="red">
          {props.error}
        </Label>
      </If>
      <If when={!props.error && props.hint}>
        <Label variant="small" tone="muted">
          {props.hint}
        </Label>
      </If>
    </View>
  );
}
