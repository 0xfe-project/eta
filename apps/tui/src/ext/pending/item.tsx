/**
 * One waiting item, handled where the user is: a question answered, a task accepted or commented
 * on. The same content serves a layer of its own (from the panel or `/tasks`) and review mode.
 */
import type {
  BoardTaskDetail,
  BoardTaskView,
  InboxResponse,
  InteractionView,
  TaskActivityView,
} from "@eta/client-contracts";
import type { WireState } from "../../connection/types";
import type { PendingMessageKey } from "./messages";
import type { ItemFacts, ItemRef } from "./model";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { formatKeyBinding } from "../../config/keys";
import {
  useAction,
  useConfig,
  useInputActive,
  useShell,
  useTheme,
} from "../../extensions/react";
import { translatorFor } from "../../i18n/messages";
import { useMessages } from "../../i18n/react";
import { LayerCursorBox } from "../../ui/components/layer-cursor-box";
import { LayerFrame } from "../../ui/components/layer-frame";
import { gateAllows, useActionGate } from "../../ui/components/layer-space";
import { LineInput } from "../../ui/components/line-input";
import { inkColor } from "../../ui/theme";
import { callsFor, showItem, startCall } from "./calls";
import { usePanelState, useTaskTarget } from "./hooks";
import { statusText } from "./labels";
import { pendingMessages } from "./messages";
import {
  agentName,
  inboxList,
  isWaitingTask,
  itemConversationId,
  keyOf,
  lastComment,
  questionTitle,
  taskDetail,
  taskList,
} from "./model";

const QUESTION_LINES = 12;
const DESCRIPTION_LINES = 8;
const COMMENT_LINES = 4;
const ID_PREFIX = 8;

/**
 * `pending`: the item is handled while it waits, and closes when it stops waiting elsewhere.
 * `read`: any task, whatever its status, to read and comment on.
 */
export type ItemMode = "pending" | "read";

type Row =
  | { kind: "option"; index: number; label: string }
  | { kind: "text"; label: string | undefined; send: "freeform" | "comment" }
  | { kind: "accept" }
  | { kind: "decline" };

/** What is known of the item now, or what was last known of it once it went. */
type Facts = ItemFacts;

const lines = (text: string) => text.split(/\r?\n/);

function questionRows(interaction: InteractionView): Row[] {
  const answers: Row[] =
    interaction.options.length > 0
      ? interaction.options.map((label, index) => ({
          kind: "option",
          index,
          label,
        }))
      : [{ kind: "text", label: undefined, send: "freeform" }];
  return [...answers, { kind: "decline" }];
}

function taskRows(task: BoardTaskView, mode: ItemMode): Row[] {
  if (mode === "pending" && task.status === "in_review")
    return [
      { kind: "accept" },
      { kind: "text", label: "comment", send: "comment" },
    ];
  if (mode === "pending" && task.status === "blocked")
    return [{ kind: "text", label: "reply", send: "comment" }];
  return [{ kind: "text", label: "comment", send: "comment" }];
}

/** The item as the lists have it now; undefined once it no longer counts for `mode`. */
function liveFacts(
  state: Pick<WireState, "targets">,
  ref: ItemRef,
  mode: ItemMode,
): Facts | undefined {
  if (ref.kind === "question") {
    const interaction = inboxList(state).find((i) => i.id === ref.id);
    return interaction?.status === "pending"
      ? { kind: "question", interaction }
      : undefined;
  }
  const task = taskList(state).find((t) => t.id === ref.id);
  if (task === undefined) return undefined;
  if (mode === "pending" && !isWaitingTask(task)) return undefined;
  return { kind: "task", task };
}

export interface ItemContentProps {
  item: ItemRef;
  mode: ItemMode;
  /** The layer's title instead of the item's, which then heads the content. */
  frameTitle?: string;
  /** The item was handled, here or elsewhere: close it or go on to the next. */
  onFinished: () => void;
  /** Esc. */
  onLeave: () => void;
  /** Go to the conversation, closing whatever layers belong with this item. */
  onOpenConversation: (conversationId: string) => void;
  /** Tab, in review mode. */
  onSkip?: () => void;
}

/** One item's title, body, lines to act on, and footer, in a layer frame. */
export function ItemContent({
  item,
  mode,
  frameTitle,
  onFinished,
  onLeave,
  onOpenConversation,
  onSkip,
}: ItemContentProps) {
  const ctx = useShell();
  const { wire } = ctx;
  const t = useMessages(pendingMessages);
  const theme = useTheme();
  const { keybindings } = useConfig();
  const active = useInputActive();
  const state = usePanelState();
  const key = keyOf(item);

  const live = liveFacts(state, item, mode);
  const lastSeenRef = useRef<Facts | undefined>(live);
  if (live !== undefined) lastSeenRef.current = live;
  const facts = live ?? lastSeenRef.current;

  const taskTarget = useTaskTarget(item.kind === "task" ? item.id : "");
  useEffect(() => {
    if (item.kind !== "task") return undefined;
    return wire.subscribe(`tasks.${item.id}`);
  }, [wire, item.kind, item.id]);
  const detail =
    item.kind === "task" ? taskDetail(taskTarget, item.id) : undefined;

  const calls = callsFor(wire);
  const sending = useStore(calls, (s) => s.sending[key] === true);
  const ours = useStore(calls, (s) => s.ours[key] === true);
  const landed = useStore(calls, (s) => s.landed[key] ?? 0);
  const failure = useStore(calls, (s) => s.errors[key]);
  const [landedBefore] = useState(landed);
  const [failuresBefore] = useState(() => calls.getState().failures);
  // A failure belongs to the layer it came to: one from before this layer opened is not shown.
  const error =
    failure !== undefined && failure.number > failuresBefore
      ? failure.message
      : undefined;
  const [cursor, setCursor] = useState(0);
  const gate = useActionGate();
  const [checked, setChecked] = useState<ReadonlySet<number>>(() => new Set());
  const [text, setText] = useState("");
  const finishedRef = useRef(false);

  useEffect(() => showItem(calls, key), [calls, key]);

  const finish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinished();
  };

  // A call for this item landed, from this layer or one open before it.
  useEffect(() => {
    if (landed > landedBefore) finish();
  });

  // Gone from what waits with no call of ours on its way, and not taken out by one that landed:
  // someone else handled it.
  const gone = live === undefined;
  useEffect(() => {
    if (!gone || sending || finishedRef.current) return;
    if (!ours) ctx.notify(t("handledElsewhere"), "info");
    finish();
  });

  const rows =
    facts === undefined
      ? []
      : facts.kind === "question"
        ? questionRows(facts.interaction)
        : taskRows(facts.task, mode);
  const row = rows[Math.min(cursor, rows.length - 1)];
  const multi = facts?.kind === "question" && facts.interaction.multi;

  const conversationId =
    facts === undefined ? undefined : itemConversationId(facts, detail?.task);
  const conversationKey = keybindings["pending.openConversation"][0];
  const conversationKeyName =
    conversationId !== undefined && conversationKey !== undefined
      ? formatKeyBinding(conversationKey)
      : undefined;

  useAction(
    "pending.openConversation",
    () => {
      if (conversationId !== undefined) onOpenConversation(conversationId);
    },
    { isActive: conversationId !== undefined },
  );

  const send = (
    op: string,
    args: unknown,
    leaves: boolean,
    onLanded: (result: unknown) => void = () => {},
  ) => {
    if (calls.getState().sending[key]) return;
    if (!wire.can(op)) {
      ctx.notify(
        translatorFor(pendingMessages, ctx.locale)("tooOld", { ops: op }),
        "error",
      );
      return;
    }
    const [target, action] = splitOp(op);
    // The call may settle after this layer closed: what it says goes through the shell's
    // context and this connection's wire, never through this component.
    startCall({
      wire,
      key,
      target,
      action,
      args,
      leaves,
      onLanded,
      onFailed: (message, shown) => {
        if (shown) return;
        const goneNow =
          liveFacts(wire.store.getState(), item, mode) === undefined;
        ctx.notify(
          goneNow ? t("handledElsewhere") : message,
          goneNow ? "info" : "error",
        );
      },
    });
  };

  const answer = (response: InboxResponse) =>
    send("inbox.answer", { id: item.id, response }, true, (result) => {
      const reply = result as
        | { answered?: boolean; interaction?: { status?: string } }
        | undefined;
      if (reply?.answered !== false) return;
      ctx.notify(
        t(
          reply.interaction?.status === "expired"
            ? "expired"
            : "alreadyAnswered",
        ),
        "info",
      );
    });

  const act = () => {
    if (row === undefined || facts === undefined) return;
    switch (row.kind) {
      case "option": {
        if (facts.kind !== "question") return;
        const options = facts.interaction.options;
        if (!multi) {
          answer({ kind: "selection", selections: [row.label] });
          return;
        }
        const selections = options.filter((_, index) => checked.has(index));
        if (selections.length > 0) answer({ kind: "selection", selections });
        return;
      }
      case "decline":
        answer({ kind: "none" });
        return;
      case "accept":
        send("tasks.update", { taskId: item.id, status: "done" }, true);
        return;
      case "text": {
        const typed = text.trim();
        if (typed === "") return;
        if (row.send === "freeform") answer({ kind: "freeform", text: typed });
        else send("tasks.comment", { taskId: item.id, body: typed }, false);
      }
    }
  };

  useInput(
    (input, inputKey) => {
      if (inputKey.escape) onLeave();
      else if (inputKey.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (inputKey.downArrow)
        setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (inputKey.return) {
        if (gateAllows(gate)) act();
      } else if (inputKey.tab && !sending) onSkip?.();
      else if (
        input === " " &&
        multi &&
        row?.kind === "option" &&
        gateAllows(gate)
      )
        setChecked((current) => {
          const next = new Set(current);
          if (next.has(row.index)) next.delete(row.index);
          else next.add(row.index);
          return next;
        });
    },
    { isActive: active },
  );

  if (facts === undefined) return null;

  const title = itemTitle(state, facts, t);
  const footer = [
    t("keyMove"),
    t(facts.kind === "question" ? "keyAnswer" : "keyChoose"),
    ...(multi ? [t("keyCheck")] : []),
    ...(conversationKeyName === undefined
      ? []
      : [t("keyConversation", { key: conversationKeyName })]),
    ...(onSkip === undefined ? [] : [t("keySkip")]),
    t(onSkip === undefined ? "keyClose" : "keyLeaveReview"),
  ].join(t("footerSeparator"));

  return (
    <LayerFrame title={frameTitle ?? title} footer={footer}>
      {frameTitle !== undefined && <Text bold>{title}</Text>}
      {facts.kind === "question" ? (
        <QuestionBody
          prompt={facts.interaction.prompt}
          moreKey={conversationKeyName}
        />
      ) : (
        <TaskBody facts={facts} mode={mode} detail={detail} />
      )}
      <LayerCursorBox
        cursor={Math.min(cursor, rows.length - 1)}
        offset={Math.min(cursor, rows.length - 1)}
        marginTop={1}
        gate={gate}
      >
        {rows.map((r, index) => {
          const here = index === Math.min(cursor, rows.length - 1);
          return (
            <Text
              key={rowKey(r)}
              color={here ? inkColor(theme.accent) : undefined}
              wrap="truncate-end"
            >
              {here ? "› " : "  "}
              {rowLabel(r, multi, checked, t)}
              {r.kind === "text" && (
                <LineInput
                  value={text}
                  onChange={setText}
                  focused={here && !sending}
                />
              )}
            </Text>
          );
        })}
      </LayerCursorBox>
      {sending && <Text color={inkColor(theme.muted)}>{t("sending")}</Text>}
      {error !== undefined && !sending && (
        <Text color={inkColor(theme.error)} wrap="truncate-end">
          {error}
        </Text>
      )}
    </LayerFrame>
  );
}

type Texts = ReturnType<typeof useMessages<PendingMessageKey>>;

function splitOp(op: string): [string, string] {
  const dot = op.indexOf(".");
  return [op.slice(0, dot), op.slice(dot + 1)];
}

function rowKey(row: Row): string {
  return row.kind === "option" ? `option:${row.index}` : row.kind;
}

function rowLabel(
  row: Row,
  multi: boolean,
  checked: ReadonlySet<number>,
  t: Texts,
): string {
  switch (row.kind) {
    case "option":
      return multi
        ? `${checked.has(row.index) ? "[x]" : "[ ]"} ${row.label}`
        : row.label;
    case "decline":
      return t("decline");
    case "accept":
      return t("accept");
    case "text":
      return row.label === undefined
        ? ""
        : `${t(row.label === "reply" ? "reply" : "comment")} `;
  }
}

/** `<agent> · <conversation>` for a question; `#<number> <title> · <status>` for a task. */
function itemTitle(
  state: Pick<WireState, "targets">,
  facts: Facts,
  t: Texts,
): string {
  if (facts.kind === "question") return questionTitle(state, facts.interaction);
  const { task } = facts;
  return `#${task.number} ${task.title} · ${t(statusText(task.status))}`;
}

function QuestionBody({
  prompt,
  moreKey,
}: {
  prompt: string;
  moreKey: string | undefined;
}) {
  const t = useMessages(pendingMessages);
  const all = lines(prompt);
  const [first = "", ...rest] = all.slice(0, QUESTION_LINES);
  return (
    <Box flexDirection="column">
      <Text bold wrap="wrap">
        {first}
      </Text>
      {rest.map((line, index) => (
        // Lines repeat, and their order never changes while shown.
        // eslint-disable-next-line react/no-array-index-key
        <Text key={index} wrap="wrap">
          {line === "" ? " " : line}
        </Text>
      ))}
      {all.length > QUESTION_LINES && (
        <Text>
          {moreKey === undefined
            ? t("more")
            : t("moreWithKey", { key: moreKey })}
        </Text>
      )}
    </Box>
  );
}

function TaskBody({
  facts,
  mode,
  detail,
}: {
  facts: Extract<Facts, { kind: "task" }>;
  mode: ItemMode;
  detail:
    | { task: BoardTaskDetail; activity: readonly TaskActivityView[] }
    | undefined;
}) {
  const t = useMessages(pendingMessages);
  const theme = useTheme();
  if (detail === undefined)
    return <Text color={inkColor(theme.muted)}>{t("loading")}</Text>;
  const comment = lastComment(detail.activity);
  const blocked = mode === "pending" && facts.task.status === "blocked";
  const description = lines(detail.task.description)
    .slice(0, DESCRIPTION_LINES)
    .join("\n")
    .trimEnd();
  return (
    <Box flexDirection="column">
      {(!blocked || comment === undefined) && description !== "" && (
        <Text wrap="wrap">{description}</Text>
      )}
      {comment !== undefined && (
        <Box flexDirection="column" marginTop={blocked ? 0 : 1}>
          <CommentAuthor comment={comment} />
          <Text wrap="wrap">
            {lines(comment.body ?? "")
              .slice(0, COMMENT_LINES)
              .join("\n")}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function CommentAuthor({ comment }: { comment: TaskActivityView }) {
  const t = useMessages(pendingMessages);
  const state = usePanelState();
  const { actor } = comment;
  const name =
    actor.kind === "user"
      ? t("authorYou")
      : actor.kind === "system"
        ? t("authorSystem")
        : (agentName(state, actor.agentId) ??
          (actor.agentId ?? "").slice(0, ID_PREFIX));
  return <Text bold>{name}</Text>;
}
