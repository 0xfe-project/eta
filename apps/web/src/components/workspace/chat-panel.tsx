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
import { ClaudeHeader } from "@/components/brainless/claude/claude-header";
import { ClaudeMessage } from "@/components/brainless/claude/claude-message";
import { ClaudePermission } from "@/components/brainless/claude/claude-permission";
import { ClaudePrompt } from "@/components/brainless/claude/claude-prompt";
import { ClaudeSlashMenu } from "@/components/brainless/claude/claude-slash-menu";
import { ClaudeThinking } from "@/components/brainless/claude/claude-thinking";
import { ClaudeToolCall } from "@/components/brainless/claude/claude-tool-call";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
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
  onlyText,
  plainDraft,
} from "@/lib/composer";
import { listSeparator, translate } from "@/lib/i18n";
import { mentionedMembers, mentionLabel } from "@/lib/mentions";
import { ACTIVE_STATUSES } from "@/queries/chat";
import { useOutbox } from "@/queries/outbox";
import { AgentAvatar } from "./agent-identity";
import { AttachmentChip, PastedText } from "./composer-block";
import { ComposerEditor } from "./composer-editor";
import { GroupNotice } from "./group-notice";
import { TaskMessage } from "./task-message";

type Activity = Extract<Block, { type: "activity" }>;
type Reply = Exclude<Block, { type: "attachment" }>;
type SlashName = "/stop" | "/queue" | "/steer" | "/compact";
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
const ENTER =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1";
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

function ToolActivity({ block }: { block: Activity }) {
  return (
    <ClaudeToolCall
      tool={block.name || block.label}
      arg={block.input || undefined}
      result={activityText[block.status]}
      status={
        block.status === "running"
          ? "pending"
          : block.status === "completed"
            ? "success"
            : "error"
      }
    >
      {block.output}
    </ClaudeToolCall>
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
          className="underline underline-offset-2 outline-none hover:text-[var(--terminal-foreground)] focus-visible:ring-1 focus-visible:ring-ring"
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
    <div role="alert" className="text-[var(--terminal-warning)]">
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
  // scrollHeight - scrollTop as of the last layout, to restore after a prepend.
  const fromBottomRef = useRef(0);

  function remember() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    fromBottomRef.current = el.scrollHeight - el.scrollTop;
  }
  function toBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
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

  return { scrollRef, contentRef, topRef, onScroll: remember, toBottom };
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
        <ClaudeMessage role="user">
          <UserParts parts={userParts(message)} />
        </ClaudeMessage>
      );
    // Only a reply at work still grows; the rest render as finished text.
    const streaming = ACTIVE_STATUSES.has(message.status);
    return (
      <div className="space-y-3 pt-1">
        {author && (
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
            block.type === "text" ? (
              <ClaudeMessage key={block.id} className={ENTER}>
                <Markdown streaming={streaming}>{block.text}</Markdown>
              </ClaudeMessage>
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
          <ClaudePermission
            title={translate("chat:confirmations.required")}
            question={translate("chat:confirmations.continueQuestion")}
            key={interaction.id}
            command={interaction.prompt}
            options={interaction.options.map((option) => option.label)}
            onChoose={(index) =>
              actions.current.onAnswer(
                interaction.id,
                interaction.options[index].value,
              )
            }
          />
        ))}
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
            <ClaudeThinking
              verbs={[translateText("agents:status.working")]}
              showTokens={false}
            />
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
        <ClaudeThinking
          verbs={[translateText("reply.stopping")]}
          showTokens={false}
        />
      );
    case "queued": {
      if (line.starting)
        return (
          <ClaudeThinking
            verbs={[translateText("reply.startingAgent")]}
            showTokens={false}
          />
        );
      return (
        <div className="flex flex-wrap items-baseline gap-x-3 text-[var(--terminal-muted)]">
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
            className="underline underline-offset-2 outline-none hover:text-[var(--terminal-foreground)] focus-visible:ring-1 focus-visible:ring-ring"
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
  model: modelLabel,
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
  /** The agent's model, shown where the session blocks show one. */
  model?: string;
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

  const listId = useId();
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // The menu offers commands while the draft is a bare `/name`.
  const plain = onlyText(draft);
  const members = group?.participants.filter((p) => p.member) ?? [];
  const mentionQuery = /(?:^|[\s，。！？、,:;!?])@([^@\n]*)$/.exec(
    draftText(draft),
  );
  const mentioned = mentionedMembers(draftText(draft), members);
  const query =
    plain !== null && /^\/\S*$/.test(plain)
      ? plain.slice(1).toLowerCase()
      : null;
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
  const uploading = files.some((f) => !uploads[f.id]?.attachment);
  const matches: SlashCommand[] =
    menuDismissed || blocked
      ? []
      : mentionQuery
        ? [
            {
              name: translateText("mentions.everyoneCommand") as `@${string}`,
              description: translateText("mentions.notifyEveryone"),
            },
            ...members.map((p) => ({
              name: `@${mentionLabel(p, members)}` as const,
              description:
                agents.find((a) => a.id === p.agent_id)?.status === "working"
                  ? translateText("mentions.busyHint")
                  : translateText("mentions.replyHint"),
            })),
          ].filter((c) =>
            c.name
              .slice(1)
              .toLowerCase()
              .startsWith(mentionQuery[1].toLowerCase()),
          )
        : query === null
          ? []
          : SLASH_COMMANDS.filter((c) => c.name.slice(1).startsWith(query));
  const menuOpen = matches.length > 0;
  const menuActive = Math.min(menuIndex, matches.length - 1);

  function run(name: SlashCommand["name"], parts: OutgoingPart[]) {
    if (name === "/stop") {
      onStopAll();
      setDraft([]);
    } else if (name === "/compact") {
      onCompact();
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
      run(
        command.name,
        rest.some((p) => p.type !== "text" || p.text.trim()) ? rest : [],
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
    disabled: Boolean(blocked),
    onKeyDown: (event: KeyboardEvent) => {
      // Safari ends a composition with a keydown that no longer says so.
      if (event.isComposing || event.keyCode === 229) return;
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
  const promptProps = {
    renderInput: (input: { className: string; style: React.CSSProperties }) => (
      // A new agent's composer starts from its own draft.
      <ComposerEditor key={groupId} {...editorProps} {...input} />
    ),
  };
  const slashMenu = menuOpen ? (
    <ClaudeSlashMenu
      id={listId}
      commands={matches}
      active={menuActive}
      onActiveChange={setMenuIndex}
      onChoose={(command) => choose(command as SlashCommand)}
    />
  ) : null;
  const model =
    modelLabel ?? groupName ?? translateText("composer.noAgentSelected");

  return (
    <section
      aria-label={translateText("navigation:sections.chat")}
      data-session-theme="claude"
      className="relative isolate flex h-full min-h-0 flex-col bg-[var(--terminal-background)]"
    >
      <div
        ref={transcript.scrollRef}
        onScroll={transcript.onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {/* Floats over the transcript, which scrolls on beneath it and stays
            clickable around it; only the buttons catch. */}
        {head ? (
          <div className="pointer-events-none sticky top-0 z-10 [&_button]:pointer-events-auto">
            {head}
          </div>
        ) : null}
        <div
          ref={transcript.contentRef}
          className="space-y-3 pt-2 font-mono text-[13px] leading-[1.6] text-[var(--terminal-claude-foreground)]"
        >
          {/* Stays put while a page loads, so nothing shifts until it lands. */}
          {hasOlder ? (
            <div
              ref={transcript.topRef}
              className="text-[var(--terminal-muted)]"
            >
              {translateText("history.loadEarlier")}
            </div>
          ) : (
            <ClaudeHeader
              user="Eric"
              version=""
              model={model}
              org="AXP"
              cwd={groupName ?? "workspace"}
              tips={[]}
              whatsNew={[]}
            />
          )}
          {error ? <Warning>{error}</Warning> : null}
          {connectionLost && !error ? (
            <Warning>{translateText("connection.reconnecting")}</Warning>
          ) : null}
          {loading && !error && !messages.length ? (
            <div role="status" className="text-[var(--terminal-muted)]">
              {translateText("history.loading")}
            </div>
          ) : null}
          {/* Off-screen turns skip rendering; `auto` remembers their size. */}
          <div
            className="space-y-3 pt-1 *:[contain-intrinsic-size:auto_120px] *:[content-visibility:auto]"
            role="log"
            aria-label={translateText("accessibility.messages")}
            aria-live="polite"
          >
            {messages.map((message) => (
              <Turn
                key={message.id}
                message={message}
                author={
                  group?.kind === "group" ||
                  (group?.participants.length ?? 0) > 1 ||
                  message.kind === "mention"
                    ? (agents.find((a) => a.id === message.agent_id)?.name ??
                      group?.participants.find(
                        (p) => p.agent_id === message.agent_id,
                      )?.name)
                    : undefined
                }
                pending={pendingByMessage.get(message.id) ?? NO_INTERACTIONS}
                {...lines.get(message.id)}
                actions={actionsRef}
              />
            ))}
            {outgoing.map((item) => (
              <div key={item.id} className="space-y-3 pt-1">
                <ClaudeMessage role="user" className={ENTER}>
                  <UserParts parts={item.parts} />
                </ClaudeMessage>
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
                  <div role="status" className="text-[var(--terminal-muted)]">
                    {translateText("common:states.sending")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <form
        ref={formRef}
        className="shrink-0 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {blocked || notice ? (
          <div className="px-[1ch] pb-[1lh]">{blocked ?? notice}</div>
        ) : hold ? (
          <div className="px-[1ch] pb-[0.5lh]">
            <Warning>{hold}</Warning>
          </div>
        ) : uploading ? (
          <div
            role="status"
            className="px-[1ch] pb-[0.5lh] text-[var(--terminal-muted)]"
          >
            {translateText("composer.waitForUploads")}
          </div>
        ) : null}
        {members.length > 1 && (
          <div className="flex flex-wrap items-center gap-1 px-1 pb-1 text-xs text-muted-foreground">
            {members.map((p) => (
              <Button
                key={p.agent_id}
                type="button"
                size="xs"
                variant="ghost"
                disabled={mentioned.includes(p.agent_id)}
                onClick={() =>
                  setDraft([
                    ...draft,
                    { type: "text", text: ` @${mentionLabel(p, members)} ` },
                  ])
                }
              >
                @{mentionLabel(p, members)}
              </Button>
            ))}
            <span>
              {mentioned.length
                ? translateText("mentions.notifyTargets", {
                    names: mentioned
                      .map((id) => members.find((p) => p.agent_id === id)?.name)
                      .join(listSeparator()),
                  })
                : translateText("mentions.noTargetsHint")}
            </span>
          </div>
        )}
        {/* A disabled fieldset disables the session's own input. */}
        <fieldset disabled={Boolean(blocked)} className="contents">
          {slashMenu}
          <ClaudePrompt {...promptProps} mode="manual" effort={false} />
        </fieldset>
      </form>
    </section>
  );
}
