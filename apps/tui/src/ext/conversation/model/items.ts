import type {
  AgentMessage,
  AgentView,
  AttachmentView,
  ConversationKind,
  MemberView,
  MessageView,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { Locale } from "../../../config/types";
import type { Translate } from "../../../i18n/messages";
import type { TranscriptItem } from "../contract";
import type { LogBlock } from "./run";
import { translatorFor } from "../../../i18n/messages";
import { feedMessages } from "../feed/messages";
import { pasteBlocksOf } from "./paste-blocks";
import { logBlocks, runFromOf, savedTools } from "./run";
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
  return input.rows.flatMap((row) => rowItems(context, row));
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

function userItems(context: Context, row: MessageView): TranscriptItem[] {
  const items: TranscriptItem[] = [
    {
      kind: "user",
      key: row.id,
      text: row.text,
      pastes: pasteBlocksOf(row.data, row.text) ?? [],
      attachments: attachmentsOf(row.data),
      images: [],
    },
  ];
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
  const author: TranscriptItem[] =
    input.kind === "group"
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
  const items: TranscriptItem[] = [];
  if (row.thinking !== "")
    items.push({
      kind: "thinking",
      key: `${row.id}:thinking`,
      text: row.thinking,
      streaming: false,
    });
  for (const tool of savedTools(row.data))
    items.push({
      kind: "tool",
      key: `${row.id}:${tool.id}`,
      tool,
      progress: undefined,
    });
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
      code: undefined,
      text: "",
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

/**
 * Where the run starts among the session's rows: after `runFrom` and after the last user message,
 * the same start as `runBlocks` in apps/web/src/lib/run.ts.
 */
function runStart(
  rows: readonly ViewMessageRow[],
  runFrom: number | undefined,
): number {
  let start = 0;
  rows.forEach((sessionRow, index) => {
    if (
      sessionRow.message.role === "user" ||
      (runFrom !== undefined && sessionRow.seq <= runFrom)
    )
      start = index + 1;
  });
  return start;
}

function stampOf(message: AgentMessage | undefined): number {
  const stamp = (message as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof stamp === "number" ? stamp : 0;
}

/**
 * The stream is drawn only while it is newer than every assistant message the run has committed
 * (`logBlocks` leaves it out otherwise), so only then is a block still being written.
 */
function streamDrawn(
  run: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
): boolean {
  if (streaming?.role !== "assistant") return false;
  const newest = Math.max(
    0,
    ...run
      .filter((sessionRow) => sessionRow.message.role === "assistant")
      .map((sessionRow) => stampOf(sessionRow.message)),
  );
  return stampOf(streaming) > newest;
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

interface SystemData {
  event?: unknown;
  from?: unknown;
  to?: unknown;
  budget?: unknown;
  title?: unknown;
}

function systemText(context: Context, row: MessageView): string {
  const { t, input } = context;
  const { event, from, to, budget, title } = row.data as SystemData;
  const name = (id: string) => agentName(input.agents, id);
  if (event === "steward") {
    if (typeof to === "string" && typeof from === "string")
      return t("stewardChanged", { to: name(to), from: name(from) });
    if (typeof to === "string") return t("stewardSet", { to: name(to) });
    if (typeof from === "string")
      return t("stewardCleared", { from: name(from) });
  }
  if (event === "wake_budget" && typeof budget === "number")
    return t("wakeBudget", { budget });
  if (event === "routine_report" && typeof title === "string" && title !== "")
    return title;
  return row.text;
}

function taskDraftText(context: Context, row: MessageView): string {
  const title = typeof row.data.title === "string" ? row.data.title : "";
  return context.t("taskDraft", { title });
}

function taskCardText(context: Context, row: MessageView): string {
  const title = typeof row.data.title === "string" ? row.data.title : "";
  const number = typeof row.data.number === "number" ? row.data.number : "";
  return context.t("taskCard", { number, title });
}
