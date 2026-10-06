import { ClaudeHeader } from "@/components/brainless/claude/claude-header";
import { CodexHeader } from "@/components/brainless/codex/codex-header";
import { GrokHeader } from "@/components/brainless/grok/grok-header";
import { useEffect, useRef } from "react";
import { ClaudeMessage } from "@/components/brainless/claude/claude-message";
import { ClaudePrompt } from "@/components/brainless/claude/claude-prompt";
import { CodexMessage } from "@/components/brainless/codex/codex-message";
import { CodexPrompt } from "@/components/brainless/codex/codex-prompt";
import { GrokMessage } from "@/components/brainless/grok/grok-message";
import { GrokPrompt } from "@/components/brainless/grok/grok-prompt";
import type { Message } from "./types";

export type SessionTheme = "claude" | "codex" | "grok";
const messageComponents = {
  claude: ClaudeMessage,
  codex: CodexMessage,
  grok: GrokMessage,
};

export function ChatPanel({
  messages,
  draft,
  onDraftChange: setDraft,
  onSend,
  theme,
}: {
  messages: Message[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (content: string) => void;
  theme: SessionTheme;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const SessionMessage = messageComponents[theme];
  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  function send() {
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    setDraft("");
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
    placeholder: "输入消息…",
  };

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
            model="未连接"
            org="AXP"
            cwd="axp"
            tips={[]}
            whatsNew={[]}
          />
        ) : theme === "codex" ? (
          <CodexHeader version="" model="未连接" directory="axp" />
        ) : (
          <GrokHeader version="" headline="AXP" subhead="未连接" />
        )}
        <div
          className="space-y-3 pt-3"
          role="log"
          aria-label="对话消息"
          aria-live="polite"
        >
          {messages.map((message) => (
            <SessionMessage key={message.id} role="user">
              <span className="sr-only">你：</span>
              <span className="whitespace-pre-wrap">{message.content}</span>
            </SessionMessage>
          ))}
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
          <CodexPrompt {...promptProps} model="未连接" directory="axp" />
        ) : (
          <GrokPrompt
            {...promptProps}
            model="未连接"
            mode="normal"
            showShortcuts={false}
          />
        )}
      </form>
    </section>
  );
}
