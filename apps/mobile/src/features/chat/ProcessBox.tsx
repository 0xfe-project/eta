import type { RunBlock, ToolBlock } from "./run";
import { computed, Text, View } from "nsh";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { sentence, stepOf } from "./steps";

/** How many steps the box shows: what fits its 92 of height. */
const SHOWN = 3;

const stepLine = (block: Exclude<RunBlock, { type: "text" }>) =>
  block.type === "thinking"
    ? t("chat.thinking.fold", {
        count: block.text.length.toLocaleString("en-US"),
      })
    : sentence(stepOf(block));

/**
 * A reply's process in a group: a frame that is the same size before the first token, while steps
 * come and until the reply reaches its final text, when it folds to its head. The box never grows,
 * so a long run does not push the conversation away.
 */
export function ProcessBox(props: {
  steps: Exclude<RunBlock, { type: "text" }>[];
  /** Nothing from the run yet: the frame is already there, at work. */
  waiting: boolean;
  folded: boolean;
  onViewAll: () => void;
}) {
  const shown = computed(() => props.steps.slice(-SHOWN));
  const head = (
    <View
      class={`h-8 shrink-0 flex-row items-center px-[10px] ${props.folded ? "" : "border-b border-border"}`}
    >
      <Text class="grow basis-0 text-sm leading-4 text-muted-foreground">
        {props.waiting
          ? t("chat.thinking.now")
          : t("chat.process.steps", { count: props.steps.length })}
      </Text>
      <View
        role="button"
        accessibilityLabel={t("chat.process.viewAll")}
        onPress={props.onViewAll}
        class={`h-8 justify-center pl-3 active:opacity-60 ${props.waiting ? "opacity-0" : ""}`}
      >
        <Text class="text-sm leading-4 text-foreground">
          {t("chat.process.viewAll")}
        </Text>
      </View>
    </View>
  );
  return (
    <View class="border border-border" testID="process-box">
      {head}
      <If when={!props.folded}>
        <View class="h-[92px] shrink-0 justify-end gap-1 overflow-hidden px-[10px] py-[6px]">
          <If when={props.waiting}>
            <View class="h-[18px] flex-row items-center">
              <View class="h-2 grow basis-0 bg-muted" />
            </View>
          </If>
          <Each of={shown()} key={(step) => step.id}>
            {(step, index) => (
              <Text
                class={`truncate text-sm leading-[18px] ${index() === shown().length - 1 ? "text-foreground" : "text-muted-foreground"}`}
              >
                {stepLine(step())}
              </Text>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

/** One step of a direct chat's reply (03h): a framed line of its own. */
export function ToolRow(props: { block: ToolBlock; onPress: () => void }) {
  const step = computed(() => stepOf(props.block));
  return (
    <View
      role="button"
      accessibilityLabel={sentence(step())}
      onPress={props.onPress}
      class="h-9 shrink-0 flex-row items-center gap-3 border border-border px-[10px] active:bg-muted"
    >
      <Text
        class={`min-w-[28px] shrink-0 text-sm leading-4 ${step().refused ? "text-state-error" : "text-muted-foreground"}`}
      >
        {step().verb}
      </Text>
      <Text class="truncate grow basis-0 text-md leading-4 text-foreground">
        {step().text}
      </Text>
      <Counts added={step().added} removed={step().removed} />
      <If when={step().note !== undefined}>
        <Text
          class={`text-sm leading-4 ${step().failed ? "text-state-error" : "text-muted-foreground"}`}
        >
          {step().note}
        </Text>
      </If>
    </View>
  );
}

/** Lines added and removed, the one place green and red mean something. */
export function Counts(props: {
  added?: number | undefined;
  removed?: number | undefined;
}) {
  return (
    <>
      <If when={(props.added ?? 0) > 0}>
        <Text class="text-sm leading-4 text-state-success">+{props.added}</Text>
      </If>
      <If when={(props.removed ?? 0) > 0}>
        <Text class="text-sm leading-4 text-state-error">−{props.removed}</Text>
      </If>
    </>
  );
}

/** What a reply worked through: folded, with its size on the line. */
export function ThinkingRow(props: {
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <View class="border border-border">
      <View
        role="button"
        onPress={props.onToggle}
        class="h-9 shrink-0 flex-row items-center gap-2 px-[10px] active:bg-muted"
      >
        <Icon
          name={props.open ? "caretDown" : "caretRight"}
          size={14}
          color="faint"
        />
        <Text class="text-sm leading-4 text-muted-foreground">
          {t("chat.thinking.fold", {
            count: props.text.length.toLocaleString("en-US"),
          })}
        </Text>
      </View>
      <If when={props.open}>
        <View class="border-t border-border px-[10px] py-2">
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {props.text}
          </Text>
        </View>
      </If>
    </View>
  );
}
