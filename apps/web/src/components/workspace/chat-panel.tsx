import { ArrowUpIcon } from "@phosphor-icons/react/ArrowUp";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import type { Message } from "./types";

const suggestions = [
  {
    title: "Make a plan",
    prompt: "Help me turn my next project into a clear, actionable plan.",
  },
  {
    title: "Explore an idea",
    prompt: "I'd like to think through an idea with you.",
  },
  {
    title: "Organize my work",
    prompt:
      "Help me organize what I'm working on and decide what to focus on next.",
  },
];

export function ChatPanel({
  messages,
  onSend,
  onNewChat,
}: {
  messages: Message[];
  onSend: (content: string) => void;
  onNewChat: () => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  function send() {
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    setDraft("");
    inputRef.current?.focus();
  }

  return (
    <section
      aria-label="Chat"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-2.5 text-sm font-medium">
          <ChatCircleIcon className="size-4" aria-hidden="true" /> Conversation
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New conversation"
          title="New conversation"
          onClick={() => {
            onNewChat();
            setDraft("");
            inputRef.current?.focus();
          }}
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-6 py-8"
        role="log"
        aria-label="Conversation messages"
        aria-live="polite"
      >
        <div
          className="mb-8 flex size-9 items-center justify-center border border-foreground text-sm font-medium"
          aria-hidden="true"
        >
          a.
        </div>
        <h2 className="text-2xl font-medium leading-tight tracking-tight">
          A little space
          <br />
          to think things through.
        </h2>
        <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
          Hi Eric. Bring an idea, a question, or a messy to-do list. Start
          wherever you are.
        </p>
        {messages.length === 0 ? (
          <div className="mt-8 space-y-2">
            <p className="mb-3 text-xs text-muted-foreground">
              A few places to start
            </p>
            {suggestions.map(({ title, prompt }) => (
              <button
                key={title}
                onClick={() => {
                  setDraft(prompt);
                  inputRef.current?.focus();
                }}
                className="flex w-full items-center justify-between border border-border px-3.5 py-3 text-left text-sm transition-colors hover:bg-muted"
              >
                {title}
                <ArrowUpRightIcon
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-8 space-y-5">
            {messages.map((message) => (
              <article
                key={message.id}
                className="border-l-2 border-foreground bg-muted/50 px-4 py-3"
              >
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  You
                </p>
                <Markdown>{message.content}</Markdown>
              </article>
            ))}
            <p className="text-xs leading-5 text-muted-foreground">
              Your message is saved in this preview. Agent replies will be
              available once a runtime is connected.
            </p>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="shrink-0 p-4 pt-2 sm:p-5 sm:pt-2">
        <form
          className="border border-input bg-background transition-colors focus-within:border-foreground/50"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label htmlFor="message" className="sr-only">
            Message
          </label>
          <Textarea
            id="message"
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="Ask anything, or think out loud…"
            maxLength={10_000}
            className="min-h-24 max-h-48 resize-none border-0 bg-transparent px-3 py-3 text-sm focus-visible:ring-0 dark:bg-transparent md:text-sm"
          />
          <div className="flex items-center justify-between px-3 pb-3">
            <span className="text-xs text-muted-foreground">Local preview</span>
            <Button
              type="submit"
              size="icon"
              disabled={!draft.trim()}
              aria-label="Send message"
            >
              <ArrowUpIcon aria-hidden="true" />
            </Button>
          </div>
        </form>
        <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
          Enter to send · Shift + Enter for a new line
        </p>
      </div>
    </section>
  );
}
