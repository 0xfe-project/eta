import type {
  Agent,
  Block,
  ChatMessage,
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
import { ClaudeHeader } from "@/components/brainless/claude/claude-header";
import { ClaudeMessage } from "@/components/brainless/claude/claude-message";
import { ClaudePermission } from "@/components/brainless/claude/claude-permission";
import { ClaudePrompt } from "@/components/brainless/claude/claude-prompt";
import { ClaudeSlashMenu } from "@/components/brainless/claude/claude-slash-menu";
import { ClaudeThinking } from "@/components/brainless/claude/claude-thinking";
import { ClaudeToolCall } from "@/components/brainless/claude/claude-tool-call";
import { CodexExec } from "@/components/brainless/codex/codex-exec";
import { CodexHeader } from "@/components/brainless/codex/codex-header";
import { CodexMessage } from "@/components/brainless/codex/codex-message";
import { CodexPermissions } from "@/components/brainless/codex/codex-permissions";
import { CodexPrompt } from "@/components/brainless/codex/codex-prompt";
import { CodexSlashMenu } from "@/components/brainless/codex/codex-slash-menu";
import { CodexWorking } from "@/components/brainless/codex/codex-working";
import { GrokHeader } from "@/components/brainless/grok/grok-header";
import { GrokMessage } from "@/components/brainless/grok/grok-message";
import { GrokPermission } from "@/components/brainless/grok/grok-permission";
import { GrokPrompt } from "@/components/brainless/grok/grok-prompt";
import { GrokSlashMenu } from "@/components/brainless/grok/grok-slash-menu";
import { GrokThinking } from "@/components/brainless/grok/grok-thinking";
import { GrokTool } from "@/components/brainless/grok/grok-tool";
import { Markdown } from "@/components/markdown";
import { ACTIVE_STATUSES } from "@/queries/chat";

// Each theme is laid out like its brainless session block
// (components/brainless/blocks): header, turn, working line, composer.
export type SessionTheme = "claude" | "codex" | "grok";
type Activity = Extract<Block, { type: "activity" }>;
interface MessageProps {
  role?: "user" | "assistant";
  time?: string;
  children: React.ReactNode;
}
interface ChoiceProps {
  prompt: string;
  labels: string[];
  onChoose: (index: number) => void;
}

type SlashName = "/stop" | "/queue" | "/steer" | "/compact";
interface SlashCommand {
  name: SlashName;
  description: string;
  /** Completes to `name ` for the message to follow. */
  takesText?: boolean;
}
const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/stop", description: "停止当前回复" },
  { name: "/queue", description: "当前回复结束后发送", takesText: true },
  { name: "/steer", description: "插入当前回复", takesText: true },
  { name: "/compact", description: "压缩上下文" },
];

const activityText = { running: "进行中", completed: "完成", failed: "失败" };
/** The activity as one line: the tool and what it was given. */
function activityTitle(block: Activity) {
  const tool = block.name || block.label;
  return block.input ? `${tool} ${block.input}` : tool;
}
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
  "START_TIMEOUT",
]);

function messageText(message: ChatMessage | undefined) {
  return (message?.blocks ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

const sessions = {
  claude: {
    Message: ({ role, children }: MessageProps) => (
      <ClaudeMessage role={role}>{children}</ClaudeMessage>
    ),
    textClass: "text-[var(--terminal-claude-foreground)]",
    turnClass: "space-y-3 pt-1",
    promptClass: "pt-2",
    Activity: ({ block }: { block: Activity }) => (
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
    ),
    Choice: ({ prompt, labels, onChoose }: ChoiceProps) => (
      <ClaudePermission
        title="需要确认"
        command={prompt}
        question="是否继续？"
        options={labels}
        onChoose={onChoose}
      />
    ),
    Working: ({ label }: { label: string }) => (
      <ClaudeThinking verbs={[label]} showTokens={false} />
    ),
    SlashMenu: ClaudeSlashMenu,
    slashMenuBelow: false,
  },
  codex: {
    Message: ({ role, children }: MessageProps) => (
      <CodexMessage role={role}>{children}</CodexMessage>
    ),
    textClass: "text-[var(--terminal-foreground)]",
    turnClass: "space-y-3 pt-1",
    promptClass: "pt-2",
    Activity: ({ block }: { block: Activity }) => (
      <CodexExec
        command={activityTitle(block)}
        status={
          block.status === "running"
            ? "run"
            : block.status === "completed"
              ? "ok"
              : "error"
        }
      >
        {block.output}
      </CodexExec>
    ),
    Choice: ({ prompt, labels, onChoose }: ChoiceProps) => (
      <CodexPermissions
        title={prompt}
        options={labels.map((label) => ({ label, description: "" }))}
        onChoose={onChoose}
      />
    ),
    Working: ({ label }: { label: string }) => <CodexWorking label={label} />,
    SlashMenu: CodexSlashMenu,
    slashMenuBelow: true,
  },
  grok: {
    Message: ({ role, time, children }: MessageProps) => (
      <GrokMessage role={role} time={time}>
        {children}
      </GrokMessage>
    ),
    textClass: "text-[var(--terminal-foreground)]",
    turnClass: "space-y-2 pt-1",
    promptClass: "pt-3",
    Activity: ({ block }: { block: Activity }) => (
      <GrokTool
        verb={block.name || block.label}
        path={block.input || undefined}
        meta={activityText[block.status]}
      >
        {block.output}
      </GrokTool>
    ),
    Choice: ({ prompt, labels, onChoose }: ChoiceProps) => (
      <GrokPermission
        title="需要确认"
        command={prompt}
        options={labels}
        onChoose={onChoose}
      />
    ),
    Working: ({ label }: { label: string }) => <GrokThinking verbs={[label]} />,
    SlashMenu: GrokSlashMenu,
    slashMenuBelow: false,
  },
};

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
  agentId,
  firstId,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: {
  agentId: string | undefined;
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
  useLayoutEffect(toBottom, [agentId]);
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
  onResend: (text: string) => void;
}

/**
 * What a reply's state line needs from the rest of the conversation; plain
 * values, so a row given the same ones skips rendering.
 */
interface ReplyLine {
  /** Replies ahead of a queued one. */
  ahead?: number;
  /** The agent is starting for this reply. */
  starting?: boolean;
  /** The next reply failed the same way; this one says so. */
  sameAsNext?: boolean;
  /** The text of the user message a failed reply answered. */
  resend?: string;
}

/** The state line facts per reply. */
function replyLines(
  messages: ChatMessage[],
  agentStatus: Agent["status"] | undefined,
) {
  const replies = messages.filter((message) => message.role === "assistant");
  const executing = replies.filter((message) =>
    EXECUTING.has(message.status),
  ).length;
  const lines = new Map<string, ReplyLine>();
  let queued = 0;
  replies.forEach((message, i) => {
    if (message.status === "queued") {
      const ahead = executing + queued++;
      lines.set(message.id, {
        ahead,
        starting: ahead === 0 && agentStatus === "starting",
      });
    } else if (message.status === "failed") {
      const code = message.failure?.code ?? "";
      const next = replies[i + 1];
      lines.set(message.id, {
        // A run of replies failed by the same environment trouble says it once.
        sameAsNext:
          ENVIRONMENT_FAILURES.has(code) &&
          next?.status === "failed" &&
          next.failure?.code === code,
        resend: messageText(messages.find((m) => m.id === message.reply_to_id)),
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
    theme,
    message,
    pending,
    actions,
    ...line
  }: {
    theme: SessionTheme;
    message: ChatMessage;
    /** Its interactions waiting for the user. */
    pending: Interaction[];
    actions: React.RefObject<TurnActions>;
  } & ReplyLine) => {
    const session = sessions[theme];
    const { Message, Activity, Choice, Working } = session;
    const timeLabel = theme === "grok" ? time(message.created_at) : undefined;
    if (message.role === "user")
      return (
        <Message role="user" time={timeLabel}>
          <span className="whitespace-pre-wrap">
            {message.blocks.map((block) =>
              block.type === "text" ? block.text : null,
            )}
          </span>
        </Message>
      );
    // Only a reply at work still grows; the rest render as finished text.
    const streaming = ACTIVE_STATUSES.has(message.status);
    return (
      <div className={session.turnClass}>
        {message.blocks.map((block) =>
          block.type === "text" ? (
            <Message key={block.id} time={timeLabel}>
              <Markdown streaming={streaming}>{block.text}</Markdown>
            </Message>
          ) : (
            <Activity key={block.id} block={block} />
          ),
        )}
        {pending.map((interaction) => (
          <Choice
            key={interaction.id}
            prompt={interaction.prompt}
            labels={interaction.options.map((option) => option.label)}
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
          Working={Working}
          onStop={() => actions.current.onStop(message.id)}
          onResend={(text) => actions.current.onResend(text)}
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
  Working,
  onStop,
  onResend,
}: {
  message: ChatMessage;
  asking: boolean;
  line: ReplyLine;
  Working: (props: { label: string }) => React.ReactNode;
  onStop: () => void;
  onResend: (text: string) => void;
}) {
  switch (message.status) {
    case "responding":
    case "waiting_for_input":
      return asking ? null : <Working label="工作中" />;
    case "stopping":
      return <Working label="正在停止" />;
    case "queued": {
      if (line.starting) return <Working label="正在启动智能体" />;
      return (
        <div className="flex flex-wrap items-baseline gap-x-3 text-[var(--terminal-muted)]">
          <span>
            {line.ahead ? `等待中 · 前面还有 ${line.ahead} 条` : "等待中"}
          </span>
          <button
            type="button"
            onClick={onStop}
            className="underline underline-offset-2 outline-none hover:text-[var(--terminal-foreground)] focus-visible:ring-1 focus-visible:ring-ring"
          >
            撤回
          </button>
        </div>
      );
    }
    case "stopped":
      return <Warning>已停止</Warning>;
    case "failed": {
      const text = line.resend;
      return (
        <ComposerNotice
          message={
            line.sameAsNext
              ? "此消息未执行，原因同下。"
              : (message.failure?.message ?? "回复失败。")
          }
          actions={
            text ? [{ label: "重新发送", onClick: () => onResend(text) }] : []
          }
        />
      );
    }
    default:
      return null;
  }
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatPanel({
  theme,
  agentId,
  agentName,
  messages,
  loading,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  interactions,
  draft,
  onDraftChange: setDraft,
  onSend,
  onCompact,
  onStop,
  onAnswer,
  head,
  error,
  connectionLost,
  model: modelLabel,
  blocked,
  agentStatus,
  outgoing,
  onRetry,
  onEdit,
  onDiscard,
  onResend,
}: {
  theme: SessionTheme;
  agentId: string | undefined;
  agentName: string | undefined;
  /** The conversation with the current agent, as far back as loaded. */
  messages: ChatMessage[];
  /** The conversation is still being read. */
  loading?: boolean;
  /** Earlier messages exist; onLoadOlder fetches the next page of them. */
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  interactions: Interaction[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (content: string, mode: SendMode) => void;
  onCompact: () => void;
  onStop: (replyId: string) => void;
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
  agentStatus?: Agent["status"];
  /** The user's messages on their way, after the transcript. */
  outgoing: Outgoing[];
  onRetry: (outgoing: Outgoing) => void;
  onEdit: (outgoing: Outgoing) => void;
  onDiscard: (id: string) => void;
  /** Send a failed reply's message again, as a new message. */
  onResend: (text: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const session = sessions[theme];
  const { Message, SlashMenu } = session;
  // The reply in progress; later ones wait behind it.
  const active = messages.find(
    (message) =>
      message.role === "assistant" &&
      ACTIVE_STATUSES.has(message.status) &&
      message.status !== "stopping",
  );
  const lines = useMemo(
    () => replyLines(messages, agentStatus),
    [messages, agentStatus],
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
    agentId,
    firstId: messages[0]?.id,
    hasOlder,
    loadingOlder,
    onLoadOlder,
  });

  const listId = useId();
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // The menu offers commands while the draft is a bare `/name`.
  const query = /^\/\S*$/.test(draft) ? draft.slice(1).toLowerCase() : null;
  const matches =
    query === null || menuDismissed || blocked
      ? []
      : SLASH_COMMANDS.filter((command) =>
          command.name.slice(1).startsWith(query),
        );
  const menuOpen = matches.length > 0;
  const menuActive = Math.min(menuIndex, matches.length - 1);

  function run(name: SlashName, text: string) {
    if (name === "/stop") {
      if (active) onStop(active.id);
      setDraft("");
    } else if (name === "/compact") {
      onCompact();
    } else if (text.trim()) {
      onSend(text, name === "/steer" ? "steer" : "queue");
    }
  }
  function choose(command: SlashCommand) {
    if (command.takesText) setDraft(`${command.name} `);
    else run(command.name, "");
  }
  function send() {
    if (blocked || !draft.trim()) return;
    const space = draft.search(/\s/);
    const name = space === -1 ? draft : draft.slice(0, space);
    const text = space === -1 ? "" : draft.slice(space).trimStart();
    const command = SLASH_COMMANDS.find((c) => c.name === name);
    if (command) run(command.name, text);
    else onSend(draft, "queue");
    // Sending jumps back to the live end, as in a terminal.
    transcript.toBottom();
    formRef.current?.querySelector("textarea")?.focus();
  }
  const promptProps = {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      setMenuIndex(0);
      setMenuDismissed(false);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
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
      // The CLIs' interrupt keys, as their working lines advertise.
      const interrupt =
        theme === "grok"
          ? event.ctrlKey && event.key === "c" && !draft
          : event.key === "Escape";
      if (interrupt && active) {
        event.preventDefault();
        onStop(active.id);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    placeholder: agentName ? `发消息给 ${agentName}…` : "先创建智能体",
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": menuOpen,
      "aria-controls": menuOpen ? listId : undefined,
      "aria-activedescendant": menuOpen ? `${listId}-${menuActive}` : undefined,
    } satisfies React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  };
  const slashMenu = menuOpen ? (
    <SlashMenu
      id={listId}
      commands={matches}
      active={menuActive}
      onActiveChange={setMenuIndex}
      onChoose={(command) => choose(command as SlashCommand)}
    />
  ) : null;
  const model = modelLabel ?? agentName ?? "未选择智能体";

  return (
    <section
      aria-label="对话"
      data-session-theme={theme}
      className="relative isolate flex h-full min-h-0 flex-col bg-[var(--terminal-background)]"
    >
      <div
        ref={transcript.scrollRef}
        onScroll={transcript.onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {/* Floats over the transcript, which scrolls on under the glass and
            stays clickable where it shows through; only the buttons catch. */}
        {head ? (
          <div className="pointer-events-none sticky top-0 z-10 [&_button]:pointer-events-auto">
            <div
              aria-hidden="true"
              className="chat-glass pointer-events-none absolute inset-0 -z-10"
            />
            {head}
          </div>
        ) : null}
        <div
          ref={transcript.contentRef}
          className={`space-y-3 pt-2 font-mono text-[13px] leading-[1.6] ${session.textClass}`}
        >
          {/* Stays put while a page loads, so nothing shifts until it lands. */}
          {hasOlder ? (
            <div
              ref={transcript.topRef}
              className="text-[var(--terminal-muted)]"
            >
              加载更早的消息…
            </div>
          ) : theme === "claude" ? (
            <ClaudeHeader
              user="Eric"
              version=""
              model={model}
              org="AXP"
              cwd="workspace"
              tips={[]}
              whatsNew={[]}
            />
          ) : theme === "codex" ? (
            <CodexHeader version="" model={model} directory="workspace" />
          ) : (
            <GrokHeader version="" headline="AXP" subhead={model} />
          )}
          {error ? <Warning>{error}</Warning> : null}
          {connectionLost && !error ? (
            <Warning>连接中断，正在重连…显示的状态可能不是最新的。</Warning>
          ) : null}
          {loading && !error && !messages.length ? (
            <div role="status" className="text-[var(--terminal-muted)]">
              正在读取对话…
            </div>
          ) : null}
          {/* Off-screen turns skip rendering; `auto` remembers their size. */}
          <div
            className={`${session.turnClass} *:[contain-intrinsic-size:auto_120px] *:[content-visibility:auto]`}
            role="log"
            aria-label="对话消息"
            aria-live="polite"
          >
            {messages.map((message) => (
              <Turn
                key={message.id}
                theme={theme}
                message={message}
                pending={pendingByMessage.get(message.id) ?? NO_INTERACTIONS}
                {...lines.get(message.id)}
                actions={actionsRef}
              />
            ))}
            {outgoing.map((item) => (
              <div key={item.id} className={session.turnClass}>
                <Message role="user">
                  <span className="whitespace-pre-wrap">{item.text}</span>
                </Message>
                {item.failure ? (
                  <ComposerNotice
                    message={item.failure}
                    actions={[
                      { label: "重试", onClick: () => onRetry(item) },
                      { label: "编辑", onClick: () => onEdit(item) },
                      { label: "丢弃", onClick: () => onDiscard(item.id) },
                    ]}
                  />
                ) : (
                  <div role="status" className="text-[var(--terminal-muted)]">
                    发送中…
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <form
        ref={formRef}
        className={`shrink-0 ${session.promptClass}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {blocked ? <div className="px-[1ch] pb-[1lh]">{blocked}</div> : null}
        {/* A disabled fieldset disables the session's own input. */}
        <fieldset disabled={Boolean(blocked)} className="contents">
          {session.slashMenuBelow ? null : slashMenu}
          {theme === "claude" ? (
            <ClaudePrompt {...promptProps} mode="manual" effort={false} />
          ) : theme === "codex" ? (
            <CodexPrompt {...promptProps} model={model} directory="workspace" />
          ) : (
            <GrokPrompt
              {...promptProps}
              model={model}
              mode="normal"
              busy={Boolean(active)}
              showShortcuts={false}
            />
          )}
          {session.slashMenuBelow ? slashMenu : null}
        </fieldset>
      </form>
    </section>
  );
}
