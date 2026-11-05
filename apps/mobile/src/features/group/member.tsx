import type { TranscriptSection } from "@eta/client-contracts";
// 03k 成员详情: one member's numbers and what can be done about it, and 只看, its side of the group.

import type {
  ConversationResults,
  MemberView,
  MessageView,
  StoredTask,
  TaskStatus,
  TimelineSection,
} from "@eta/client-contracts";
import { computed, signal, Text, View } from "nsh";
import { agentById } from "../../app/lists";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { nav, open } from "../../nav/stack";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Button } from "../../ui/Button";
import { Markdown } from "../../ui/Markdown";
import { Body, Header, Page } from "../../ui/Page";
import { Sheet } from "../../ui/Sheet";
import { Empty, Loading } from "../../ui/States";
import { moment } from "../../ui/format";
import { call, useTarget } from "../../wire/target";
import {
  act,
  agentName,
  modelName,
  SheetRow,
  statusLabel,
  tokens,
  useSession,
} from "./shared";

/** A reply a stop can still reach. */
const IN_FLIGHT = new Set<MessageView["status"]>([
  "queued",
  "working",
  "waiting_for_input",
]);

const MARK: Record<TaskStatus, string> = {
  pending: "·",
  in_progress: "▸",
  completed: "✓",
  cancelled: "×",
};
const ORDER: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

/** A press moves a step on, as on the web. */
const next = (status: TaskStatus): TaskStatus =>
  ORDER[(ORDER.indexOf(status) + 1) % ORDER.length] as TaskStatus;

function Steps(props: { session: string; tasks: StoredTask[] }) {
  const done = () =>
    props.tasks.filter((task) => task.status === "completed").length;
  return (
    <View class="gap-1 border-t border-border px-4 py-3">
      <Text class="text-sm leading-[18px] text-muted-foreground">
        {t("group.member.steps", { done: done(), total: props.tasks.length })}
      </Text>
      <Each of={props.tasks} key={(task) => task.id}>
        {(task) => (
          <View
            role="button"
            accessibilityLabel={task().content}
            onPress={() =>
              act(
                call("sessions", "taskUpdate", {
                  session: props.session,
                  id: task().id,
                  status: next(task().status),
                }),
              )
            }
            class="flex-row items-center gap-2 active:opacity-60"
          >
            <Text class="w-3 text-md leading-[18px] text-muted-foreground">
              {MARK[task().status]}
            </Text>
            <Text class="truncate grow basis-0 text-md leading-[18px] text-foreground">
              {task().content}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** What the sheet says about a member. */
function MemberBody(props: {
  conversationId: string;
  member: MemberView;
  steward: boolean;
  removable: boolean;
  messages: MessageView[];
  onClose: () => void;
  onRemove: () => void;
}) {
  const id = () => props.member.agentId;
  const name = () => agentName(id());
  const session = useSession(() => props.member.sessionId);
  const known = () => agentById(id()) !== undefined;
  const reply = () =>
    props.messages.findLast(
      (message) => message.agentId === id() && IN_FLIGHT.has(message.status),
    );
  const status = () =>
    props.steward
      ? `${t("group.steward")} · ${statusLabel(props.member.status)}`
      : statusLabel(props.member.status);
  const rate = () =>
    Math.round((session()?.metrics?.tokensPerSec ?? 0) * 10) / 10;
  const cache = () => {
    const usage = session()?.usage;
    return usage === undefined ? undefined : usage.cacheRead + usage.cacheWrite;
  };
  const model = () => {
    const current = session()?.model?.id;
    return current === undefined ? "—" : modelName(current);
  };
  const leave = (then: () => void) => {
    props.onClose();
    then();
  };
  return (
    <View>
      <View class="flex-row items-center gap-3 p-4">
        <AgentAvatar id={id()} size={40} />
        <View class="min-w-0 grow basis-0">
          <Text class="truncate text-[17px] leading-5 text-foreground">
            {name()}
          </Text>
          <Text class="truncate text-md leading-[18px] text-muted-foreground">
            {status()}
          </Text>
        </View>
        <If when={reply() !== undefined}>
          <Button
            title={t("group.member.stop")}
            grow={false}
            height={36}
            onPress={() =>
              act(
                call("conversations", "stop", {
                  conversationId: props.conversationId,
                  messageId: reply()?.id,
                }),
              )
            }
          />
        </If>
      </View>
      <If
        when={props.member.sessionId !== null}
        else={
          <View class="border-t border-border px-4 py-3">
            <Text class="text-sm leading-[18px] text-muted-foreground">
              {t("group.member.noSession")}
            </Text>
          </View>
        }
      >
        <View class="gap-1 border-t border-border px-4 py-3">
          <Text class="text-md leading-[18px] text-foreground">{model()}</Text>
          <View class="flex-row items-center gap-2">
            <Text class="truncate grow basis-0 text-sm leading-[18px] text-muted-foreground">
              {`in ${tokens(session()?.usage?.input)} · out ${tokens(session()?.usage?.output)} · cache ${tokens(cache())}`}
            </Text>
            <If when={rate() !== 0}>
              <Text class="text-sm leading-[18px] text-state-success">{`${rate()} tok/s`}</Text>
            </If>
          </View>
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {[
              ...activity(session()?.transcript),
              `tools ${session()?.tools?.length ?? "—"}`,
            ].join(" · ")}
          </Text>
        </View>
        <If when={(session()?.tasks?.length ?? 0) > 0}>
          <Steps
            session={props.member.sessionId as string}
            tasks={session()?.tasks ?? []}
          />
        </If>
      </If>
      <If when={known()}>
        <SheetRow
          title={t("group.member.talkAlone", { name: name() })}
          onPress={() =>
            act(
              call<{ conversation: { id: string } }>("agents", "direct", {
                agentId: id(),
              }),
              (result) => leave(() => go.chat(result.conversation.id)),
            )
          }
        />
      </If>
      <SheetRow
        title={t("group.member.only", { name: name() })}
        onPress={() => {
          const agentId = id();
          const conversationId = props.conversationId;
          leave(() =>
            open(`member-only:${conversationId}:${agentId}`, () => (
              <MemberOnlyScreen
                conversationId={conversationId}
                agentId={agentId}
              />
            )),
          );
        }}
      />
      <If when={known()}>
        <SheetRow
          title={t("group.member.basics")}
          onPress={() => {
            const agentId = id();
            leave(() => go.agentInfo(agentId));
          }}
        />
      </If>
      <If when={props.removable}>
        <SheetRow
          title={t("group.member.remove")}
          danger
          onPress={props.onRemove}
        />
      </If>
    </View>
  );
}

/**
 * 回合 and 被拦, counted from the transcript the view holds. Older rows may lie outside its window;
 * then the count is a floor, and says so with a `+`.
 */
function activity(transcript: TranscriptSection | undefined): string[] {
  if (transcript === undefined) return [];
  const more = (transcript.messagesBefore ?? 0) > 0 ? "+" : "";
  const roles = transcript.messages.map((row) => row.message);
  const turns = roles.filter((message) => message.role === "user").length;
  const blocked = roles.filter(
    (message) =>
      message.role === "toolResult" &&
      message.isError &&
      JSON.stringify(message.content).includes("blocked by "),
  ).length;
  return [
    ...(turns === 0
      ? []
      : [t("group.member.turns", { count: `${turns}${more}` })]),
    ...(blocked === 0
      ? []
      : [t("group.member.blocked", { count: `${blocked}${more}` })]),
  ];
}

export function MemberSheet(props: {
  conversationId: string;
  agentId: string | undefined;
  member: MemberView | undefined;
  steward: boolean;
  removable: boolean;
  messages: MessageView[];
  onClose: () => void;
}) {
  // The question replaces the sheet's content: two dialogs swapping is a race on every platform.
  const removing = signal(false);
  const close = () => {
    removing.set(false);
    props.onClose();
  };
  const remove = (agentId: string) => {
    close();
    act(
      call("conversations", "remove", {
        conversationId: props.conversationId,
        agentId,
      }),
    );
  };
  return (
    <Sheet
      open={props.member !== undefined}
      onClose={close}
      testID="member-sheet"
    >
      <If when={props.member}>
        {(member) => (
          <If
            when={removing()}
            else={
              <MemberBody
                conversationId={props.conversationId}
                member={member()}
                steward={props.steward}
                removable={props.removable}
                messages={props.messages}
                onClose={close}
                onRemove={() => removing.set(true)}
              />
            }
          >
            <View class="gap-[6px] px-4 pt-[20px] pb-4">
              <Text class="text-title leading-[30px] tracking-[-0.01em] text-foreground">
                {t("group.member.removeTitle", {
                  name: agentName(member().agentId),
                })}
              </Text>
              <Text class="text-base leading-[23px] text-muted-foreground">
                {t("group.member.removeBody")}
              </Text>
            </View>
            <View class="flex-row gap-2 px-4 pb-2">
              <Button
                title={t("common.cancel")}
                height={44}
                onPress={() => removing.set(false)}
              />
              <Button
                title={t("group.member.remove")}
                height={44}
                variant="danger"
                onPress={() => remove(member().agentId)}
              />
            </View>
          </If>
        )}
      </If>
    </Sheet>
  );
}

/** 只看: one member's rows of the conversation, newest first. The web has no such view; it reads the same timeline. */
function MemberOnlyScreen(props: {
  conversationId: string;
  agentId: string;
}) {
  const target = useTarget(`conversations.${props.conversationId}`);
  const timeline = () => target.section<TimelineSection>("timeline");
  const older = signal<MessageView[]>([]);
  const noMore = signal(false);
  const rows = computed(() =>
    [...older(), ...(timeline()?.messages ?? [])]
      .filter(
        (message) => message.agentId === props.agentId && message.text !== "",
      )
      .reverse(),
  );
  const canPage = () => (timeline()?.hasMore ?? false) && !noMore();
  const earlier = () => {
    const first = older()[0] ?? timeline()?.messages[0];
    act(
      call<ConversationResults["history"]>("conversations", "history", {
        conversationId: props.conversationId,
        beforeSeq: first?.seq,
      }),
      (page) => {
        older.set([...page.messages, ...older()]);
        noMore.set(!page.hasMore);
      },
    );
  };
  return (
    <Page>
      <Header
        title={t("group.member.only", { name: agentName(props.agentId) })}
        onBack={() => nav.pop()}
      />
      <If when={target.loaded()} else={<Loading />}>
        <Body>
          <If when={rows().length === 0 && !canPage()}>
            <Empty title={t("group.only.empty")} />
          </If>
          <Each of={rows()} key={(message) => message.id}>
            {(message) => (
              <View class="shrink-0 gap-1 border-b border-border px-4 py-3">
                <Text class="text-sm leading-4 text-muted-foreground">
                  {moment(message().createdAt)}
                </Text>
                <Markdown text={message().text} />
              </View>
            )}
          </Each>
          <If when={canPage()}>
            <View class="p-4">
              <Button title={t("group.only.earlier")} onPress={earlier} />
            </View>
          </If>
        </Body>
      </If>
    </Page>
  );
}
