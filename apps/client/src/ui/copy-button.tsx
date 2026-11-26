import type { ViewStyle } from "nsh";
import type { light } from "../components/theme";
import { cleanup, Clipboard, signal } from "nsh";
import { uiText } from "../i18n";
import { Button } from "./button";

const COPIED_RESET_MS = 2500;

export function CopyButton(props: {
  /** Text (or lazy getter) written to the clipboard when pressed. */
  value: string | (() => string);
  label: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  tone?: "primary" | "plain" | "ghost" | "danger";
  labelTone?: keyof typeof light;
  hoverTone?: keyof typeof light;
  size?: number;
  disabled?: boolean;
  tooltip?: string;
  style?: ViewStyle;
  /** Optional wrapper for host error reporting (e.g. `host.action`). */
  onError?: (error: unknown) => void;
}) {
  const copied = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(timer));

  async function copy() {
    const text =
      typeof props.value === "function" ? props.value() : props.value;
    if (!text) return;
    try {
      await Clipboard.writeText(text);
      copied.set(true);
      clearTimeout(timer);
      timer = setTimeout(() => copied.set(false), COPIED_RESET_MS);
    } catch (error) {
      props.onError?.(error);
    }
  }

  return (
    <Button
      label={copied() ? (props.copiedLabel ?? uiText("copied")) : props.label}
      icon={copied() ? "check" : "copy"}
      iconOnly={props.iconOnly}
      tone={props.tone}
      labelTone={props.labelTone}
      hoverTone={props.hoverTone}
      size={props.size}
      disabled={props.disabled}
      tooltip={props.tooltip}
      style={props.style}
      onPress={() => void copy()}
    />
  );
}
