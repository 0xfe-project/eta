import type { JSX } from "nsh";
import { Scroll, Text, View } from "nsh";
import { NavPage } from "nsh/base";
import { t } from "../i18n";
import { ConnectionBanner } from "./ConnectionBanner";
import { Icon } from "./Icon";
import { nav } from "../nav/stack";

const INSET_TOP = "pt-[env(safe-area-inset-top)]";
export const INSET_BOTTOM = "pb-[env(safe-area-inset-bottom)]";

/** A pushed page: the design draws every header itself, so the system's is off. */
export function Page(props: { children?: JSX.Element; bottom?: boolean }) {
  return (
    <NavPage headerVisible={false} class={`flex-1 bg-background ${INSET_TOP} ${props.bottom === false ? "" : INSET_BOTTOM}`}>
      <ConnectionBanner />
      {props.children}
    </NavPage>
  );
}

/** The header band of a pushed page: back, then a title and a line under it, then its actions. */
export function Header(props: {
  title?: string;
  subtitle?: string;
  /** A muted crumb beside the back arrow, as 06's `#128` and 06i's 任务. */
  crumb?: string;
  right?: JSX.Element;
  onBack?: () => void;
  border?: boolean;
}) {
  return (
    <View
      class={`h-12 shrink-0 flex-row items-center gap-2 pr-4 pl-2 ${props.border === false ? "" : "border-b border-border"}`}
    >
      <View
        role="button"
        accessibilityLabel={t("common.back")}
        testID="back"
        onPress={() => (props.onBack ? props.onBack() : nav.pop())}
        class="h-11 w-10 items-center justify-center active:opacity-60"
      >
        <Icon name="caretLeft" size={20} />
      </View>
      <View class="min-w-0 grow basis-0">
        <If when={props.title !== undefined}>
          <Text class="truncate text-lead leading-[20px] text-foreground">
            {props.title}
          </Text>
        </If>
        <If when={props.subtitle !== undefined}>
          <Text class="truncate text-xs leading-[14px] text-muted-foreground">
            {props.subtitle}
          </Text>
        </If>
        <If when={props.crumb !== undefined}>
          <Text class="text-md leading-4 text-muted-foreground">{props.crumb}</Text>
        </If>
      </View>
      {props.right}
    </View>
  );
}

/** The 34-high caption over a list: 确认请求 3, 任务 3. */
export function SectionLabel(props: { title: string; border?: boolean }) {
  return (
    <View
      class={`h-[34px] shrink-0 flex-row items-end px-4 pb-[6px] ${props.border === false ? "" : "border-b border-border"}`}
    >
      <Text class="text-sm leading-[18px] text-muted-foreground">{props.title}</Text>
    </View>
  );
}

/** A vertically scrolling page body that keeps inputs clear of the keyboard. */
export function Body(props: { children?: JSX.Element; class?: string }) {
  return (
    <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
      <View class={props.class ?? ""}>{props.children}</View>
    </Scroll>
  );
}
