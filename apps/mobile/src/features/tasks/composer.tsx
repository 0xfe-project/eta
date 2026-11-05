import type { TaskResults } from "@eta/client-contracts";
import type { InputRef } from "nsh";
import type { TaskDetail } from "./format";
import {
  cleanup,
  computed,
  keyboardFrame,
  safeArea,
  signal,
  Text,
  View,
} from "nsh";
import { Input } from "nsh/base";
import { agents, conversations } from "../../app/lists";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { mentionedMembers, mentionLabel } from "../chat/mentions";
import { buildMenu } from "../chat/menu";
import { failure } from "./format";

/** What was being written on each task, kept while the task's page is away. */
const drafts = new Map<string, string>();

/** A comment on its way: shown under the thread until the thread has it. */
export interface Outgoing {
  /** The call's `clientId`: a retry is the same comment, and the thread names it by this too. */
  id: string;
  body: string;
  mentions: string[];
  /** Why it did not arrive; absent while it is being sent. */
  failure?: string;
}

let sent = 0;

/** The comments being sent on a task. The box is free for the next one the moment one goes. */
export function useComments(task: () => TaskDetail) {
  const items = signal<Outgoing[]>([]);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const waiting = computed(() =>
    items().filter(
      (item) => !task().activity.some((a) => a.data.clientId === item.id),
    ),
  );
  const deliver = (item: Outgoing): void => {
    const args = {
      taskId: task().id,
      body: item.body,
      clientId: item.id,
      ...(item.mentions.length > 0 ? { mentions: item.mentions } : {}),
    };
    call<TaskResults["comment"]>("tasks", "comment", args).catch(
      (error: unknown) => {
        const message = failure(error);
        if (!alive) {
          toast(t("tasks.comment.deliveryFailed", { message }));
          return;
        }
        items.update((all) =>
          all.map((other) =>
            other.id === item.id ? { ...other, failure: message } : other,
          ),
        );
      },
    );
  };
  return {
    waiting,
    send(body: string, mentions: string[]): void {
      sent += 1;
      const item = { id: `c-${Date.now()}-${sent}`, body, mentions };
      items.update((all) => [...all, item]);
      deliver(item);
    },
    retry(id: string): void {
      const item = items().find((other) => other.id === id);
      if (item === undefined) return;
      const { failure: _failure, ...again } = item;
      items.update((all) =>
        all.map((other) => (other.id === id ? again : other)),
      );
      deliver(again);
    },
    discard(id: string): void {
      items.update((all) => all.filter((other) => other.id !== id));
    },
  };
}

/**
 * Who a comment can call in: the members of the group the task came from, or, for a task from a
 * direct chat, any agent. Labelled as the chat's composer labels them.
 */
function mentionable(task: TaskDetail) {
  const origin = conversations().find(
    (c) => c.id === task.originConversationId,
  );
  const members =
    origin?.kind === "group"
      ? new Set(origin.participants.map((member) => member.agentId))
      : undefined;
  const people = agents().filter((agent) => members?.has(agent.id) ?? true);
  return people.map((agent) => ({
    id: agent.id,
    name: mentionLabel(agent, people),
    busy: agent.status !== "idle",
  }));
}

/** The box at the bottom of a task, always there: sending continues the run or wakes the next. */
export function Composer(props: {
  task: () => TaskDetail;
  comments: ReturnType<typeof useComments>;
  focus?: (focus: () => void) => void;
}) {
  const id = props.task().id;
  const text = signal(drafts.get(id) ?? "");
  const dismissed = signal(false);
  let input: InputRef | undefined;
  cleanup(() => drafts.set(id, text()));
  props.focus?.(() => input?.focus());
  const members = () => mentionable(props.task());
  const menu = computed(() =>
    buildMenu({
      text: text(),
      members: members(),
      files: [],
      commands: [],
      tasks: [],
      dismissed: dismissed(),
    }),
  );
  const items = () => menu()?.items ?? [];
  const choose = (index: number): void => {
    const state = menu();
    const item = state?.items[index];
    if (state === null || state === undefined || item === undefined) return;
    text.set(`${text().slice(0, state.start)}${item.value}`);
    input?.focus();
  };
  const send = (): void => {
    const body = text().trim();
    if (body === "") return;
    props.comments.send(body, mentionedMembers(body, members()));
    text.set("");
  };
  const at = (): void => {
    const now = text();
    text.set(now === "" || /\s$/.test(now) ? `${now}@` : `${now} @`);
    dismissed.set(false);
    input?.focus();
  };
  const memberId = (index: number): string | undefined => {
    const item = items()[index];
    return item?.kind === "member" ? item.memberId : undefined;
  };
  return (
    <View
      class="shrink-0"
      style={{
        paddingBottom: keyboardFrame().height > 0 ? 0 : safeArea().bottom,
      }}
    >
      <If when={items().length > 0}>
        <View class="border-t border-border">
          <Each of={items()} key="index">
            {(item, index) => (
              <View
                role="button"
                accessibilityLabel={item().label}
                onPress={() => choose(index())}
                class="h-11 shrink-0 flex-row items-center gap-[10px] px-4 active:bg-muted"
              >
                <If
                  when={memberId(index())}
                  else={<View style={{ width: 20, height: 20 }} />}
                >
                  {(agent) => <AgentAvatar id={agent()} size={20} />}
                </If>
                <Text class="grow basis-0 truncate text-md leading-4 text-foreground">
                  {item().label}
                </Text>
                <If when={item().kind === "member"}>
                  <Text class="text-sm leading-4 text-muted-foreground">
                    {members().find((m) => m.id === memberId(index()))?.busy
                      ? t("tasks.mention.busy")
                      : t("tasks.mention.reply")}
                  </Text>
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
      <View class="min-h-[52px] flex-row items-center gap-1 border-t border-border py-[6px] pl-4 pr-2">
        <Input
          ref={(ref: InputRef) => {
            input = ref;
          }}
          testID="task-comment"
          value={text()}
          onChange={({ value }) => {
            text.set(value);
            dismissed.set(false);
          }}
          placeholder={t("tasks.comment.placeholder")}
          multiline
          maxLength={20000}
          class="max-h-[120px] min-w-0 grow basis-0 text-input leading-5 text-foreground placeholder:text-faint"
        />
        <View
          role="button"
          testID="task-at"
          accessibilityLabel={t("tasks.comment.mention")}
          onPress={at}
          class="size-10 shrink-0 items-center justify-center active:opacity-60"
        >
          <Icon name="at" size={20} color="muted-foreground" />
        </View>
        <If when={text().trim() !== ""}>
          <View
            role="button"
            testID="task-send"
            accessibilityLabel={t("tasks.comment.send")}
            onPress={send}
            class="size-10 shrink-0 items-center justify-center active:opacity-60"
          >
            <Icon name="paperPlaneRight" size={20} />
          </View>
        </If>
      </View>
    </View>
  );
}

/** 06b: what is on its way, with what went wrong and what to do about it. */
export function OutgoingComments(props: {
  comments: ReturnType<typeof useComments>;
}) {
  return (
    <If when={props.comments.waiting().length > 0}>
      <View class="shrink-0 flex-row items-center gap-2 px-4 pb-2 pt-3">
        <Text class="text-sm leading-4 text-muted-foreground">
          {t("tasks.comment.queued")}
        </Text>
        <View class="h-px grow basis-0 bg-border" />
      </View>
      <Each of={props.comments.waiting()} key={(item) => item.id}>
        {(item) => (
          <View class="shrink-0 gap-[2px] py-[6px] pl-[54px] pr-4">
            <Text class="text-base leading-[23px] text-foreground">
              {item().body}
            </Text>
            <If
              when={item().failure}
              else={
                <Text class="text-sm leading-[18px] text-muted-foreground">
                  {t("tasks.comment.sending")}
                </Text>
              }
            >
              {(message) => (
                <View class="flex-row items-center gap-3">
                  <Text class="grow basis-0 text-sm leading-[18px] text-state-error">
                    {t("tasks.comment.notDelivered", { message: message() })}
                  </Text>
                  <View
                    role="button"
                    onPress={() => props.comments.retry(item().id)}
                    class="h-8 flex-row items-center active:opacity-60"
                  >
                    <Text class="text-md leading-4 text-foreground">
                      {t("common.retry")}
                    </Text>
                  </View>
                  <View
                    role="button"
                    onPress={() => props.comments.discard(item().id)}
                    class="h-8 flex-row items-center active:opacity-60"
                  >
                    <Text class="text-md leading-4 text-muted-foreground">
                      {t("tasks.comment.discard")}
                    </Text>
                  </View>
                </View>
              )}
            </If>
          </View>
        )}
      </Each>
    </If>
  );
}
