import type {
  GitHubPull,
  GitHubSections,
  TaskPullView,
} from "@eta/client-contracts";
import type { TaskDetail } from "./format";
import { cleanup, effect, openUrl, signal, Text, View } from "nsh";
import { wire } from "../../app/session";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { toast } from "../../ui/toast";
import { call, useTarget } from "../../wire/target";
import { failure, unanswered } from "./format";

const READ_MS = 60_000;
const MERGE_MS = 120_000;
const PENDING_POLL_MS = 5000;

/** The pull requests delivered for a task. Call only with the `github` plugin mounted. */
function useTaskPulls(task: () => TaskDetail): () => TaskPullView[] {
  const github = useTarget("github");
  return () =>
    (github.section<GitHubSections["pulls"]>("pulls") ?? []).filter(
      (pull) => pull.taskId === task().id,
    );
}

/** A pull request as GitHub has it now: read once per look, again while GitHub is computing it. */
function usePullState(url: string) {
  const pull = signal<GitHubPull | undefined>(undefined);
  const unavailable = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  cleanup(() => {
    alive = false;
    clearTimeout(timer);
  });
  const read = (): void => {
    clearTimeout(timer);
    wire()
      .call<GitHubPull>("github", "pull", { url }, { timeoutMs: READ_MS })
      .then(
        (answer) => {
          if (!alive) return;
          pull.set(answer);
          unavailable.set(false);
          if (answer.merge === "pending")
            timer = setTimeout(read, PENDING_POLL_MS);
        },
        () => {
          if (alive && pull() === undefined) unavailable.set(true);
        },
      );
  };
  effect(() => {
    if (wire().status() === "open") read();
  });
  return { pull, unavailable, read };
}

function stateLabel(state: GitHubPull["state"]): string {
  return t(`tasks.pr.${state}`);
}

/** 打开 +182 −40, or what stands in for it. */
function Facts(props: { pull: GitHubPull | undefined; unavailable: boolean }) {
  return (
    <If
      when={props.pull}
      else={
        <Text class="text-sm leading-4 text-muted-foreground">
          {props.unavailable
            ? t("tasks.pr.unavailable")
            : t("tasks.pr.reading")}
        </Text>
      }
    >
      {(pull) => (
        <Text class="text-sm leading-4 text-muted-foreground">
          {stateLabel(pull().state)}{" "}
          <Text class="text-state-success">+{pull().additions}</Text>{" "}
          <Text class="text-state-error">−{pull().deletions}</Text>
        </Text>
      )}
    </If>
  );
}

const pullName = (pull: TaskPullView) => `#${pull.number} ${pull.title}`;

/**
 * One delivered pull request: its state on GitHub now and merging it. Merging and completing the
 * task are two steps: the task is done only after GitHub merged, and a task that failed to
 * complete can be completed again without merging again.
 */
function PullRow(props: { task: () => TaskDetail; pull: TaskPullView }) {
  const url = props.pull.url;
  const { pull, unavailable, read } = usePullState(url);
  const merging = signal(false);
  const completing = signal(false);
  const options = signal(false);
  const unfinished = signal<string | undefined>(undefined);
  let mergedHere = false;
  const finished = () => {
    const status = props.task().status;
    return status === "done" || status === "cancelled";
  };
  const busy = () => merging() || completing();
  const mergeable = () => pull()?.merge === "ready" && !busy();

  const complete = (): void => {
    if (completing() || finished()) return;
    completing.set(true);
    call("tasks", "update", { taskId: props.task().id, status: "done" })
      .then(
        () => {
          unfinished.set(undefined);
          toast(
            mergedHere
              ? t("tasks.pr.mergedAndCompleted")
              : t("tasks.pr.completed"),
          );
        },
        (error: unknown) => {
          unfinished.set(
            t("tasks.pr.incompleteWith", { message: failure(error) }),
          );
          toast(t("tasks.pr.incomplete"));
        },
      )
      .finally(() => completing.set(false));
  };

  const merge = (andComplete: boolean): void => {
    const data = pull();
    if (data === undefined || !mergeable()) return;
    merging.set(true);
    wire()
      .call<GitHubPull>(
        "github",
        "merge",
        { url, headSha: data.headSha },
        { timeoutMs: MERGE_MS },
      )
      .then(
        (answer) => {
          pull.set(answer);
          mergedHere = true;
          unfinished.set(undefined);
          merging.set(false);
          if (andComplete) complete();
          else toast(t("tasks.pr.merged"));
        },
        (error: unknown) => {
          merging.set(false);
          const message = unanswered(error)
            ? t("tasks.pr.unknown")
            : failure(error);
          unfinished.set(message);
          toast(message);
          read();
        },
      );
  };

  const problem = () => (finished() ? undefined : unfinished());
  const note = () => {
    const data = pull();
    return data?.merge !== undefined && data.merge !== "ready"
      ? data.reason
      : undefined;
  };
  const tall = () => problem() !== undefined || note() !== undefined;
  return (
    <View
      class={`shrink-0 gap-1 border-t border-border px-4 ${tall() ? "py-[10px]" : "min-h-[60px] justify-center py-2"}`}
    >
      <View class="flex-row items-center gap-[10px]">
        <View
          role="button"
          accessibilityLabel={pullName(props.pull)}
          onPress={() => void openUrl(url)}
          class="min-w-0 grow basis-0 flex-row items-center gap-[10px] active:opacity-60"
        >
          <Icon
            name="gitPullRequest"
            size={18}
            color={
              pull()?.state === "open" ? "state-success" : "muted-foreground"
            }
          />
          <View class="min-w-0 grow basis-0">
            <Text class="truncate text-base leading-[20px] text-foreground">
              {pullName(props.pull)}
            </Text>
            <Facts pull={pull()} unavailable={unavailable()} />
          </View>
        </View>
        <If when={pull()?.merge !== undefined}>
          <If
            when={mergeable()}
            else={
              <View class="h-9 shrink-0 flex-row items-center bg-muted px-[14px]">
                <Text class="text-base leading-[18px] text-muted-foreground">
                  {merging() ? t("tasks.pr.merging") : t("tasks.pr.merge")}
                </Text>
              </View>
            }
          >
            <View class="h-9 shrink-0 flex-row">
              <View
                role="button"
                testID="pr-merge"
                accessibilityLabel={t("tasks.pr.merge")}
                onPress={() => merge(false)}
                class="flex-row items-center bg-primary px-[14px] active:opacity-80"
              >
                <Text class="text-base leading-[18px] text-primary-foreground">
                  {t("tasks.pr.merge")}
                </Text>
              </View>
              <If when={!finished()}>
                <View
                  role="button"
                  testID="pr-more"
                  accessibilityLabel={t("tasks.pr.moreOptions")}
                  onPress={() => options.set(true)}
                  class="w-8 shrink-0 items-center justify-center border-l border-muted-foreground bg-primary active:opacity-80"
                >
                  <Icon name="caretDown" size={12} color="primary-foreground" />
                </View>
              </If>
            </View>
          </If>
        </If>
        <If when={pull()?.state === "merged" && !finished()}>
          <View
            role="button"
            testID="pr-complete"
            accessibilityLabel={t("tasks.pr.complete")}
            onPress={complete}
            class="h-9 shrink-0 flex-row items-center border border-border-strong px-3 active:bg-muted"
          >
            <Text class="text-base leading-[18px] text-foreground">
              {t("tasks.pr.complete")}
            </Text>
          </View>
        </If>
      </View>
      <If when={problem() !== undefined}>
        <Text class="text-sm leading-[18px] text-state-error">{problem()}</Text>
      </If>
      <If when={problem() === undefined && note() !== undefined}>
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {note()}
        </Text>
      </If>
      <Sheet open={options()} onClose={() => options.set(false)}>
        <View class="h-16 shrink-0 justify-center px-4">
          <Text class="text-lead leading-[22px] text-foreground">
            {t("tasks.pr.moreOptions")}
          </Text>
          <Text class="truncate text-sm leading-[18px] text-muted-foreground">
            {pullName(props.pull)}
          </Text>
        </View>
        <Each
          of={[
            { label: t("tasks.pr.merge"), complete: false },
            { label: t("tasks.pr.mergeAndComplete"), complete: true },
          ]}
          key="index"
        >
          {(option) => (
            <View
              role="button"
              onPress={() => {
                options.set(false);
                merge(option().complete);
              }}
              class="h-[52px] shrink-0 flex-row items-center border-t border-border px-4 active:bg-muted"
            >
              <Text class="text-lead leading-[18px] text-foreground">
                {option().label}
              </Text>
            </View>
          )}
        </Each>
      </Sheet>
    </View>
  );
}

function PullRows(props: { task: () => TaskDetail }) {
  const pulls = useTaskPulls(props.task);
  return (
    <Each of={pulls()} key={(pull) => pull.url}>
      {(pull) => <PullRow task={props.task} pull={pull()} />}
    </Each>
  );
}

/** 06's bar. Nothing at all on a host without GitHub: no target, no call, no empty frame. */
export function TaskPulls(props: { task: () => TaskDetail }) {
  return (
    <If when={wire().isMounted("github")}>
      <PullRows task={props.task} />
    </If>
  );
}

function DeliveredPull(props: { pull: TaskPullView }) {
  const { pull, unavailable } = usePullState(props.pull.url);
  return (
    <View class="min-w-0">
      <Text class="text-base leading-[20px] text-foreground">
        {pullName(props.pull)}
      </Text>
      <Facts pull={pull()} unavailable={unavailable()} />
    </View>
  );
}

function DeliveryRow(props: { task: () => TaskDetail }) {
  const pulls = useTaskPulls(props.task);
  return (
    <If when={pulls().length > 0}>
      <View class="flex-row gap-3 border-t border-border px-4 py-3">
        <Text class="w-12 shrink-0 text-sm leading-[20px] text-muted-foreground">
          {t("tasks.fields.delivery")}
        </Text>
        <View class="min-w-0 grow basis-0 gap-2">
          <Each of={pulls()} key={(pull) => pull.url}>
            {(pull) => <DeliveredPull pull={pull()} />}
          </Each>
        </View>
      </View>
    </If>
  );
}

/** 06c's 交付: the row, its label with it, goes when the host has no GitHub or the task no PR. */
export function TaskDelivery(props: { task: () => TaskDetail }) {
  return (
    <If when={wire().isMounted("github")}>
      <DeliveryRow task={props.task} />
    </If>
  );
}
