import type { RunBlock } from "@eta/client-contracts";
import { computed, signal, Text, View } from "nsh";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { sentence, stepOf } from "./steps";

/** How many blocks the frame draws: its newest, which is all its 92 of height can show. */
const SHOWN = 4;

type StepBlock = Extract<RunBlock, { type: "thinking" | "tool" }>;

const stepLine = (block: StepBlock) =>
  block.type === "thinking"
    ? t("chat.thinking.fold", {
        count: block.text.length.toLocaleString("en-US"),
      })
    : sentence(stepOf(block));

/**
 * A reply's process, in any conversation: while the run is in flight, a frame of one size from
 * before the first token to the end, holding everything the run has written in order — its
 * thoughts and calls as a line each, its words whole, written as they stream — with the newest at
 * the bottom. The frame never grows, so a long run does not push the conversation away and replies
 * written at once do not push each other. Once the run is over it folds to its head, and the answer
 * is drawn under it. Words the user put into the run (a steer) are one faint line where they
 * arrived, never their text: the message itself is in the bubble it was put into. While the reply
 * is writing its head has the reply's own Stop.
 */
export function ProcessBox(props: {
  blocks: RunBlock[];
  /** Nothing from the run yet: the frame is already there, at work. */
  waiting: boolean;
  folded: boolean;
  onViewAll: () => void;
  /** The reply is writing: its head stops it, and says so while it stops. */
  stop?: { stopping: boolean; onPress: () => void } | undefined;
}) {
  const shown = computed(() => props.blocks.slice(-SHOWN));
  // What it said is open from the start, as a step a reader folds by its head; a thought is a line.
  const closed = signal<Record<string, boolean>>({});
  const toggle = (id: string) =>
    closed.update((all) => ({ ...all, [id]: all[id] !== true }));
  const steps = computed(
    () =>
      props.blocks.filter(
        (block) => block.type === "thinking" || block.type === "tool",
      ).length,
  );
  const head = (
    <View
      class={`h-8 shrink-0 flex-row items-center px-[10px] ${props.folded ? "" : "border-b border-border"}`}
    >
      <Text class="truncate grow basis-0 text-sm leading-4 text-muted-foreground">
        {!props.folded && steps() === 0
          ? t("chat.thinking.now")
          : t("chat.process.steps", { count: steps() })}
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
      <If when={props.stop}>
        {(stop) => (
          <View
            role="button"
            accessibilityLabel={
              stop().stopping
                ? t("chat.process.stopping")
                : t("chat.process.stop")
            }
            testID="process-stop"
            // Pressing again while it stops asks again: the host answers the same.
            onPress={() => stop().onPress()}
            class="h-8 justify-center pl-3 active:opacity-60"
          >
            <Text class="text-sm leading-4 text-foreground">
              {stop().stopping
                ? t("chat.process.stopping")
                : t("chat.process.stop")}
            </Text>
          </View>
        )}
      </If>
    </View>
  );
  return (
    <View class="border border-border" testID="process-box">
      {head}
      <If when={!props.folded}>
        <View
          class="h-[92px] shrink-0 justify-end gap-1 overflow-hidden px-[10px] py-[6px]"
          testID="process-frame"
        >
          <If when={props.waiting}>
            <View class="h-[18px] flex-row items-center">
              <View class="h-2 grow basis-0 bg-muted" />
            </View>
          </If>
          <Each of={shown()} key={(block) => block.id}>
            {(block, index) => (
              <If
                when={block().type === "text"}
                else={
                  <If
                    when={block().type === "steer"}
                    else={
                      <Text
                        class={`shrink-0 truncate text-sm leading-[18px] ${index() === shown().length - 1 ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {stepLine(block() as StepBlock)}
                      </Text>
                    }
                  >
                    <Text class="shrink-0 truncate text-center text-sm leading-[18px] text-faint">
                      {t("chat.process.steer")}
                    </Text>
                  </If>
                }
              >
                <View class="shrink-0">
                  <View
                    role="button"
                    accessibilityLabel={t("chat.process.note")}
                    onPress={() => toggle(block().id)}
                    class="h-[18px] flex-row items-center gap-1 active:opacity-60"
                  >
                    <Icon
                      name={
                        closed()[block().id] === true
                          ? "caretRight"
                          : "caretDown"
                      }
                      size={10}
                      color="faint"
                    />
                    <Text class="text-sm leading-[18px] text-faint">
                      {t("chat.process.note")}
                    </Text>
                  </View>
                  <If when={closed()[block().id] !== true}>
                    <Markdown
                      text={(block() as { text?: string }).text ?? ""}
                      small
                      streaming
                    />
                  </If>
                </View>
              </If>
            )}
          </Each>
        </View>
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
