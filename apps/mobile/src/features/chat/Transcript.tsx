import type { AttachmentView, MessageView } from "@eta/client-contracts";
import type { ListRef } from "nsh";
import type { Chat } from "./conversation";
import type { Outgoing } from "./outbox";
import {
  publishedRefs,
  systemNoticeOf,
  withRealmCalls,
} from "@eta/client-contracts";
import { computed, effect, List, signal, Text, untracked, View } from "nsh";
import { t } from "../../i18n";
import { open } from "../../nav/stack";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { clock, reason } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { ArtifactCard, DraftCard, TaskCard } from "./cards";
import { agentName, replyBlocks } from "./conversation";
import { answering, InsertSheet, insertsInto } from "./InsertSheet";
import { discard, edit, outgoing, retry } from "./outbox";
import { ProcessScreen } from "./process";
import { ProcessBox } from "./ProcessBox";
import { rememberRows } from "./rows";

type Item =
  | { key: string; type: "message"; message: MessageView }
  | { key: string; type: "outgoing"; outgoing: Outgoing };

// Failures of the host or the agent's environment, which fail everything waiting at once.
const ENVIRONMENT_FAILURES = new Set(["restart", "unavailable"]);
const FAILURE_KEYS = {
  restart: "chat.failure.restart",
  run_failed: "chat.failure.runFailed",
  unavailable: "chat.failure.unavailable",
  gone: "chat.failure.gone",
} as const;
// Why a reply was stopped without its run, as the host marks it.
const STOP_KEYS = {
  stop_unanswered: "chat.stop.unanswered",
  stop_unreachable: "chat.stop.unreachable",
  link_lost: "chat.stop.linkLost",
  restart: "chat.stop.restart",
} as const;

/** "Stopped", and why when the host stopped it without its run. */
function stoppedWords(data: Readonly<Record<string, unknown>>): string {
  const code = String(data.code ?? "");
  const key = Object.hasOwn(STOP_KEYS, code)
    ? STOP_KEYS[code as keyof typeof STOP_KEYS]
    : undefined;
  const stopped = t("chat.message.stopped");
  return key === undefined
    ? stopped
    : `${stopped} · ${t(key, { error: String(data.stopError ?? "") })}`;
}

/** How long a reply has to be before it folds. */
const LONG_MESSAGE = { chars: 1000, lines: 12 };
/** Twelve lines of 23. */
const FOLDED_HEIGHT = 276;
const isLong = (text: string) =>
  text.split("\n").length > LONG_MESSAGE.lines ||
  [...text].length > LONG_MESSAGE.chars;

const asFiles = (data: Record<string, unknown>): AttachmentView[] =>
  Array.isArray(data.attachments)
    ? (data.attachments as Partial<AttachmentView>[]).filter(
        (file): file is AttachmentView =>
          typeof file?.id === "string" && typeof file.name === "string",
      )
    : [];

/** A user row put into another's turn (`data.into`): drawn inside that message's bubble. */
const intoOf = (row: MessageView): string | undefined =>
  row.author === "user" && typeof row.data.into === "string"
    ? row.data.into
    : undefined;

function Bubble(props: {
  text: string;
  files?: readonly AttachmentView[] | undefined;
  /** Words put into this message's turn, in the order they were sent, under a rule each. */
  inserts?: readonly MessageView[] | undefined;
}) {
  // One selectable block: copying the message copies what was put into it, in order.
  return (
    <View class="max-w-[300px] gap-1 self-end bg-muted px-3 py-2">
      <If when={props.text !== "" || (props.inserts ?? []).length > 0}>
        <View selectable class="gap-1">
          <If when={props.text !== ""}>
            <Text class="text-base leading-[23px] text-foreground">
              {props.text}
            </Text>
          </If>
          <Each of={props.inserts ?? []} key={(row) => row.id}>
            {(row) => (
              <View class="gap-[2px] border-t border-border-strong pt-1.5">
                <Text class="text-xs leading-4 text-faint">
                  {t("chat.insert.mark", { time: clock(row().createdAt) })}
                </Text>
                <Text class="text-base leading-[23px] text-foreground">
                  {row().text}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <Each of={props.files ?? []} key={(file) => file.id}>
        {(file) => (
          <View class="flex-row items-center gap-[6px]">
            <Icon name="paperclip" size={14} color="muted-foreground" />
            <Text class="truncate text-sm leading-[18px] text-muted-foreground">
              {file().name}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

function UserRow(props: {
  message: MessageView;
  chat: Chat;
  onInsert: (message: MessageView) => void;
}) {
  const data = () => props.message.data;
  // Only while a turn this message started is still writing (not once it is being stopped).
  const writing = () => answering(props.chat, props.message).length > 0;
  const inserts = () => insertsInto(props.chat, props.message);
  const nobody = () =>
    Array.isArray(data().woke) &&
    (data().woke as unknown[]).length === 0 &&
    Array.isArray(data().joined) &&
    (data().joined as unknown[]).length === 0;
  const joined = () =>
    Array.isArray(data().joined)
      ? (data().joined as string[]).map(agentName).join("、")
      : "";
  return (
    <View class="gap-[6px]">
      <Bubble
        text={props.message.text}
        files={asFiles(data())}
        inserts={inserts()}
      />
      <If when={writing()}>
        <View
          role="button"
          accessibilityLabel={t("chat.insert.label", {
            text: props.message.text,
          })}
          testID={`insert-${props.message.id}`}
          onPress={() => props.onInsert(props.message)}
          class="h-8 justify-center self-end px-1 active:opacity-60"
        >
          <Text class="text-sm leading-4 text-foreground">
            {t("chat.insert.action")}
          </Text>
        </View>
      </If>
      <If when={nobody()}>
        <Text class="text-sm leading-[18px] text-foreground">
          {t("chat.message.nobody")}
        </Text>
      </If>
      <If when={joined() !== ""}>
        <Text class="self-end text-xs leading-4 text-muted-foreground">
          {t("chat.message.joined", { names: joined() })}
        </Text>
      </If>
    </View>
  );
}

function SmallButton(props: {
  title: string;
  quiet?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      class={`h-9 items-center justify-center px-[14px] active:bg-muted ${props.quiet ? "" : "border border-border-strong"}`}
    >
      <Text
        class={`text-md leading-4 ${props.quiet ? "text-muted-foreground" : "text-foreground"}`}
      >
        {props.title}
      </Text>
    </View>
  );
}

/** A message on its way (03f): Sending…, or why it did not arrive and what to do about it. */
function OutgoingRow(props: { item: Outgoing }) {
  return (
    <View class="gap-[6px]">
      <Bubble text={props.item.text} files={props.item.attachments} />
      <If
        when={props.item.failure !== undefined}
        else={
          <Text class="self-end text-sm leading-[18px] text-muted-foreground">
            {t("chat.message.sending")}
          </Text>
        }
      >
        <View class="gap-2 border border-state-error px-3 py-[10px]">
          <Text class="text-md leading-[20px] text-state-error">
            {props.item.failure}
          </Text>
          <View class="flex-row gap-2">
            <SmallButton
              title={t("common.retry")}
              onPress={() => retry(props.item)}
            />
            <SmallButton
              title={t("chat.message.edit")}
              onPress={() => edit(props.item)}
            />
            <SmallButton
              quiet
              title={t("chat.message.discard")}
              onPress={() => discard(props.item.id)}
            />
          </View>
        </View>
      </If>
    </View>
  );
}

/** A finished reply's answer: read whole if short, folded to twelve lines if not. */
function Answer(props: { id: string; text: string; chat: Chat }) {
  const long = () => isLong(props.text);
  const opened = () => props.chat.folds()[props.id] === true;
  return (
    <View class="gap-1">
      <View
        style={
          long() && !opened()
            ? { maxHeight: FOLDED_HEIGHT, overflow: "hidden" }
            : {}
        }
      >
        <Markdown text={props.text} />
      </View>
      <If when={long()}>
        <View
          role="button"
          onPress={() => props.chat.fold(props.id, !opened())}
          class="h-8 justify-center self-start active:opacity-60"
        >
          <Text class="text-md leading-4 text-foreground">
            {t(opened() ? "chat.message.collapse" : "chat.message.expand")}
          </Text>
        </View>
      </If>
    </View>
  );
}

/** A failed reply (03f): why, in the reader's words, and the way back. */
function FailureBox(props: {
  message: MessageView;
  lines: Lines;
  onResend: (text: string) => void;
}) {
  const code = () => String(props.message.data.code ?? "");
  const line = () => props.lines.get(props.message.id);
  const text = () => {
    if (line()?.sameAsNext) return t("chat.failure.sameAsNext");
    const key = FAILURE_KEYS[code() as keyof typeof FAILURE_KEYS] as
      | (typeof FAILURE_KEYS)[keyof typeof FAILURE_KEYS]
      | undefined;
    const reason = t(key ?? "chat.failure.failed");
    // The host's own words say why a run failed; for a restart they only repeat the reason.
    return code() === "restart" || props.message.text === ""
      ? reason
      : `${reason} ${props.message.text}`;
  };
  return (
    <View class="gap-2 border border-state-error px-3 py-[10px]">
      <Text class="text-md leading-[20px] text-state-error">{text()}</Text>
      <If when={line()?.resend !== undefined}>
        <View class="self-start">
          <SmallButton
            title={t("chat.message.resend")}
            onPress={() => props.onResend(line()?.resend ?? "")}
          />
        </View>
      </If>
    </View>
  );
}

type Lines = ReadonlyMap<string, { sameAsNext: boolean; resend?: string }>;

/** What each failed reply needs from the ones around it. See web's `replyLines`. */
function replyLines(messages: readonly MessageView[]): Lines {
  const replies = messages.filter(
    (row) => row.author === "agent" && row.kind === "message",
  );
  const lines = new Map<string, { sameAsNext: boolean; resend?: string }>();
  replies.forEach((message, index) => {
    if (message.status !== "failed") return;
    const code = String(message.data.code ?? "");
    const next = replies[index + 1];
    const trigger = messages.find(
      (row) => row.id === message.replyToId && row.author === "user",
    );
    lines.set(message.id, {
      sameAsNext:
        ENVIRONMENT_FAILURES.has(code) &&
        next?.agentId === message.agentId &&
        next?.status === "failed" &&
        next.data.code === code,
      ...(trigger === undefined ? {} : { resend: trigger.text }),
    });
  });
  return lines;
}

function Reply(props: {
  message: MessageView;
  chat: Chat;
  lines: Lines;
  onResend: (text: string, agentId: string | null) => void;
}) {
  const chat = props.chat;
  const m = () => props.message;
  // While the run is in flight its blocks are all process, its words too; once it is over the row
  // is a finished reply, whose process is what it kept (`savedSteps`) and whose answer is its text.
  const reply = computed(() => replyBlocks(chat, m()));
  const waiting = () => m().status === "waiting_for_input";
  /** Still writing: its box has its own Stop, which reaches this reply and no other. */
  const writing = () =>
    m().status === "working" ||
    m().status === "waiting_for_input" ||
    m().status === "stopping";
  const stop = () =>
    void call<{ stopped: MessageView[] }>("conversations", "stop", {
      conversationId: chat.id,
      messageId: m().id,
    }).then(
      (result) => rememberRows(chat.id, result.stopped),
      (error: unknown) => toast(t("common.failed", { message: reason(error) })),
    );
  /** Nothing from the run yet: the frame holds the place. */
  const pending = () =>
    reply().live && reply().blocks.length === 0 && !waiting();
  const inBox = () => reply().blocks.length > 0 || pending() || writing();
  const answer = () =>
    !reply().live && m().text !== "" && m().status !== "failed"
      ? m().text
      : undefined;
  // Who said it is worth a line wherever there is more than one voice in the room.
  const author = () =>
    (chat.kind() === "group" && !chat.direct()) ||
    chat.members().length > 1 ||
    m().kind === "mention"
      ? agentName(m().agentId)
      : undefined;
  const under = () => chat.grouped().under.get(m().id) ?? [];
  const artifacts = computed(() =>
    publishedRefs(withRealmCalls(reply().blocks)),
  );
  const viewAll = () => {
    const id = m().id;
    open(`process:${id}`, () => <ProcessScreen chat={chat} messageId={id} />);
  };
  return (
    <View class="gap-[10px]">
      <If when={author() !== undefined}>
        <View class="flex-row items-center gap-2">
          <AgentAvatar id={m().agentId ?? ""} size={20} />
          <Text class="text-sm leading-[18px] text-foreground">{author()}</Text>
        </View>
      </If>
      <If when={inBox()}>
        <ProcessBox
          blocks={reply().blocks}
          waiting={pending()}
          folded={!reply().live}
          onViewAll={viewAll}
          stop={
            writing()
              ? { stopping: m().status === "stopping", onPress: stop }
              : undefined
          }
        />
      </If>
      <If when={answer() !== undefined}>
        <Answer id={`answer:${m().id}`} text={answer() ?? ""} chat={chat} />
      </If>
      <Each of={under()} key={(row) => row.id}>
        {(row) => <TaskRow message={row()} chat={chat} />}
      </Each>
      <Each of={artifacts()} key={(artifact) => artifact.id}>
        {(artifact) => <ArtifactCard artifact={artifact()} />}
      </Each>
      <If when={m().status === "stopped"}>
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {stoppedWords(m().data)}
        </Text>
      </If>
      <If when={m().status === "failed"}>
        <FailureBox
          message={m()}
          lines={props.lines}
          onResend={(text) => props.onResend(text, m().agentId)}
        />
      </If>
    </View>
  );
}

function TaskRow(props: { message: MessageView; chat: Chat }) {
  return (
    <If
      when={props.message.kind === "task_draft"}
      else={<TaskCard message={props.message} />}
    >
      <DraftCard message={props.message} chat={props.chat} />
    </If>
  );
}

/** A system row: the host writes English for its agents, the page says the event in the reader's language. */
function systemText(message: MessageView): string {
  const notice = systemNoticeOf(message);
  switch (notice.kind) {
    case "stewardChanged":
      return t("chat.system.stewardChanged", {
        to: agentName(notice.to),
        from: agentName(notice.from),
      });
    case "stewardSet":
      return t("chat.system.stewardSet", { to: agentName(notice.to) });
    case "stewardCleared":
      return t("chat.system.stewardCleared", { from: agentName(notice.from) });
    case "stewardLeft":
      return t("chat.system.stewardLeft", { from: agentName(notice.from) });
    case "wakeBudget":
      return t("chat.system.wakeBudget", { budget: notice.budget });
    case "createdByCaptain":
      return t("chat.system.createdByCaptain");
    case "routineReport":
      return notice.title === null
        ? t("chat.system.routineReportUntitled", { name: notice.name })
        : t("chat.system.routineReport", {
            name: notice.name,
            title: notice.title,
          });
    case "text":
      return notice.text;
  }
}

/**
 * A message the host wrote: Captain's review prompt, which the phone names in one line instead of
 * printing the English it gives Captain. (The group proposal outcome never gets here: see
 * `taskRowsByTurn`.)
 */
function hostMessageText(message: MessageView): string {
  const marked = message.data.captainReview as
    | { reviewIds?: unknown }
    | null
    | undefined;
  if (Array.isArray(marked?.reviewIds))
    return t("chat.system.captainReview", { count: marked.reviewIds.length });
  // A review written before the host marked it.
  if (message.text.startsWith("<captain-review>"))
    return t("chat.system.captainReview", {
      count: message.text.match(/^\d+\. \[/gm)?.length ?? 0,
    });
  return message.text;
}

function MessageRow(props: {
  message: MessageView;
  chat: Chat;
  lines: Lines;
  onResend: (text: string, agentId: string | null) => void;
  onInsert: (message: MessageView) => void;
}) {
  const kind = () => props.message.kind;
  return (
    <>
      <If when={kind() === "system"}>
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {systemText(props.message)}
        </Text>
      </If>
      <If when={kind() === "task_draft" || kind() === "task_card"}>
        <TaskRow message={props.message} chat={props.chat} />
      </If>
      <If when={kind() === "message" || kind() === "mention"}>
        <If
          when={props.message.author === "system"}
          else={
            <If
              when={props.message.author === "user"}
              else={
                <Reply
                  message={props.message}
                  chat={props.chat}
                  lines={props.lines}
                  onResend={props.onResend}
                />
              }
            >
              <UserRow
                message={props.message}
                chat={props.chat}
                onInsert={props.onInsert}
              />
            </If>
          }
        >
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {hostMessageText(props.message)}
          </Text>
        </If>
      </If>
    </>
  );
}

/** 03g: the outline of the turns, where they will land. */
function Skeleton() {
  return (
    <View class="shrink-0 gap-3 p-4">
      <View class="h-11 w-[220px] self-end bg-muted" />
      <View class="h-3 w-[80px] bg-muted" />
      <View class="h-3 w-[340px] max-w-full bg-muted" />
      <View class="h-3 w-[280px] max-w-full bg-muted" />
      <Text class="text-sm leading-[18px] text-muted-foreground">
        {t("chat.history.loading")}
      </Text>
    </View>
  );
}

export interface TranscriptHandle {
  toBottom: () => void;
}

/** The conversation, newest at the bottom, as a list that keeps its place while it grows. */
export function Transcript(props: {
  chat: Chat;
  onResend: (text: string, agentId: string | null) => void;
  /** Hands the screen the way back to the live end. */
  handle: (handle: TranscriptHandle) => void;
}) {
  const chat = props.chat;
  let list: ListRef | undefined;
  /** Whether the newest row is off screen: the reader has gone up. */
  const away = signal(false);
  const toBottom = () => {
    away.set(false);
    list?.scrollToIndex({ index: 0, animated: true });
  };
  props.handle({ toBottom });

  const lines = computed(() => replyLines(chat.messages()));
  /** The message an insert is being written for: the sheet is open while there is one. */
  const inserting = signal<string | undefined>(undefined);
  const insertInto = computed(() =>
    chat.messages().find((row) => row.id === inserting()),
  );
  const mine = computed(() =>
    outgoing().filter((item) => item.conversationId === chat.id),
  );
  // A message the timeline already has: its reply was lost, the push brought it.
  effect(() => {
    const arrived = new Set(chat.messages().map((row) => row.id));
    for (const item of mine())
      if (arrived.has(item.id)) untracked(() => discard(item.id));
  });
  const items = computed((): Item[] => {
    const arrived = new Set(chat.messages().map((row) => row.id));
    // An insert is drawn in the bubble of the message it went into, when that message is here.
    const folded = (row: MessageView) => {
      const into = intoOf(row);
      return into !== undefined && arrived.has(into);
    };
    return [
      ...mine()
        .filter((item) => !arrived.has(item.id))
        .reverse()
        .map(
          (item): Item => ({
            key: item.id,
            type: "outgoing",
            outgoing: item,
          }),
        ),
      ...chat
        .grouped()
        .rows.filter(
          (row) =>
            !(row.author === "agent" && row.status === "queued") &&
            !folded(row),
        )
        .toReversed()
        .map((row): Item => ({ key: row.id, type: "message", message: row })),
    ];
  });
  const busy = () =>
    chat
      .members()
      .filter((member) => member.status !== "idle")
      .map((member) => agentName(member.agentId))
      .join("、");

  return (
    <View class="relative min-h-0 grow basis-0">
      <If when={chat.missing()}>
        <View class="grow basis-0 justify-end p-4">
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {t("chat.history.gone")}
          </Text>
        </View>
      </If>
      <If when={!chat.missing() && !chat.loaded() && items().length === 0}>
        <View class="grow basis-0 justify-end">
          <Skeleton />
        </View>
      </If>
      <If when={chat.loaded() && !chat.missing() && items().length === 0}>
        <View class="grow basis-0 justify-end px-4 py-3">
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {t("chat.history.empty")}
          </Text>
        </View>
      </If>
      <If when={items().length > 0}>
        <List
          ref={(node) => {
            list = node;
          }}
          testID="transcript"
          each={items()}
          inverted
          estimatedItemSize={120}
          style={{ flex: 1 }}
          contentClass="gap-[20px] px-4 pt-4 pb-3"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onLoadMore={chat.loadOlder}
          loadMoreThreshold={0.5}
          onViewableItemsChange={({ viewableItems }) => {
            const first = items()[0]?.key;
            away.set(
              first !== undefined &&
                !viewableItems.some((token) => token.key === first),
            );
          }}
          footer={() => (
            <>
              <If when={chat.olderError() !== undefined}>
                <View class="gap-2 border border-state-error px-3 py-[10px]">
                  <Text class="text-md leading-[20px] text-state-error">
                    {t("chat.history.failed", {
                      message: chat.olderError() ?? "",
                    })}
                  </Text>
                  <View class="self-start">
                    <SmallButton
                      title={t("common.retry")}
                      onPress={chat.loadOlder}
                    />
                  </View>
                </View>
              </If>
              <If when={chat.olderError() === undefined && chat.hasOlder()}>
                <Text class="py-2 text-center text-sm leading-[18px] text-muted-foreground">
                  {t("chat.history.earlier")}
                </Text>
              </If>
            </>
          )}
        >
          {(item) => {
            const message = () => {
              const value = item();
              return value.type === "message" ? value.message : undefined;
            };
            const sending = () => {
              const value = item();
              return value.type === "outgoing" ? value.outgoing : undefined;
            };
            return (
              <View>
                <If when={message()}>
                  {(row) => (
                    <MessageRow
                      message={row()}
                      chat={chat}
                      lines={lines()}
                      onResend={props.onResend}
                      onInsert={(target) => inserting.set(target.id)}
                    />
                  )}
                </If>
                <If when={sending()}>
                  {(row) => <OutgoingRow item={row()} />}
                </If>
              </View>
            );
          }}
        </List>
      </If>
      <If when={away()}>
        <View class="absolute bottom-2 left-0 right-0 items-center">
          <View
            role="button"
            accessibilityLabel={t("chat.toBottom")}
            onPress={toBottom}
            class="h-9 flex-row items-center gap-[6px] border border-border-strong bg-background px-3 active:bg-muted"
          >
            <Icon name="arrowDown" size={14} />
            <Text class="text-md leading-4 text-foreground">
              {busy() === ""
                ? t("chat.toBottom")
                : t("chat.toBottomWho", { names: busy() })}
            </Text>
          </View>
        </View>
      </If>
      <InsertSheet
        chat={chat}
        message={insertInto()}
        onClose={() => inserting.set(undefined)}
        onSent={() => toBottom()}
      />
    </View>
  );
}
