import type { AttachmentView, MessageView } from "@eta/client-contracts";
import type { ListRef } from "nsh";
import type { Chat } from "./conversation";
import type { Outgoing } from "./outbox";
import type { RunBlock, ToolBlock } from "./run";
import { computed, effect, List, signal, Text, untracked, View } from "nsh";
import { t } from "../../i18n";
import { open } from "../../nav/stack";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { ArtifactCard, DraftCard, TaskCard } from "./cards";
import { agentName, replyBlocks } from "./conversation";
import { discard, edit, outgoing, retry } from "./outbox";
import { ProcessScreen } from "./process";
import { ProcessBox, ThinkingRow, ToolRow } from "./ProcessBox";
import { publishedRefs } from "./run";
import { ToolScreen } from "./ToolScreen";

type Item =
  | { key: string; type: "message"; message: MessageView }
  | { key: string; type: "outgoing"; outgoing: Outgoing };

type StepBlock = Exclude<RunBlock, { type: "text" }>;

// Failures of the host or the agent's environment, which fail everything waiting at once.
const ENVIRONMENT_FAILURES = new Set(["restart", "unavailable"]);
const FAILURE_KEYS = {
  restart: "chat.failure.restart",
  run_failed: "chat.failure.runFailed",
  unavailable: "chat.failure.unavailable",
  gone: "chat.failure.gone",
} as const;

/** How long a reply has to be before it folds, as the web's `LONG_MESSAGE`. */
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

function Bubble(props: {
  text: string;
  files?: readonly AttachmentView[] | undefined;
}) {
  return (
    <View class="max-w-[300px] gap-1 self-end bg-muted px-3 py-2">
      <If when={props.text !== ""}>
        <View selectable>
          <Text class="text-base leading-[23px] text-foreground">
            {props.text}
          </Text>
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

function UserRow(props: { message: MessageView }) {
  const data = () => props.message.data;
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
      <Bubble text={props.message.text} files={asFiles(data())} />
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

/** An answer: read whole if short, folded to twelve lines if not. A reply still writing is unfolded. */
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
  const reply = computed(() => replyBlocks(chat, m()));
  const steps = computed(() =>
    reply().blocks.filter((block): block is StepBlock => block.type !== "text"),
  );
  const firstStep = () =>
    reply().blocks.findIndex((block) => block.type !== "text");
  const wordsBefore = computed(() =>
    reply().live && firstStep() > 0
      ? reply().blocks.slice(0, firstStep()).filter(isText)
      : [],
  );
  const wordsAfter = computed(() =>
    reply().live
      ? reply().blocks.slice(Math.max(firstStep(), 0)).filter(isText)
      : [],
  );
  const waiting = () => m().status === "waiting_for_input";
  /** Nothing from the run yet: the frame holds the place. */
  const pending = () =>
    reply().live && reply().blocks.length === 0 && !waiting();
  const answer = () =>
    !reply().live && m().text !== "" && m().status !== "failed"
      ? m().text
      : undefined;
  const boxed = () => chat.kind() === "group";
  const author = () =>
    chat.kind() === "group" ||
    chat.members().length > 1 ||
    m().kind === "mention"
      ? agentName(m().agentId)
      : undefined;
  const under = () => chat.grouped().under.get(m().id) ?? [];
  const artifacts = computed(() => publishedRefs(reply().blocks));
  const viewAll = () => {
    const id = m().id;
    open(`process:${id}`, () => <ProcessScreen chat={chat} messageId={id} />);
  };
  const openTool = (block: ToolBlock) => {
    const id = m().id;
    const lookup = () =>
      replyBlocks(
        chat,
        chat.messages().find((row) => row.id === id) ?? m(),
      ).blocks.find(
        (other): other is ToolBlock =>
          other.type === "tool" && other.id === block.id,
      );
    open(`tool:${block.id}`, () => (
      <ToolScreen
        block={block}
        lookup={lookup}
        sessionId={chat.sessionOf(m().agentId)}
      />
    ));
  };
  return (
    <View class="gap-[10px]">
      <If when={author() !== undefined}>
        <View class="flex-row items-center gap-2">
          <AgentAvatar id={m().agentId ?? ""} size={20} />
          <Text class="text-sm leading-[18px] text-foreground">{author()}</Text>
        </View>
      </If>
      <Each of={wordsBefore()} key={(block) => block.id}>
        {(block) => <Markdown text={block().text} streaming />}
      </Each>
      <If when={boxed() && (steps().length > 0 || pending())}>
        <ProcessBox
          steps={steps()}
          waiting={pending()}
          folded={
            !reply().live ||
            (!waiting() && reply().blocks.at(-1)?.type === "text")
          }
          onViewAll={viewAll}
        />
      </If>
      <If when={!boxed()}>
        <If when={pending()}>
          <View class="h-9 shrink-0 flex-row items-center gap-3 border border-border px-[10px]">
            <Text class="text-sm leading-4 text-muted-foreground">
              {t("chat.thinking.now")}
            </Text>
            <View class="h-2 grow basis-0 bg-muted" />
          </View>
        </If>
        <Each of={steps()} key={(block) => block.id}>
          {(block) => (
            <>
              <If when={block().type === "thinking"}>
                <ThinkingRow
                  text={(block() as { text?: string }).text ?? ""}
                  open={chat.folds()[block().id] === true}
                  onToggle={() =>
                    chat.fold(block().id, chat.folds()[block().id] !== true)
                  }
                />
              </If>
              <If when={block().type === "tool"}>
                <ToolRow
                  block={block() as ToolBlock}
                  onPress={() => openTool(block() as ToolBlock)}
                />
              </If>
            </>
          )}
        </Each>
      </If>
      <Each of={wordsAfter()} key={(block) => block.id}>
        {(block) => <Markdown text={block().text} streaming />}
      </Each>
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
          {t("chat.message.stopped")}
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

const isText = (
  block: RunBlock,
): block is Extract<RunBlock, { type: "text" }> => block.type === "text";

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
  const { event, from, to, budget } = message.data as {
    event?: string;
    from?: string | null;
    to?: string | null;
    budget?: number;
  };
  if (event === "steward") {
    if (typeof to === "string" && typeof from === "string")
      return t("chat.system.stewardChanged", {
        to: agentName(to),
        from: agentName(from),
      });
    if (typeof to === "string")
      return t("chat.system.stewardSet", { to: agentName(to) });
    if (typeof from === "string")
      return t("chat.system.stewardCleared", { from: agentName(from) });
  }
  if (event === "wake_budget" && typeof budget === "number")
    return t("chat.system.wakeBudget", { budget });
  return message.text;
}

function MessageRow(props: {
  message: MessageView;
  chat: Chat;
  lines: Lines;
  onResend: (text: string, agentId: string | null) => void;
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
          <UserRow message={props.message} />
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
    return [
      ...mine()
        .filter((item) => !arrived.has(item.id))
        .reverse()
        .map(
          (item): Item => ({ key: item.id, type: "outgoing", outgoing: item }),
        ),
      ...chat
        .grouped()
        .rows.filter(
          (row) => !(row.author === "agent" && row.status === "queued"),
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
    </View>
  );
}
