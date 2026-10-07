import { useEffect, useRef } from "react";
import { ClaudeHeader } from "@/components/brainless/claude/claude-header";
import { ClaudeMessage } from "@/components/brainless/claude/claude-message";
import { ClaudePermission } from "@/components/brainless/claude/claude-permission";
import { ClaudePrompt } from "@/components/brainless/claude/claude-prompt";
import { ClaudeThinking } from "@/components/brainless/claude/claude-thinking";
import { ClaudeToolCall } from "@/components/brainless/claude/claude-tool-call";
import { CodexExec } from "@/components/brainless/codex/codex-exec";
import { CodexHeader } from "@/components/brainless/codex/codex-header";
import { CodexMessage } from "@/components/brainless/codex/codex-message";
import { CodexPermissions } from "@/components/brainless/codex/codex-permissions";
import { CodexPrompt } from "@/components/brainless/codex/codex-prompt";
import { CodexWorking } from "@/components/brainless/codex/codex-working";
import { GrokHeader } from "@/components/brainless/grok/grok-header";
import { GrokMessage } from "@/components/brainless/grok/grok-message";
import { GrokPermission } from "@/components/brainless/grok/grok-permission";
import { GrokPrompt } from "@/components/brainless/grok/grok-prompt";
import { GrokThinking } from "@/components/brainless/grok/grok-thinking";
import { GrokTool } from "@/components/brainless/grok/grok-tool";
import { Markdown } from "@/components/markdown";
import {
  ACTIVE_STATUSES,
  type Block,
  type ChatMessage,
  type Interaction,
} from "@/queries/chat";

// Each theme is laid out like its brainless session block
// (components/brainless/blocks): header, turn, working line, composer.
export type SessionTheme = "claude" | "codex" | "grok";
type Activity = Extract<Block, { type: "activity" }>;
type MessageProps = {
  role?: "user" | "assistant";
  time?: string;
  children: React.ReactNode;
};
type ChoiceProps = {
  prompt: string;
  labels: string[];
  onChoose: (index: number) => void;
};

const activityText = { running: "进行中", completed: "完成", failed: "失败" };
const workingLabel: Partial<Record<ChatMessage["status"], string>> = {
  queued: "排队中",
  responding: "工作中",
  waiting_for_input: "工作中",
  stopping: "正在停止",
};

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
        tool={block.label}
        result={activityText[block.status]}
        status={
          block.status === "running"
            ? "pending"
            : block.status === "completed"
              ? "success"
              : "error"
        }
      />
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
        command={block.label}
        status={
          block.status === "running"
            ? "run"
            : block.status === "completed"
              ? "ok"
              : "error"
        }
      />
    ),
    Choice: ({ prompt, labels, onChoose }: ChoiceProps) => (
      <CodexPermissions
        title={prompt}
        options={labels.map((label) => ({ label, description: "" }))}
        onChoose={onChoose}
      />
    ),
    Working: ({ label }: { label: string }) => <CodexWorking label={label} />,
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
      <GrokTool verb={block.label} meta={activityText[block.status]} />
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
  },
};

/** The blocks' warning line (`⚠ …`). */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="text-[var(--terminal-warning)]">
      <span aria-hidden>⚠ </span>
      {children}
    </div>
  );
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatPanel({
  theme,
  agentName,
  messages,
  interactions,
  draft,
  onDraftChange: setDraft,
  onSend,
  onStop,
  onAnswer,
  head,
  error,
}: {
  theme: SessionTheme;
  agentName: string | undefined;
  /** The conversation with the current agent. */
  messages: ChatMessage[];
  interactions: Interaction[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop: (replyId: string) => void;
  onAnswer: (interactionId: string, value: string) => void;
  /** Shows and switches the agent being talked to. */
  head?: React.ReactNode;
  error?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const session = sessions[theme];
  const { Message, Activity, Choice, Working } = session;
  const last = messages.at(-1);
  const active = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        ACTIVE_STATUSES.has(message.status) &&
        message.status !== "stopping",
    );
  useEffect(() => {
    if (last) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [last?.id, last?.revision, last]);

  function send() {
    if (!draft.trim()) return;
    onSend(draft);
    formRef.current?.querySelector("input")?.focus();
  }
  const promptProps = {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
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
  };
  const model = agentName ?? "未选择智能体";

  return (
    <section
      aria-label="对话"
      data-session-theme={theme}
      className="relative flex h-full min-h-0 flex-col bg-[var(--terminal-background)]"
    >
      {head}
      {/* Top padding keeps the floating agent card off the first lines. */}
      <div
        className={`min-h-0 flex-1 space-y-3 overflow-y-auto pt-14 font-mono text-[13px] leading-[1.6] ${session.textClass}`}
      >
        {theme === "claude" ? (
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
        <div
          className={session.turnClass}
          role="log"
          aria-label="对话消息"
          aria-live="polite"
        >
          {messages.map((message) => {
            const timeLabel =
              theme === "grok" ? time(message.created_at) : undefined;
            if (message.role === "user")
              return (
                <Message key={message.id} role="user" time={timeLabel}>
                  <span className="whitespace-pre-wrap">
                    {message.blocks.map((block) =>
                      block.type === "text" ? block.text : null,
                    )}
                  </span>
                </Message>
              );
            const pending = interactions.filter(
              (interaction) =>
                interaction.message_id === message.id &&
                interaction.status === "pending",
            );
            const working = workingLabel[message.status];
            return (
              <div key={message.id} className={session.turnClass}>
                {message.blocks.map((block) =>
                  block.type === "text" ? (
                    <Message key={block.id} time={timeLabel}>
                      <Markdown>{block.text}</Markdown>
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
                      onAnswer(interaction.id, interaction.options[index].value)
                    }
                  />
                ))}
                {working && pending.length === 0 ? (
                  <Working label={working} />
                ) : null}
                {message.status === "stopped" ? (
                  <Warning>已停止</Warning>
                ) : null}
                {message.status === "failed" ? (
                  <Warning>{message.failure?.message ?? "回复失败。"}</Warning>
                ) : null}
              </div>
            );
          })}
        </div>
        <div ref={endRef} />
      </div>
      <form
        ref={formRef}
        className={`shrink-0 ${session.promptClass}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
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
      </form>
    </section>
  );
}
