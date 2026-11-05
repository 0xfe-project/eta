import type { BoardTaskView } from "@eta/client-contracts";
import { Scroll, Text, View } from "nsh";
import {
  agentById,
  boardTasks,
  machines,
  pendingInteractions,
} from "../../app/lists";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { Icon } from "../../ui/Icon";
import { SectionLabel } from "../../ui/Page";
import { QuestionCard } from "./QuestionCard";
import { executorOf, RunRow, runCounts, useRuns } from "./running";

/** The board's tasks that are the user's to act on (web: `use-attention.ts`). */
const attentionTasks = (): BoardTaskView[] =>
  boardTasks().filter(
    (task) => task.status === "in_review" || task.status === "blocked",
  );

function Gauge(props: { value: number; label: string; big?: boolean }) {
  return (
    <View
      class={`gap-[2px] ${props.big ? "grow basis-0" : "w-[64px] shrink-0"}`}
    >
      <Text
        class={`tracking-[-0.02em] text-foreground ${props.big ? "text-gauge leading-[64px]" : "text-gauge-sm leading-[32px]"}`}
      >
        {String(props.value)}
      </Text>
      <Text
        class={`text-md leading-[18px] ${props.big ? "text-foreground" : "text-muted-foreground"}`}
      >
        {props.label}
      </Text>
    </View>
  );
}

function TaskRow(props: { task: BoardTaskView; last: boolean }) {
  const blocked = () => props.task.status === "blocked";
  const line = () => {
    const number = `#${props.task.number}`;
    const executor = agentById(executorOf(props.task))?.name;
    if (blocked()) {
      return [
        number,
        t("inbox.task.blocked"),
        ...(executor === undefined
          ? []
          : [t("inbox.task.waitingForYou", { agent: executor })]),
      ].join(" · ");
    }
    return [
      number,
      t("inbox.task.inReview"),
      ...(executor === undefined ? [] : [executor]),
    ].join(" · ");
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.task.title}
      onPress={() => go.task(props.task.id)}
      class={`h-[56px] shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted ${props.last ? "border-b" : ""}`}
    >
      <Icon
        name={blocked() ? "prohibit" : "eye"}
        size={18}
        color={blocked() ? "state-error" : "muted-foreground"}
      />
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-base leading-[20px] text-foreground">
          {props.task.title}
        </Text>
        <Text
          class={`truncate text-sm leading-4 ${blocked() ? "text-state-error" : "text-muted-foreground"}`}
        >
          {line()}
        </Text>
      </View>
      <Icon name="caretRight" size={14} color="faint" />
    </View>
  );
}

/** 01a: nothing waits, so the page says what is going on instead. */
function Quiet() {
  const { running } = useRuns();
  return (
    <>
      <View class="shrink-0 gap-1 border-t border-border px-4 pt-[20px] pb-[24px]">
        <Text class="text-input leading-[24px] text-foreground">
          {t("inbox.empty.title")}
        </Text>
        <Text class="text-md leading-[20px] text-muted-foreground">
          {t("inbox.empty.body")}
        </Text>
      </View>
      <If when={running().length > 0}>
        <SectionLabel
          title={t("inbox.section.running", { count: running().length })}
          border={false}
        />
        <Each of={running()} key={(run) => run.key}>
          {(run, index) => (
            <RunRow run={run()} last={index() === running().length - 1} />
          )}
        </Each>
      </If>
    </>
  );
}

export function InboxTab() {
  /** The longest wait first: the host lists the newest first. */
  const questions = () =>
    pendingInteractions().toSorted((a, b) => a.createdAt - b.createdAt);
  const tasks = attentionTasks;
  const waiting = () => questions().length + tasks().length;
  const online = () =>
    machines().filter((machine) => machine.status === "online").length;

  return (
    <View class="flex-1 bg-background">
      <View class="h-11 shrink-0 flex-row items-center justify-between px-4">
        <Text class="text-md leading-4 tracking-[0.14em] text-foreground">
          ETA
        </Text>
        <View
          role="button"
          accessibilityLabel={t("inbox.machinesOnline", { count: online() })}
          testID="machines-online"
          onPress={() => go.settings("machines")}
          class="h-11 flex-row items-center gap-2 active:opacity-60"
        >
          <Text class="text-sm leading-4 text-muted-foreground">
            {t("inbox.machinesOnline", { count: online() })}
          </Text>
          <Icon name="hardDrives" size={18} color="muted-foreground" />
        </View>
      </View>
      <Scroll
        style={{ flex: 1 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View class="flex-row items-end gap-[32px] px-4 pt-3 pb-[20px]">
          <Gauge big value={waiting()} label={t("inbox.gauge.waiting")} />
          <Gauge value={runCounts().running} label={t("inbox.gauge.running")} />
          <Gauge value={runCounts().queued} label={t("inbox.gauge.queued")} />
        </View>
        <If when={waiting() > 0} else={<Quiet />}>
          <If when={questions().length > 0}>
            <View class="border-t border-border">
              <SectionLabel
                title={t("inbox.section.questions", {
                  count: questions().length,
                })}
              />
              <Each of={questions()} key={(interaction) => interaction.id}>
                {(interaction) => <QuestionCard interaction={interaction()} />}
              </Each>
            </View>
          </If>
          <If
            when={tasks().length > 0}
            else={
              <View class="gap-1 p-4">
                <Text class="text-md leading-[20px] text-muted-foreground">
                  {t("inbox.giveUpNote")}
                </Text>
              </View>
            }
          >
            <SectionLabel
              title={t("inbox.section.tasks", { count: tasks().length })}
              border={false}
            />
            <Each of={tasks()} key={(task) => task.id}>
              {(task, index) => (
                <TaskRow task={task()} last={index() === tasks().length - 1} />
              )}
            </Each>
          </If>
        </If>
      </Scroll>
    </View>
  );
}
