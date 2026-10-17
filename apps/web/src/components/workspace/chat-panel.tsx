import type { Draft, FilePart, OutgoingPart } from "@/lib/composer";

import type {
  Agent,
  Block,
  ChatMessage,
  Group,
  Interaction,
  SendMode,
} from "@/queries/chat";
import type { Outgoing } from "@/queries/outbox";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActivityOperationCards } from "@/components/workspace/activity-operation";
import { ActivityRefCard } from "@/components/workspace/activity-ref";
import {
  afterCommand,
  charCount,
  draftText,
  isBlank,
  isLongPaste,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_CHARS,
  messageParts,
  pasteFileName,
  plainDraft,
} from "@/lib/composer";
import { buildMenu, mentionAt } from "@/lib/composer-menu";
import { translate } from "@/lib/i18n";
import { mentionedMembers, mentionLabel } from "@/lib/mentions";
import { firstVisible } from "@/lib/rail";
import { readTheme, setTheme } from "@/lib/theme";
import { summarizeArgs } from "@/lib/tool-summary";
import { ACTIVE_STATUSES } from "@/queries/chat";
import { upload, useOutbox } from "@/queries/outbox";
import { AgentAvatar } from "./agent-identity";
import { AttachmentChip, PastedText } from "./composer-block";
import { ComposerEditor } from "./composer-editor";
import { ModelChip, ThinkingChip } from "./composer-pickers";
import { GroupNotice } from "./group-notice";
import { PendingStrip } from "./pending-strip";
import { when } from "./routine-format";
import { TaskMessage } from "./task-message";
import { TranscriptRail } from "./transcript-rail";
import { AskBlock } from "./transcript/ask-block";
import { Message, SystemMessage } from "./transcript/message";
import { SlashMenu } from "./transcript/slash-menu";
import { ThinkingBlock } from "./transcript/thinking-block";
import { ToolCard, ToolCardBlock } from "./transcript/tool-card";
import { useWorkspaceStore } from "./workspace-store";

type Activity = Extract<Block, { type: "activity" }>;
type Reply = Exclude<Block, { type: "attachment" }>;
type SlashName =
  | "/stop"
  | "/queue"
  | "/steer"
  | "/compact"
  | "/goal"
  | "/theme"
  | "/settings"
  | "/new";
interface SlashCommand {
  name: SlashName | `@${string}`;
  description: string;
  /** Completes to `name ` for the message to follow. */
  takesText?: boolean;
}
const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/stop",
    get description() {
      return translate("chat:commands.stopAllDescription");
    },
  },
  {
    name: "/queue",
    get description() {
      return translate("chat:sendModes.afterReply");
    },
    takesText: true,
  },
  {
    name: "/steer",
    get description() {
      return translate("chat:sendModes.interruptReply");
    },
    takesText: true,
  },
  {
    name: "/compact",
    get description() {
      return translate("chat:commands.compactDescription");
    },
  },
  // Commands that carry a payload. `takesText` is what makes `/goal ship it` complete to
  // `/goal ` and wait for the rest, instead of firing the moment it is picked.
  {
    name: "/goal",
    get description() {
      return translate("chat:commands.goalDescription");
    },
    takesText: true,
  },
  {
    name: "/theme",
    get description() {
      return translate("chat:commands.themeDescription");
    },
  },
  {
    name: "/settings",
    get description() {
      return translate("chat:commands.settingsDescription");
    },
  },
  {
    name: "/new",
    get description() {
      return translate("chat:commands.newDescription");
    },
  },
];

const activityText = {
  get running() {
    return translate("tasks:status.inProgress");
  },
  get completed() {
    return translate("common:actions.done");
  },
  get failed() {
    return translate("common:status.failed");
  },
};
// A new block of the transcript fades in, rising a little. The user's own
// message does as it is sent; its copy from the server replaces it in place.
// Nothing. A message that slides up and fades in is a message you wait to read; eta-old's
// transcript puts the row where it belongs and moves on.
const ENTER = "";
// Replies holding the agent's runtime; queued ones wait behind them.
const EXECUTING = new Set<ChatMessage["status"]>([
  "responding",
  "waiting_for_input",
  "stopping",
]);
// Failures of the agent's environment, which fail everything waiting at once.
const ENVIRONMENT_FAILURES = new Set([
  "AGENT_UNAVAILABLE",
  "AGENT_RECOVERY_FAILED",
  "AGENT_EXTENSION_FAILED",
  "AGENT_BUILD_FAILED",
]);

/** A user message's text and attachments, to send again. */
function userParts(message: ChatMessage): OutgoingPart[] {
  return message.blocks.flatMap((block): OutgoingPart[] =>
    block.type === "text"
      ? [{ type: "text", text: block.text }]
      : block.type === "attachment"
        ? [{ type: "attachment", attachment: block.attachment }]
        : [],
  );
}

/** What the user wrote: text, with long pastes and attachments folded where they stand. */
function UserParts({ parts }: { parts: OutgoingPart[] }) {
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) =>
        part.type === "attachment" ? (
          // eslint-disable-next-line react/no-array-index-key -- parts never move
          <AttachmentChip key={i} attachment={part.attachment} />
        ) : isLongPaste(part.text) ? (
          // eslint-disable-next-line react/no-array-index-key -- parts never move
          <PastedText key={i} text={part.text} />
        ) : (
          part.text
        ),
      )}
    </span>
  );
}

/**
 * Who a message is for, as a composer control.
 *
 * In a group the model chip has no single answer — the members can be on different models — so the
 * control in that slot picks the *people* instead. 所有人 comes first because it is a real choice,
 * not a convenience.
 */
function MemberPicker({
  members,
  mentioned,
  onPick,
}: {
  members: readonly { agent_id: string; name: string }[];
  mentioned: readonly string[];
  onPick: (label: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="composer-members"
          className="composer-control"
          title={translateText("mentions.notifyTargets", {
            names: members
              .filter((member) => mentioned.includes(member.agent_id))
              .map((member) => member.name)
              .join("、"),
          })}
        >
          <span className="composer-control-label">
            {translateText("mentions.pickTargets")}
          </span>
          <CaretDownIcon aria-hidden="true" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuItem
          onSelect={() => onPick(translateText("mentions.everyoneCommand"))}
        >
          <span className="font-mono">
            @{translateText("mentions.everyoneCommand")}
          </span>
        </DropdownMenuItem>
        {members.map((member) => (
          <DropdownMenuItem
            key={member.agent_id}
            disabled={mentioned.includes(member.agent_id)}
            onSelect={() => onPick(member.name)}
          >
            <span className="min-w-0 flex-1 truncate">{member.name}</span>
            {mentioned.includes(member.agent_id) ? (
              <span aria-hidden="true">✓</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolActivity({ block }: { block: Activity }) {
  // The arguments are a JSON object; the header shows what the call is *doing*, which is the first
  // thing worth quoting out of it (lib/tool-summary.ts).
  const summary = summarizeArgs(block.input);
  return (
    <ToolCard
      tool={block.name || block.label}
      summary={summary.length > 0 ? summary : undefined}
      status={block.status}
      statusLabel={activityText[block.status]}
    >
      {block.input === undefined || block.input === null ? null : (
        <ToolCardBlock label={translate("chat:tools.arguments")}>
          {typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2)}
        </ToolCardBlock>
      )}
      {block.output === undefined ? null : (
        <ToolCardBlock label={translate("chat:tools.result")}>
          {String(block.output)}
        </ToolCardBlock>
      )}
    </ToolCard>
  );
}

/** A warning with the ways out of it. */
export function ComposerNotice({
  message,
  actions,
}: {
  message: string;
  actions: { label: string; onClick: () => void }[];
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <Warning>{message}</Warning>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={action.onClick}
          className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

/** The blocks' warning line (`⚠ …`). */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="text-state-warning">
      <span aria-hidden>⚠ </span>
      {children}
    </div>
  );
}

/**
 * Scrolls the transcript like a terminal: it opens at the bottom and follows
 * new output while the reader is there. Older messages added above keep the
 * view where it was, and come in as the top is approached.
 */
function useTranscriptScroll({
  groupId,
  firstId,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: {
  groupId: string | undefined;
  firstId: string | undefined;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Whether the view is glued to the live end. Both a ref (for the resize observer, which must not
  // re-subscribe) and state (for the button that offers to go back).
  const [pinned, setPinned] = useState(true);
  // scrollHeight - scrollTop as of the last layout, to restore after a prepend.
  const fromBottomRef = useRef(0);

  function remember() {
    const el = scrollRef.current;
    if (!el) return;
    // 32px: close enough that the last line is still readable, far enough that a stray wheel tick
    // does not count as leaving.
    const glued = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    atBottomRef.current = glued;
    if (glued !== pinned) setPinned(glued);
    fromBottomRef.current = el.scrollHeight - el.scrollTop;
  }
  function toBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setPinned(true);
  }

  // A new agent's transcript opens at its end.
  useLayoutEffect(toBottom, [groupId]);
  // Older messages arrived above: keep the same distance from the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && !atBottomRef.current)
      el.scrollTop = el.scrollHeight - fromBottomRef.current;
  }, [firstId]);
  // Streaming output, new turns, a resized panel: follow while at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) toBottom();
      remember();
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // Observed afresh after each page, so a top still in view loads the next.
  useEffect(() => {
    const top = topRef.current;
    if (!top || !hasOlder || loadingOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onLoadOlder();
      },
      { root: scrollRef.current, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(top);
    return () => observer.disconnect();
  }, [hasOlder, loadingOlder, onLoadOlder]);

  return {
    scrollRef,
    contentRef,
    topRef,
    onScroll: remember,
    toBottom,
    pinned,
    /** Jump to one message by id: the rail's whole job. */
    jumpTo: (id: string) => {
      const el = scrollRef.current?.querySelector<HTMLElement>(
        `[data-mid="${CSS.escape(id)}"]`,
      );
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    /** The first message visible, so the rail can light where you are reading. */
    active: () => {
      const scroller = scrollRef.current;
      if (scroller === null) return undefined;
      const top = scroller.getBoundingClientRect().top;
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-mid]")];
      const offsets = rows.map((row) => ({
        id: row.dataset.mid ?? "",
        top: row.getBoundingClientRect().top - top,
      }));
      return firstVisible(offsets);
    },
  };
}

const NO_INTERACTIONS: Interaction[] = [];

interface TurnActions {
  onStop: (replyId: string) => void;
  onAnswer: (interactionId: string, value: string) => void;
  onResend: (parts: OutgoingPart[], agentId?: string) => void;
}

/**
 * What a reply's state line needs from the rest of the conversation; plain
 * values, so a row given the same ones skips rendering.
 */
interface ReplyLine {
  /** Replies ahead of a queued one. */
  ahead?: number;
  elsewhere?: string;
  /** The agent is starting for this reply. */
  starting?: boolean;
  /** The next reply failed the same way; this one says so. */
  sameAsNext?: boolean;
  /** The user message a failed reply answered. */
  resend?: ChatMessage;
}

/** The state line facts per reply. */
function replyLines(
  messages: ChatMessage[],
  agents: Agent[],
  activeReplies: ChatMessage[],
  groups: Group[],
) {
  const replies = messages.filter(
    (m) => m.role === "assistant" && m.kind === "message",
  );
  const lines = new Map<string, ReplyLine>();
  replies.forEach((message, i) => {
    if (message.status === "queued") {
      const before = activeReplies.filter(
        (m) =>
          m.agent_id === message.agent_id &&
          m.id !== message.id &&
          ACTIVE_STATUSES.has(m.status) &&
          (m.created_at < message.created_at || EXECUTING.has(m.status)),
      );
      const other = before.find((m) => m.group_id !== message.group_id);
      lines.set(message.id, {
        ahead: before.length,
        starting:
          !before.length &&
          agents.find((a) => a.id === message.agent_id)?.status === "starting",
        elsewhere: other
          ? groups.find((g) => g.id === other.group_id)?.name
          : undefined,
      });
    } else if (message.status === "failed") {
      const code = message.failure?.code ?? "";
      const next = replies[i + 1];
      lines.set(message.id, {
        sameAsNext:
          ENVIRONMENT_FAILURES.has(code) &&
          next?.agent_id === message.agent_id &&
          next?.status === "failed" &&
          next.failure?.code === code,
        resend: messages.find(
          (m) => m.id === message.reply_to_id && m.role === "user",
        ),
      });
    }
  });
  return lines;
}

/**
 * One message of the transcript. Memoized: a streamed update renders only
 * the message it changed, not the whole conversation.
 */
const Turn = memo(
  ({
    message,
    pending,
    author,
    actions,
    ...line
  }: {
    message: ChatMessage;
    author?: string;
    /** Its interactions waiting for the user. */
    pending: Interaction[];
    actions: React.RefObject<TurnActions>;
  } & ReplyLine) => {
    useTranslation([
      "chat",
      "agents",
      "common",
      "navigation",
      "tasks",
    ] as const);
    if (message.kind === "task_draft" || message.kind === "task_card")
      return <TaskMessage message={message} />;
    if (message.kind === "system") return <GroupNotice message={message} />;
    if (message.role === "user")
      return (
        <Message
          role="user"
          footer={
            <time dateTime={message.created_at}>
              {when(message.created_at)}
            </time>
          }
        >
          <UserParts parts={userParts(message)} />
        </Message>
      );
    // Only a reply at work still grows; the rest render as finished text.
    const streaming = ACTIVE_STATUSES.has(message.status);
    const saidText = message.blocks
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join("\n\n");
    return (
      <div className="message assistant">
        {author === undefined ? null : (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AgentAvatar agent={{ id: message.agent_id }} className="size-4" />
            <span>
              {author}
              {message.kind === "mention"
                ? translate("chat:messages.mentionTarget", {
                    name: String(
                      message.data.to ?? translate("common:entities.agents"),
                    ),
                  })
                : ""}
            </span>
          </div>
        )}
        {message.blocks
          .filter((block): block is Reply => block.type !== "attachment")
          .map((block) =>
            block.type === "thinking" ? (
              // What it worked through: folded, with its size on the line, because it is context
              // for reading the answer critically rather than a second answer.
              <ThinkingBlock
                key={block.id ?? "thinking"}
                text={block.text}
                {...(block.chars === undefined ? {} : { chars: block.chars })}
              />
            ) : block.type === "text" ? (
              <div key={block.id} className="message-content">
                <Markdown streaming={streaming}>{block.text}</Markdown>
              </div>
            ) : (
              <div key={block.id} className={`space-y-1 ${ENTER}`}>
                <ToolActivity block={block} />
                {block.ref && block.status === "completed" ? (
                  <ActivityRefCard value={block.ref} className="ml-[2ch]" />
                ) : null}
                {block.operations?.length && block.status !== "running" ? (
                  <ActivityOperationCards
                    operations={block.operations}
                    className="ml-[2ch]"
                  />
                ) : null}
              </div>
            ),
          )}
        {pending.map((interaction) => (
          <AskBlock
            key={interaction.id}
            interaction={interaction}
            who={author}
            onAnswer={(id, value) => actions.current.onAnswer(id, value)}
          />
        ))}
        <div className="message-footer">
          <time dateTime={message.created_at}>{when(message.created_at)}</time>
          <CopyMessage text={saidText} />
        </div>
        <ReplyState
          message={message}
          asking={pending.length > 0}
          line={line}
          onStop={() => actions.current.onStop(message.id)}
          onResend={(parts) =>
            actions.current.onResend(parts, message.agent_id)
          }
        />
      </div>
    );
  },
);

/**
 * The line under a reply. Only one per agent moves: the reply at work, or
 * the agent starting for the first one waiting.
 */
function ReplyState({
  message,
  asking,
  line,
  onStop,
  onResend,
}: {
  message: ChatMessage;
  asking: boolean;
  line: ReplyLine;
  onStop: () => void;
  onResend: (parts: OutgoingPart[], agentId?: string) => void;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "common",
    "navigation",
    "tasks",
  ] as const);
  switch (message.status) {
    case "responding":
    case "waiting_for_input":
      return (
        <div className="flex items-center gap-3">
          {asking ? null : (
            <span
              role="status"
              className="font-mono text-[11px] text-muted-foreground"
            >
              {translateText("agents:status.working")}…
            </span>
          )}
          <button
            type="button"
            onClick={onStop}
            className="text-xs text-muted-foreground underline underline-offset-2"
          >
            {translateText("common:actions.stop")}
          </button>
        </div>
      );
    case "stopping":
      return (
        <span
          role="status"
          className="font-mono text-[11px] text-muted-foreground"
        >
          {translateText("reply.stopping")}…
        </span>
      );
    case "queued": {
      if (line.starting)
        return (
          <span
            role="status"
            className="font-mono text-[11px] text-muted-foreground"
          >
            {translateText("reply.startingAgent")}…
          </span>
        );
      return (
        <div className="flex flex-wrap items-baseline gap-x-3 text-muted-foreground">
          <span>
            {line.elsewhere
              ? translateText("reply.waitingElsewhere", {
                  groupName: line.elsewhere,
                })
              : line.ahead
                ? translateText("reply.queuePosition", {
                    count: line.ahead,
                  })
                : translateText("common:status.waiting")}
          </span>
          <button
            type="button"
            onClick={onStop}
            className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            {translateText("actions.withdraw")}
          </button>
        </div>
      );
    }
    case "stopped":
      return <Warning>{translateText("common:status.stopped")}</Warning>;
    case "failed": {
      const parts = line.resend && userParts(line.resend);
      return (
        <ComposerNotice
          message={
            line.sameAsNext
              ? translateText("reply.sameFailureAsNext")
              : (message.failure?.message ?? translateText("reply.failed"))
          }
          actions={
            parts?.length
              ? [
                  {
                    label: translateText("actions.resend"),
                    onClick: () => onResend(parts),
                  },
                ]
              : []
          }
        />
      );
    }
    default:
      return null;
  }
}

export function ChatPanel({
  groupId,
  groupName,
  messages,
  loading,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  interactions,
  draft,
  onDraftChange: setDraft,
  onFiles,
  onSend,
  onCompact,
  onStop,
  onStopAll,
  onAnswer,
  head,
  error,
  connectionLost,
  blocked,
  notice,
  group,
  agents,
  groups,
  activeReplies,
  outgoing,
  onRetry,
  onEdit,
  onDiscard,
  onResend,
  onGoal,
  onReload,
}: {
  groupId: string | undefined;
  groupName: string | undefined;
  /** The conversation with the current agent, as far back as loaded. */
  messages: ChatMessage[];
  /** The conversation is still being read. */
  loading?: boolean;
  /** Earlier messages exist; onLoadOlder fetches the next page of them. */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  interactions: Interaction[];
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  /** Start uploading files pasted into the draft; their blocks. */
  onFiles: (files: File[]) => FilePart[];
  onSend: (parts: OutgoingPart[], mode: SendMode) => void;
  onCompact: () => void;
  onStop: (replyId: string) => void;
  /** `/stop`: stops every reply in the group. */
  onStopAll: () => void;
  onAnswer: (interactionId: string, value: string) => void;
  /** Shows and switches the agent being talked to. */
  head?: React.ReactNode;
  error?: string;
  /** The live updates dropped; what shows may be out of date. */
  connectionLost?: boolean;
  /** Why the composer is disabled, with the way out. */
  blocked?: React.ReactNode;
  /** A warning above the composer that leaves it usable. */
  notice?: React.ReactNode;
  group?: Group;
  agents: Agent[];
  groups: Group[];
  activeReplies: ChatMessage[];
  /** The user's messages on their way, after the transcript. */
  outgoing: Outgoing[];
  onRetry: (outgoing: Outgoing) => void;
  onEdit: (outgoing: Outgoing) => void;
  onDiscard: (id: string) => void;
  /** Send a failed reply's message again, as a new message. */
  onResend: (parts: OutgoingPart[], agentId?: string) => void;
  /** Ask for the conversation again, when reading it failed. */
  onReload?: () => void;
  /** The goal of this conversation, moved from the composer's `/goal`. */
  onGoal: (
    action: "set" | "pause" | "resume" | "clear",
    objective?: string,
  ) => Promise<unknown>;
}) {
  const { t: translateText } = useTranslation([
    "chat",
    "agents",
    "common",
    "navigation",
    "tasks",
  ] as const);
  const formRef = useRef<HTMLFormElement>(null);
  // The reply in progress; later ones wait behind it.
  const active = messages.find(
    (message) =>
      message.role === "assistant" &&
      ACTIVE_STATUSES.has(message.status) &&
      message.status !== "stopping",
  );
  const lines = useMemo(
    () => replyLines(messages, agents, activeReplies, groups),
    [messages, agents, activeReplies, groups],
  );
  const pendingByMessage = useMemo(() => {
    const byMessage = new Map<string, Interaction[]>();
    for (const interaction of interactions)
      if (interaction.status === "pending")
        byMessage.set(interaction.message_id, [
          ...(byMessage.get(interaction.message_id) ?? []),
          interaction,
        ]);
    return byMessage;
  }, [interactions]);
  // The rows call the latest handlers without taking them as props, which
  // change on every render and would undo the rows' memo.
  const actionsRef = useRef<TurnActions>({ onStop, onAnswer, onResend });
  useLayoutEffect(() => {
    actionsRef.current = { onStop, onAnswer, onResend };
  });
  const transcript = useTranscriptScroll({
    groupId,
    firstId: messages[0]?.id,
    hasOlder,
    loadingOlder,
    onLoadOlder,
  });

  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  // What the rail numbers: the agent's replies (squares) and your own messages (circles). A
  // conversation with one of each has nothing to jump between, and the rail draws nothing.
  const railReplies = useMemo(
    () =>
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          id: message.id,
          text: message.blocks
            .filter((block: { type: string }) => block.type === "text")
            .map((block: { text?: string }) => block.text ?? "")
            .join(" "),
        })),
    [messages],
  );
  const railPrompts = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user")
        .map((message) => ({
          id: message.id,
          text: message.blocks
            .filter((block: { type: string }) => block.type === "text")
            .map((block: { text?: string }) => block.text ?? "")
            .join(" "),
        })),
    [messages],
  );
  // Composition state the keydown handler needs but the DOM only reports to other listeners.
  const ime = useRef({ composing: false, endedAt: 0 });
  const setSettings = useWorkspaceStore((state) => state.setSettings);
  const listId = useId();
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const members = group?.participants.filter((p) => p.member) ?? [];
  const text = draftText(draft);
  // The project's files, fetched the first time the `@` menu opens: a completion list nobody is
  // looking at is a directory walk nobody asked for.
  const atOpen = mentionAt(text) !== null;
  const queryClient = useQueryClient();
  const projectFiles = useQuery({
    queryKey: ["files", groupId],
    enabled: atOpen && groupId !== undefined,
    staleTime: 30_000,
    queryFn: async (): Promise<string[]> => {
      if (groupId === undefined) return [];
      const response = await fetch(
        `/api/v1/files?group_id=${encodeURIComponent(groupId)}`,
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { files?: string[] };
      return body.files ?? [];
    },
  });
  const mentioned = mentionedMembers(text, members);
  // Why the draft cannot go yet: its files' uploads, or the limits.
  const uploads = useOutbox((s) => s.uploads);
  const files = draft.filter((part) => part.type === "file");
  const hold = files.some((f) => uploads[f.id]?.error)
    ? translateText("composer.errors.failedAttachments")
    : files.length > MAX_ATTACHMENTS
      ? translateText("composer.errors.attachmentLimit", {
          maxAttachments: MAX_ATTACHMENTS,
        })
      : charCount(draftText(draft)) > MAX_MESSAGE_CHARS
        ? translateText("composer.errors.messageLength", {
            maxCharacters: MAX_MESSAGE_CHARS,
          })
        : undefined;
  // Still on its way, not *failed*: a file whose upload errored has no attachment either, and
  // calling that "waiting for uploads" hides the sentence that says what went wrong.
  const uploading = files.some(
    (file) =>
      uploads[file.id] === undefined ||
      (uploads[file.id]?.attachment === undefined &&
        uploads[file.id]?.error === undefined),
  );
  // One menu, two sources (lib/composer-menu.ts): `@` offers the group's members first and the
  // project's files after them, `/` offers commands.
  const menu = buildMenu({
    text,
    members: members.map((member: { agent_id: string; name: string }) => ({
      id: member.agent_id,
      name: mentionLabel(member, members),
      busy:
        agents.find((agent) => agent.id === member.agent_id)?.status ===
        "working",
    })),
    files: projectFiles.data ?? [],
    commands: SLASH_COMMANDS,
    dismissed: menuDismissed || blocked !== undefined,
  });
  const matches: SlashCommand[] =
    menu === null
      ? []
      : menu.items.map(
          (item): SlashCommand =>
            item.kind === "command"
              ? { name: item.value as SlashName, description: item.description }
              : {
                  name: item.value.trim() as `@${string}`,
                  description:
                    item.kind === "file"
                      ? translateText("composer.fileHint")
                      : item.hint
                        ? translateText("mentions.busyHint")
                        : translateText("mentions.replyHint"),
                },
        );
  const menuOpen = matches.length > 0;
  const menuActive = Math.min(menuIndex, matches.length - 1);

  function run(name: SlashCommand["name"], parts: OutgoingPart[], args = "") {
    if (name === "/stop") {
      onStopAll();
      setDraft([]);
    } else if (name === "/compact") {
      onCompact();
    } else if (name === "/goal") {
      // A goal set from the composer is the same goal the right panel shows: it goes through the
      // same route, so the two cannot disagree.
      if (args.trim().length > 0) void onGoal("set", args.trim());
      setDraft([]);
    } else if (name === "/theme") {
      setTheme(readTheme() === "dark" ? "light" : "dark");
      setDraft([]);
    } else if (name === "/settings") {
      setSettings((state) => ({ ...state, open: true }));
      setDraft([]);
    } else if (name === "/new") {
      void navigate({ to: "/new", search: { cwd: group?.cwd ?? "" } });
      setDraft([]);
    } else if (parts.length) {
      onSend(parts, name === "/steer" ? "steer" : "queue");
    }
  }
  function choose(command: SlashCommand) {
    if (command.name.startsWith("@")) {
      const next = [...draft];
      const last = next.at(-1);
      if (last?.type === "text")
        next[next.length - 1] = {
          ...last,
          text: last.text.replace(/@[^@\n]*$/, `${command.name} `),
        };
      setDraft(next);
      setMenuIndex(0);
      setMenuDismissed(true);
    } else if (command.name === "/compact" && members.length > 1)
      setDraft(plainDraft("/compact "));
    else if (command.takesText) setDraft(plainDraft(`${command.name} `));
    else run(command.name, []);
  }
  function send() {
    if (blocked || hold || uploading || isBlank(draft)) return;
    const parts = messageParts(draft, (id) => uploads[id]?.attachment);
    if (!parts) return;
    const first = parts[0]?.type === "text" ? parts[0].text : "";
    const space = first.search(/\s/);
    const name = space === -1 ? first : first.slice(0, space);
    const command = SLASH_COMMANDS.find((c) => c.name === name);
    if (command) {
      const rest = afterCommand(parts, name);
      const args = rest
        .filter((part) => part.type === "text")
        .map((part) => ("text" in part ? part.text : ""))
        .join(" ")
        .trim();
      run(
        command.name,
        rest.some((p) => p.type !== "text" || p.text.trim()) ? rest : [],
        args,
      );
    } else onSend(parts, "queue");
    // Sending jumps back to the live end, as in a terminal.
    transcript.toBottom();
    formRef.current?.querySelector<HTMLElement>("[contenteditable]")?.focus();
  }
  const editorProps = {
    value: draft,
    onChange: (next: Draft) => {
      setDraft(next);
      setMenuIndex(0);
      setMenuDismissed(false);
    },
    onFiles,
    onPaste: (id: string, pasted: string) => {
      if (groupId === undefined) return;
      void upload(
        groupId,
        id,
        new File([pasted], pasteFileName(), {
          type: "text/plain;charset=utf-8",
        }),
      ).then(() => {
        // The file list the `@` menu reads is now out of date: a file just appeared in the project.
        void queryClient.invalidateQueries({ queryKey: ["files", groupId] });
      });
    },
    disabled: Boolean(blocked),
    onCompositionStart: () => {
      ime.current.composing = true;
    },
    onCompositionEnd: () => {
      ime.current.composing = false;
      ime.current.endedAt = performance.now();
    },
    onKeyDown: (event: KeyboardEvent) => {
      /*
       * Is this Enter the input method finishing a word rather than the person sending?
       *
       * Three engines, three orders, all three answered (eta-old measured this in a real browser,
       * not from the spec): Chrome flags the key with `isComposing`; WebKit says nothing but the
       * legacy `keyCode: 229`; macOS Pinyin typed as ASCII commits on Enter and closes the
       * composition *before* delivering the key, so the keydown looks completely ordinary. The
       * window after `compositionend` covers that third case — long enough to swallow the Enter
       * that committed the text, short enough not to eat a deliberate second press.
       */
      const imeOwned =
        event.isComposing ||
        event.keyCode === 229 ||
        ime.current.composing ||
        performance.now() - ime.current.endedAt < 120;
      if (imeOwned) return;
      // ⌘/Ctrl+Enter means "send", whatever the menu is offering: steering a running turn must not
      // depend on whether a completion menu happens to be open.
      const forceSend = (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (forceSend && event.key === "Enter") {
        event.preventDefault();
        send();
        return;
      }
      if (menuOpen) {
        const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
        if (step) {
          event.preventDefault();
          setMenuIndex((menuActive + step + matches.length) % matches.length);
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          choose(matches[menuActive]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      const interrupt = event.key === "Escape";
      if (interrupt && active) {
        event.preventDefault();
        onStop(active.id);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    placeholder: groupName
      ? translateText("composer.placeholder", { agentName: groupName })
      : translateText("composer.createAgentFirst"),
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": menuOpen,
      "aria-controls": menuOpen ? listId : undefined,
      "aria-activedescendant": menuOpen ? `${listId}-${menuActive}` : undefined,
    } satisfies React.HTMLAttributes<HTMLDivElement>,
  };
  const slashMenu = menuOpen ? (
    <SlashMenu
      id={listId}
      rows={matches}
      active={menuActive}
      onHover={setMenuIndex}
      onChoose={(row) => choose(row as SlashCommand)}
    />
  ) : null;

  return (
    <section
      aria-label={translateText("navigation:sections.chat")}
      className="relative isolate flex h-full min-h-0 flex-col bg-background"
    >
      {/* eta-old's timeline: a scroller that keeps clear of the rail on its right, and the rail
          pinned to the *viewport* rather than to the content — which is the whole difference
          between a column of numbers down the side and a column of numbers in the middle of the
          text. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={transcript.scrollRef}
          onScroll={() => {
            transcript.onScroll();
            // Cheap enough: one pass over the rows that are actually in the DOM.
            setActiveId(transcript.active());
          }}
          className="no-scrollbar h-full overflow-y-auto py-4 pr-14 pl-6"
        >
          {/* Floats over the transcript, which scrolls on beneath it and stays
            clickable around it; only the buttons catch. */}
          {head ? (
            <div className="pointer-events-none sticky top-0 z-10 [&_button]:pointer-events-auto">
              {head}
            </div>
          ) : null}
          {/* The rail is inside the scroll container so it can stick to the top of what you see;
            it takes a lane on the right and the transcript keeps clear of it. */}
          {/* Everything a run is standing still on, in one line each, wherever you are in the
            transcript. The cards inside the turns stay: they are the same questions in their own
            place. */}
          <PendingStrip
            interactions={interactions}
            agents={agents}
            onAnswer={onAnswer}
          />
          <div className="mx-auto max-w-[860px]">
            <div className="min-w-0">
              <div
                ref={transcript.contentRef}
                className="font-sans text-sm leading-[1.65] text-foreground"
              >
                {/* No welcome banner: eta-old's transcript starts with the first message. The only
                  thing above it is the way back to earlier pages, and it appears when they exist. */}
                {hasOlder ? (
                  <div ref={transcript.topRef}>
                    <SystemMessage>
                      {translateText("history.loadEarlier")}
                    </SystemMessage>
                  </div>
                ) : null}
                {/*
                 * The four states a conversation can be in, in one place and in the same words as
                 * the rest of the app: it failed (and can be asked again), the live updates dropped
                 * (and it reconnects itself), it is still being read, or there is nothing here yet.
                 * They live above the transcript rather than inside it so they do not scroll away
                 * with the thing they describe.
                 */}
                {error !== undefined ? (
                  <div className="border border-state-error px-2 py-1 text-xs">
                    <div role="alert" className="text-state-error">
                      {error}
                    </div>
                    {onReload === undefined ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        className="mt-1"
                        onClick={onReload}
                      >
                        {translateText("common:actions.retry")}
                      </Button>
                    )}
                  </div>
                ) : null}
                {connectionLost && error === undefined ? (
                  <p
                    role="status"
                    className="border border-state-warning px-2 py-1 text-xs text-state-warning"
                  >
                    {translateText("connection.reconnecting")}
                  </p>
                ) : null}
                {loading && error === undefined && !messages.length ? (
                  <p
                    role="status"
                    className="px-1 py-2 text-xs text-muted-foreground"
                  >
                    {translateText("history.loading")}
                  </p>
                ) : null}
                {!loading && !error && messages.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    {translateText("history.empty")}
                  </p>
                ) : null}
                {/* Off-screen turns skip rendering; `auto` remembers their size. */}
                <div
                  className="space-y-3 pt-1 *:[contain-intrinsic-size:auto_120px] *:[content-visibility:auto]"
                  role="log"
                  aria-label={translateText("accessibility.messages")}
                  aria-live="polite"
                >
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      id={`msg-${message.id}`}
                      data-mid={message.id}
                    >
                      <Turn
                        key={message.id}
                        message={message}
                        author={
                          group?.kind === "group" ||
                          (group?.participants.length ?? 0) > 1 ||
                          message.kind === "mention"
                            ? (agents.find((a) => a.id === message.agent_id)
                                ?.name ??
                              group?.participants.find(
                                (p) => p.agent_id === message.agent_id,
                              )?.name)
                            : undefined
                        }
                        pending={
                          pendingByMessage.get(message.id) ?? NO_INTERACTIONS
                        }
                        {...lines.get(message.id)}
                        actions={actionsRef}
                      />
                    </div>
                  ))}
                  {outgoing.map((item) => (
                    <div key={item.id} className="space-y-3 pt-1">
                      <Message role="user" className={ENTER}>
                        <UserParts parts={item.parts} />
                      </Message>
                      {item.failure ? (
                        <ComposerNotice
                          message={item.failure}
                          actions={[
                            {
                              label: translateText("common:actions.retry"),
                              onClick: () => onRetry(item),
                            },
                            {
                              label: translateText("common:actions.edit"),
                              onClick: () => onEdit(item),
                            },
                            {
                              label: translateText("common:actions.discard"),
                              onClick: () => onDiscard(item.id),
                            },
                          ]}
                        />
                      ) : (
                        <div role="status" className="text-muted-foreground">
                          {translateText("common:states.sending")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {/* Off the live end: say there is more, and who is adding it. Following resumes the
            moment you scroll back down, or here. */}
          {transcript.pinned ? null : (
            <button
              type="button"
              onClick={() => transcript.toBottom()}
              className="sticky bottom-2 z-10 mx-auto flex items-center gap-1 border border-border-strong bg-background px-2 py-1 text-xs shadow-md"
            >
              ↓ {translateText("chat:rail.newActivity")}
              {activeReplies.length > 0
                ? ` · ${members
                    .filter((member: { agent_id: string }) =>
                      activeReplies.some(
                        (reply: { agent_id?: string | null }) =>
                          reply.agent_id === member.agent_id,
                      ),
                    )
                    .map((member: { name: string }) => member.name)
                    .join("、")}`
                : ""}
            </button>
          )}
        </div>
        <div className="absolute top-16 right-1">
          <TranscriptRail
            replies={railReplies}
            prompts={railPrompts}
            activeId={activeId}
            onJump={transcript.jumpTo}
          />
        </div>
      </div>
      {/*
       * The composer, copied from eta-old rather than improvised: `.input-area` → `.input-outer`
       * → `.composer-card` (which is the bordered box, and turns its border on when something
       * inside has focus) → the editor → `.composer-toolbar` with the controls on the left, the
       * hint in the middle and send on the right. The class names are its class names, and the
       * CSS behind them was ported with them, because the previous version was invented here and
       * came out worse than the thing it replaced.
       */}
      <footer className="input-area">
        <div className="input-outer">
          {/*
           * In priority order, and each one is a different sentence: why the box cannot be used
           * (blocked), why this draft cannot go (hold — a failed upload, too many files), a
           * warning that leaves it usable (notice). Only the first that applies is shown.
           */}
          {blocked !== undefined ? (
            <div className="border-b px-3 py-1.5 text-xs">{blocked}</div>
          ) : hold !== undefined || uploading ? (
            <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">
              {uploading ? translateText("composer.waitForUploads") : hold}
            </div>
          ) : notice === undefined ? null : (
            <div className="border-b px-3 py-1.5 text-xs">{notice}</div>
          )}
          <form
            ref={formRef}
            className="composer-card"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <fieldset disabled={Boolean(blocked)} className="contents">
              {slashMenu}
              {/* eta-old's editor: the box is the border, the textarea is nothing but the text
                  area. No `❯`, no mode line, no second and third frame around it. */}
              <ComposerEditor
                key={groupId}
                className="composer-editor"
                {...editorProps}
              />
              <div className="composer-toolbar">
                <div className="composer-controls flex min-w-0 items-center gap-2">
                  {members.length === 1 && members[0] !== undefined ? (
                    <>
                      <ModelChip
                        sessionId={members[0].session_id ?? undefined}
                      />
                      <ThinkingChip
                        sessionId={members[0].session_id ?? undefined}
                      />
                    </>
                  ) : (
                    <MemberPicker
                      members={members}
                      mentioned={mentioned}
                      onPick={(label) =>
                        setDraft([
                          ...draft,
                          { type: "text", text: ` @${label} ` },
                        ])
                      }
                    />
                  )}
                  <span className="composer-toolbar-hints min-w-0 truncate">
                    {active === undefined
                      ? translateText("composer.sendHint")
                      : translateText("composer.workingHint")}
                  </span>
                </div>
                <Button
                  type="submit"
                  className="composer-control composer-submit-control"
                  disabled={
                    blocked !== undefined || hold !== undefined || uploading
                  }
                >
                  {isBlank(draft) && active !== undefined
                    ? translateText("composer.stopLabel")
                    : translateText("common:actions.send")}
                </Button>
              </div>
            </fieldset>
          </form>
        </div>
      </footer>
    </section>
  );
}

/**
 * Copy what the agent said, from under the message.
 *
 * The whole point of the footer is that it is out of the way until you want it: the button is
 * 10px mono in the same dim line as the time, and it says "copied" for a beat rather than
 * throwing a toast for a click you already know you made.
 */
function CopyMessage({ text }: { text: string }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [copied, setCopied] = useState(false);
  if (text.trim().length === 0) return null;
  return (
    <button
      type="button"
      className="message-copy-btn font-mono text-[10px] uppercase tracking-[0.1em]"
      data-copied={copied}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(setCopied, 1200, false);
        } catch {
          /* no clipboard outside a secure context */
        }
      }}
    >
      {copied
        ? translateText("common:feedback.copied")
        : translateText("common:actions.copy")}
    </button>
  );
}
