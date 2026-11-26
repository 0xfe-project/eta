import type {
  AgentMessage,
  AgentView,
  AttachmentView,
  ConversationKind,
  LogBlock,
  MemberView,
  MessageView,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { Locale } from "../../../config/types";
import type { Translate } from "../../../i18n/messages";
import type { TranscriptItem } from "../contract";
import {
  logBlocks,
  runFromOf,
  runStart,
  savedSteps,
  streamDrawn,
  systemNoticeOf,
} from "@eta/client-contracts";
import { translatorFor } from "../../../i18n/messages";
import { feedMessages } from "../feed/messages";
import { pasteBlocksOf } from "./paste-blocks";
import { foldSteps } from "./steps";
import { RUNNING_STATUSES } from "./timeline";

/** What the TUI holds of one member session's run in flight. */
export interface SessionLive {
  /** The view's `transcript.messages`; undefined until the view arrives. */
  rows: readonly ViewMessageRow[] | undefined;
  /** The view's `core.streaming`. */
  coreStreaming: AgentMessage | undefined;
  /** The message being streamed, as the latest `message:update` event carried it. */
  streamed: AgentMessage | undefined;
  /** What each running tool call has printed so far, by call id (`tool:update`). */
  progress: ReadonlyMap<string, string>;
  /** The text of the question the session is waiting on the user for (`ask.pending`). */
  question: string | undefined;
  /**
   * The host answered `target:missing`, or `sessions.resync` failed and no sections came since;
   * a running reply says so instead of "Replying…".
   */
  unreadable: boolean;
}

export interface ItemsInput {
  /** The rows to draw, oldest first; held messages already left out. */
  rows: readonly MessageView[];
  members: readonly MemberView[];
  agents: readonly Pick<AgentView, "id" | "name">[];
  /** `info.kind`; undefined until the conversation's facts arrive. */
  kind: ConversationKind | undefined;
  /** By session id. */
  sessions: ReadonlyMap<string, SessionLive>;
  locale: Locale;
  /** The key that opens review mode, named for the user; the waiting line ends with it when set. */
  reviewKey?: string | undefined;
  /**
   * Folds each reply's steps under one `steps` item, unfolded when this says so of that item's
   * key. Without it every reply shows all of its items.
   */
  stepsOpen?: ((key: string) => boolean) | undefined;
}

type Texts = Translate<keyof (typeof feedMessages)["en"]>;

interface Context {
  input: ItemsInput;
  t: Texts;
}

/** What an agent is called; one the list does not have is the start of its id. */
function agentName(
  agents: ItemsInput["agents"],
  agentId: string | null | undefined,
): string {
  return (
    agents.find((agent) => agent.id === agentId)?.name ??
    (agentId ?? "").slice(0, 6)
  );
}

/**
 * The row an item comes from: every item's key is its row's id alone, or the row's id, a colon and
 * what the item is in the row.
 */
export function rowOfKey(key: string): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

/** The transcript, one item per thing drawn, oldest first. */
export function transcriptItems(input: ItemsInput): TranscriptItem[] {
  const context: Context = {
    input,
    t: translatorFor(feedMessages, input.locale),
  };
  const { rows, additions } = indexInserts(input.rows);
  return rows.flatMap((row) => {
    const own = rowItems(context, row);
    const added = additions.get(row.id);
    return added === undefined
      ? own
      : [
          ...own,
          ...added.flatMap((addition) => insertedItems(context, addition)),
        ];
  });
}

/**
 * A user message put into another one's turns (`data.into`) is drawn in that message, under it,
 * not where it was written — as the client draws it. One whose message is not among the rows is
 * drawn where it is.
 */
function indexInserts(all: readonly MessageView[]): {
  rows: MessageView[];
  additions: Map<string, MessageView[]>;
} {
  const prompts = new Set(
    all.filter((row) => row.author === "user").map((row) => row.id),
  );
  const additions = new Map<string, MessageView[]>();
  const rows = all.filter((row) => {
    const { into } = row.data;
    if (
      row.author !== "user" ||
      typeof into !== "string" ||
      into === row.id ||
      !prompts.has(into)
    )
      return true;
    const list = additions.get(into) ?? [];
    list.push(row);
    additions.set(into, list);
    return false;
  });
  return { rows, additions };
}

/** `Inserted · 14:02`, then the words, as the client's insert block. */
function insertedItems(context: Context, row: MessageView): TranscriptItem[] {
  const at = new Date(row.createdAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return [
    notice(
      `${row.id}:inserted`,
      context.t("inserted", {
        clock: `${two(at.getHours())}:${two(at.getMinutes())}`,
      }),
    ),
    userItem(row),
  ];
}

function rowItems(context: Context, row: MessageView): TranscriptItem[] {
  switch (row.kind) {
    case "system":
      return [notice(row.id, systemText(context, row))];
    case "task_draft":
      return [notice(row.id, taskDraftText(context, row))];
    case "task_card":
      return [notice(row.id, taskCardText(context, row))];
    case "message":
    case "mention":
      if (row.author === "user") return userItems(context, row);
      if (row.author === "agent") return replyItems(context, row);
      // A message the host or Captain wrote into the conversation, among them what Captain is told
      // about its proposals and its review prompt: Captain's context, not drawn here.
      return [];
  }
}

function notice(
  key: string,
  text: string,
  tone: "muted" | "warning" = "muted",
): TranscriptItem {
  return { kind: "notice", key, tone, text };
}

function userItem(row: MessageView): TranscriptItem {
  return {
    kind: "user",
    key: row.id,
    text: row.text,
    pastes: pasteBlocksOf(row.data, row.text) ?? [],
    attachments: attachmentsOf(row.data),
    images: [],
  };
}

function userItems(context: Context, row: MessageView): TranscriptItem[] {
  // A steer written before steers were drawn in the message they joined: its own row, saying whose
  // turn it went into.
  const items: TranscriptItem[] = [userItem(row)];
  const joined = Array.isArray(row.data.joined)
    ? row.data.joined.filter((id): id is string => typeof id === "string")
    : [];
  if (joined.length > 0) {
    const { t, input } = context;
    const names = joined
      .map((id) => agentName(input.agents, id))
      .join(t("nameSeparator"));
    items.push(notice(`${row.id}:joined`, t("joined", { names })));
  }
  return items;
}

/** The files a message came with; an entry without an id and a name is not one. */
function attachmentsOf(data: Record<string, unknown>): AttachmentView[] {
  if (!Array.isArray(data.attachments)) return [];
  return (data.attachments as (Partial<AttachmentView> | null)[]).filter(
    (file): file is AttachmentView =>
      typeof file?.id === "string" && typeof file.name === "string",
  );
}

function replyItems(context: Context, row: MessageView): TranscriptItem[] {
  const { input } = context;
  // A row says whose turn it was where there is more than one voice in the room. A group of one is
  // that agent's own chat, and its name is the title there already.
  const author: TranscriptItem[] =
    input.kind === "group" && input.members.length > 1
      ? [
          {
            kind: "author",
            key: `${row.id}:author`,
            name: agentName(input.agents, row.agentId),
            agentId: row.agentId ?? "",
            members: input.members.map((member) => member.agentId),
          },
        ]
      : [];
  return [...author, ...foldedBody(context, row)];
}

/** The reply's own items, its steps folded when the input asks for it. */
function foldedBody(context: Context, row: MessageView): TranscriptItem[] {
  const body = replyBody(context, row);
  const { stepsOpen } = context.input;
  if (stepsOpen === undefined) return body;
  const key = `${row.id}:steps`;
  return foldSteps(body, key, RUNNING_STATUSES.has(row.status), stepsOpen(key));
}

function replyBody(context: Context, row: MessageView): TranscriptItem[] {
  const { t } = context;
  if (row.status === "queued") return [notice(`${row.id}:queued`, t("queued"))];
  if (!RUNNING_STATUSES.has(row.status)) return finishedItems(row);
  const session = sessionOf(context.input, row);
  const live =
    session?.rows === undefined ? undefined : liveItems(row, session);
  if (row.status !== "waiting_for_input")
    return (
      live ?? [
        notice(
          `${row.id}:replying`,
          session?.unreadable === true ? t("unreadable") : t("replying"),
        ),
      ]
    );
  const question = session?.question;
  const reviewKey = context.input.reviewKey;
  const hint =
    reviewKey === undefined ? "" : t("reviewHint", { key: reviewKey });
  const waiting = notice(
    `${row.id}:waiting`,
    question === undefined
      ? t("waitingBare", { hint })
      : t("waiting", { question, hint }),
    "warning",
  );
  return [...(live ?? []), waiting];
}

function sessionOf(
  input: ItemsInput,
  row: MessageView,
): SessionLive | undefined {
  const sessionId = input.members.find(
    (member) => member.agentId === row.agentId,
  )?.sessionId;
  return sessionId === null || sessionId === undefined
    ? undefined
    : input.sessions.get(sessionId);
}

function finishedItems(row: MessageView): TranscriptItem[] {
  // What it thought, said and did on the way, in the order the run showed it. Where it took a steer
  // is not drawn: the words are the user's row, drawn in the message whose turn they joined.
  const items = savedSteps(row)
    .filter((block) => block.type !== "steer")
    .map(
      (block): TranscriptItem =>
        block.type === "tool"
          ? {
              kind: "tool",
              key: `${row.id}:${block.id}`,
              tool: block,
              progress: undefined,
            }
          : {
              kind: block.type,
              key: `${row.id}:${block.id}`,
              text: block.text,
              streaming: false,
            },
    );
  if (row.text !== "" && row.status !== "failed")
    items.push({
      kind: "text",
      key: `${row.id}:text`,
      text: row.text,
      streaming: false,
    });
  if (row.status === "stopped")
    items.push({
      kind: "outcome",
      key: `${row.id}:outcome`,
      outcome: "stopped",
      // Why it was stopped without its run, when it was (`stop_unanswered`, `link_lost`, …).
      code: typeof row.data.code === "string" ? row.data.code : undefined,
      text: typeof row.data.stopError === "string" ? row.data.stopError : "",
    });
  else if (row.status === "failed")
    items.push({
      kind: "outcome",
      key: `${row.id}:outcome`,
      outcome: "failed",
      code: typeof row.data.code === "string" ? row.data.code : undefined,
      text: row.text,
    });
  return items;
}

function liveItems(row: MessageView, session: SessionLive): TranscriptItem[] {
  const rows = session.rows ?? [];
  const runFrom = runFromOf(row.data);
  // A view whose newest row is not past `runFrom` has not caught up: its `core.streaming` is the
  // last run's. The events are always this run's.
  const behind = runFrom !== undefined && (rows.at(-1)?.seq ?? 0) <= runFrom;
  const streaming =
    session.streamed ?? (behind ? undefined : session.coreStreaming);
  const run = rows.slice(runStart(rows, runFrom));
  const blocks = logBlocks(run, streaming);
  const drawn = streamDrawn(run, streaming);
  let lastWritten = -1;
  blocks.forEach((block, index) => {
    if (block.type === "text" || block.type === "thinking") lastWritten = index;
  });
  return blocks.flatMap((block, index) =>
    liveItem(row, block, session, drawn && index === lastWritten),
  );
}

function liveItem(
  row: MessageView,
  block: LogBlock,
  session: SessionLive,
  streaming: boolean,
): TranscriptItem[] {
  const key = `${row.id}:${block.id}`;
  switch (block.type) {
    case "thinking":
    case "text":
      return [{ kind: block.type, key, text: block.text, streaming }];
    case "tool":
      return [
        {
          kind: "tool",
          key,
          tool: block,
          progress: session.progress.get(block.id),
        },
      ];
    case "error":
      return [
        {
          kind: "outcome",
          key,
          outcome: "run-error",
          code: undefined,
          text: block.text,
        },
      ];
    case "summary":
      return [{ kind: "summary", key, summary: block.kind, text: block.text }];
    case "user":
      // The run starts after the last user message, so none is in it.
      return [];
  }
}

function systemText(context: Context, row: MessageView): string {
  const { t, input } = context;
  const name = (id: string) => agentName(input.agents, id);
  const notice = systemNoticeOf(row);
  switch (notice.kind) {
    case "stewardChanged":
      return t("stewardChanged", {
        to: name(notice.to),
        from: name(notice.from),
      });
    case "stewardSet":
      return t("stewardSet", { to: name(notice.to) });
    case "stewardCleared":
      return t("stewardCleared", { from: name(notice.from) });
    case "stewardLeft":
      return t("stewardLeft", { from: name(notice.from) });
    case "wakeBudget":
      return t("wakeBudget", { budget: notice.budget });
    case "createdByCaptain":
      return t("createdByCaptain");
    case "routineReport":
      return notice.title === null
        ? t("routineReportUntitled", { name: notice.name })
        : t("routineReport", { name: notice.name, title: notice.title });
    case "text":
      return notice.text;
  }
}

function taskDraftText(context: Context, row: MessageView): string {
  const title = typeof row.data.title === "string" ? row.data.title : "";
  // Discarded by the user, it waits for nothing. A draft that does not say (an older one) starts
  // when confirmed, as they all did.
  return context.t(
    row.data.discarded === true
      ? "taskDraftDiscarded"
      : row.data.status === "backlog"
        ? "taskDraftBacklog"
        : "taskDraft",
    { title },
  );
}

function taskCardText(context: Context, row: MessageView): string {
  const title = typeof row.data.title === "string" ? row.data.title : "";
  const number = typeof row.data.number === "number" ? row.data.number : "";
  return context.t("taskCard", { number, title });
}
