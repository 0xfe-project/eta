// The parts every 新建 page is made of.

import type { JSX } from "nsh";
import { Keyboard, Text, View } from "nsh";
import { Input } from "nsh/base";
import { t } from "../../i18n";
import { nav } from "../../nav/stack";
import { Icon } from "../../ui/Icon";

/** A page's way out: 07's cross, or the arrow of a step that has one before it. */
export function TopBar(props: { icon?: "x" | "caretLeft" }) {
  return (
    <View class="h-12 shrink-0 flex-row items-center pl-2 pr-4">
      <View
        role="button"
        accessibilityLabel={
          props.icon === "caretLeft" ? t("common.back") : t("create.close")
        }
        testID="back"
        onPress={() => nav.pop()}
        class="h-11 w-10 items-center justify-center active:opacity-60"
      >
        <Icon name={props.icon ?? "x"} size={20} />
      </View>
    </View>
  );
}

export function Title(props: {
  title: string;
  hint?: string;
  children?: JSX.Element;
}) {
  return (
    <View
      class={`shrink-0 px-4 pt-1 pb-[20px] ${props.hint === undefined ? "gap-[10px]" : "gap-1"}`}
    >
      <Text class="text-gauge-sm leading-[34px] tracking-[-0.02em] text-foreground">
        {props.title}
      </Text>
      <If when={props.hint !== undefined}>
        <Text class="text-md leading-[20px] text-muted-foreground">
          {props.hint}
        </Text>
      </If>
      {props.children}
    </View>
  );
}

/** The caption over a list. */
export function Caption(props: { title: string; height: number }) {
  return (
    <View
      class="shrink-0 flex-row items-end px-4 pb-[6px]"
      style={{ height: props.height }}
    >
      <Text class="text-sm leading-[18px] text-muted-foreground">
        {props.title}
      </Text>
    </View>
  );
}

/** The one thing a page is for, at its foot. */
export function Cta(props: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View class="shrink-0 flex-row border-t border-border px-4 py-2">
      <View
        role="button"
        accessibilityLabel={props.title}
        testID={props.testID}
        disabled={props.disabled === true}
        onPress={() => {
          Keyboard.dismiss();
          props.onPress();
        }}
        class={`h-[52px] grow basis-0 items-center justify-center ${props.disabled ? "bg-muted" : "bg-primary active:opacity-80"}`}
      >
        <Text
          class={`text-lead leading-[18px] ${props.disabled ? "text-muted-foreground" : "text-primary-foreground"}`}
        >
          {props.title}
        </Text>
      </View>
    </View>
  );
}

const CAPTION = "text-sm leading-[18px] text-muted-foreground";
const INPUT = "text-input leading-5 text-foreground placeholder:text-faint";

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
  /** A multiline field's height, or its least when it `grow`s into what the page leaves. */
  height?: number;
  grow?: boolean;
  autoFocus?: boolean;
  error?: string | undefined;
  testID?: string;
  onFocus?: () => void;
}) {
  return (
    <View
      class={`shrink-0 gap-[2px] border-t border-border px-4 py-[10px] ${props.grow ? "grow" : ""}`}
      style={
        props.height === undefined ? undefined : { minHeight: props.height }
      }
    >
      <Text class={CAPTION}>{props.label}</Text>
      <Input
        testID={props.testID}
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        multiline={props.multiline}
        autoFocus={props.autoFocus}
        onFocus={props.onFocus}
        class={`${INPUT} ${props.multiline ? "grow" : ""}`}
      />
      <If when={props.error !== undefined}>
        <Text class="text-sm leading-[18px] text-state-error">
          {props.error}
        </Text>
      </If>
    </View>
  );
}

/** A value that is changed somewhere else: a sheet, or the directory picker. */
export function ChoiceField(props: {
  label: string;
  value: string;
  hint?: string | undefined;
  error?: string | undefined;
  note?: string | undefined;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      disabled={props.disabled === true}
      onPress={props.onPress}
      class="shrink-0 flex-row items-center gap-3 border-t border-border px-4 py-[10px] active:bg-muted"
    >
      <View class="min-w-0 grow basis-0 gap-[2px]">
        <Text class={CAPTION}>{props.label}</Text>
        <Text class="text-input leading-5 text-foreground">{props.value}</Text>
        <If when={props.hint !== undefined}>
          <Text class={CAPTION}>{props.hint}</Text>
        </If>
        <If when={props.note !== undefined}>
          <Text class="text-sm leading-[18px] text-state-warning">
            {props.note}
          </Text>
        </If>
        <If when={props.error !== undefined}>
          <Text class="text-sm leading-[18px] text-state-error">
            {props.error}
          </Text>
        </If>
      </View>
      <Icon name="caretRight" size={14} color="faint" />
    </View>
  );
}

export function CheckBox(props: { checked: boolean; size: number }) {
  return (
    <View
      class={`shrink-0 items-center justify-center ${props.checked ? "bg-primary" : "border border-border-strong"}`}
      style={{ width: props.size, height: props.size }}
    >
      <If when={props.checked}>
        <Icon name="check" size={12} color="primary-foreground" />
      </If>
    </View>
  );
}
