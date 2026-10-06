import { useEffect, useRef } from "react";
import { ClaudeHeader } from "@/components/brainless/claude/claude-header";
import { ClaudeMessage } from "@/components/brainless/claude/claude-message";
import { ClaudePermission } from "@/components/brainless/claude/claude-permission";
import { ClaudePrompt } from "@/components/brainless/claude/claude-prompt";
import { ClaudeToolCall } from "@/components/brainless/claude/claude-tool-call";
import { CodexExec } from "@/components/brainless/codex/codex-exec";
import { CodexHeader } from "@/components/brainless/codex/codex-header";
import { CodexMessage } from "@/components/brainless/codex/codex-message";
import { CodexPrompt } from "@/components/brainless/codex/codex-prompt";
import { CodexWorking } from "@/components/brainless/codex/codex-working";
import { GrokHeader } from "@/components/brainless/grok/grok-header";
import { GrokMessage } from "@/components/brainless/grok/grok-message";
import { GrokPermission } from "@/components/brainless/grok/grok-permission";
import { GrokPrompt } from "@/components/brainless/grok/grok-prompt";
import { GrokTool } from "@/components/brainless/grok/grok-tool";
import { Markdown } from "@/components/markdown";
import {
  ACTIVE_STATUSES,
  type Agent,
  type Block,
  type ChatMessage,
  type Interaction,
} from "@/queries/chat";

export type SessionTheme = "claude" | "codex" | "grok";
const messageComponents = {
  claude: ClaudeMessage,
  codex: CodexMessage,
  grok: GrokMessage,
};
const activityText = { running: "进行中", completed: "完成", failed: "失败" };

function Activity({
  theme,
  block,
}: {
  theme: SessionTheme;
  block: Extract<Block, { type: "activity" }>;
}) {
  if (theme === "claude")
    return (
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
    );
  if (theme === "codex")
    return (
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
    );
  return <GrokTool verb={block.label} meta={activityText[block.status]} />;
}

function Choice({
  theme,
  interaction,
  onAnswer,
}: {
  theme: SessionTheme;
  interaction: Interaction;
  onAnswer: (id: string, value: string) => void;
}) {
  if (interaction.status === "submitted")
    return (
      <p className="font-mono text-[13px] text-[var(--terminal-muted)]">
        已提交，等待智能体继续…
      </p>
    );
  if (interaction.status !== "pending") return null;
  const labels = interaction.options.map((option) => option.label);
  const choose = (index: number) =>
    onAnswer(interaction.id, interaction.options[index].value);
  return theme === "grok" ? (
    <GrokPermission
      title="需要确认"
      command={interaction.prompt}
      options={labels}
      onChoose={choose}
    />
  ) : (
    <ClaudePermission
      title="需要确认"
      command={interaction.prompt}
      question="是否继续？"
      options={labels}
      onChoose={choose}
    />
  );
}

function ReplyStatus({
  theme,
  reply,
  onStop,
}: {
  theme: SessionTheme;
  reply: ChatMessage;
  onStop: (id: string) => void;
}) {
  const muted = "font-mono text-[13px] text-[var(--terminal-muted)]";
  if (reply.status === "failed")
    return (
      <p
        role="alert"
        className="font-mono text-[13px] text-[var(--terminal-error)]"
      >
        {reply.failure?.message ?? "回复失败。"}
      </p>
    );
  if (reply.status === "stopped") return <p className={muted}>已停止</p>;
  if (!ACTIVE_STATUSES.has(reply.status)) return null;
  const stop =
    reply.status === "stopping" ? null : (
      <button
        type="button"
        onClick={() => onStop(reply.id)}
        className="text-[var(--terminal-link)] underline-offset-2 hover:underline"
      >
        停止
      </button>
    );
  const label =
    reply.status === "queued"
      ? "等待中"
      : reply.status === "stopping"
        ? "正在停止"
        : reply.status === "waiting_for_input"
          ? "等待确认"
          : "正在回复";
  return (
    <div className={`flex items-baseline gap-3 ${muted}`}>
      {theme === "codex" && reply.status === "responding" ? (
        <CodexWorking label={label} />
      ) : (
        <span role="status">{label}…</span>
      )}
      {stop}
    </div>
  );
}

export function ChatPanel({
  theme,
  agents,
  agentName,
  messages,
  interactions,
  draft,
  onDraftChange: setDraft,
  onSend,
  onStop,
  onAnswer,
  notice,
}: {
  theme: SessionTheme;
  agents: Agent[];
  agentName: string | undefined;
  messages: ChatMessage[];
  interactions: Interaction[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop: (replyId: string) => void;
  onAnswer: (interactionId: string, value: string) => void;
  notice?: React.ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const SessionMessage = messageComponents[theme];
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const last = messages.at(-1);
  useEffect(() => {
    if (last) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [last?.id, last?.revision, last]);

  function send() {
    const content = draft;
    if (!content.trim()) return;
    onSend(content);
    formRef.current?.querySelector("input")?.focus();
  }
  const promptProps = {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
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
      className="flex h-full min-h-0 flex-col bg-[var(--terminal-background)]"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
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
        {notice}
        <div
          className="space-y-3 pt-3"
          role="log"
          aria-label="对话消息"
          aria-live="polite"
        >
          {messages.map((message) =>
            message.role === "user" ? (
              <SessionMessage key={message.id} role="user">
                <span className="sr-only">你：</span>
                <span className="whitespace-pre-wrap">
                  {message.blocks.map((block) =>
                    block.type === "text" ? block.text : null,
                  )}
                </span>
              </SessionMessage>
            ) : (
              <article
                key={message.id}
                aria-label={names.get(message.agent_id) ?? "已删除的智能体"}
                className="space-y-1.5"
              >
                {agents.length > 1 || !names.has(message.agent_id) ? (
                  <p className="font-mono text-[12px] text-[var(--terminal-muted)]">
                    {names.get(message.agent_id) ?? "已删除的智能体"}
                  </p>
                ) : null}
                {message.blocks.map((block) =>
                  block.type === "text" ? (
                    <SessionMessage key={block.id}>
                      <Markdown>{block.text}</Markdown>
                    </SessionMessage>
                  ) : (
                    <Activity key={block.id} theme={theme} block={block} />
                  ),
                )}
                {interactions
                  .filter(
                    (interaction) => interaction.message_id === message.id,
                  )
                  .map((interaction) => (
                    <Choice
                      key={interaction.id}
                      theme={theme}
                      interaction={interaction}
                      onAnswer={onAnswer}
                    />
                  ))}
                <ReplyStatus theme={theme} reply={message} onStop={onStop} />
              </article>
            ),
          )}
        </div>
        <div ref={endRef} />
      </div>
      <form
        ref={formRef}
        className="shrink-0"
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
            showShortcuts={false}
          />
        )}
      </form>
    </section>
  );
}
