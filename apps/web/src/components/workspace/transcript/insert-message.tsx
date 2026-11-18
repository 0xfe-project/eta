import type { KeyboardEvent } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { randomUUID } from "@/lib/random-uuid";
import { useInsert } from "@/queries/conversations";

/** What was typed into a message's insert and not sent, by message: closing keeps it. */
const useInsertDrafts = create<{ drafts: Record<string, string> }>(() => ({
  drafts: {},
}));
const setInsertDraft = (messageId: string, text: string) =>
  useInsertDrafts.setState((state) => {
    const drafts = { ...state.drafts, [messageId]: text };
    if (text === "") delete drafts[messageId];
    return { drafts };
  });

/**
 * "Insert", under one of your messages while it is being answered: a small box over the
 * conversation that puts more words into the turns answering it, every one of them. The words go
 * to the host with the message's id (`conversations.send`'s `into`); they show as part of that
 * message, and in the process window of each turn that took them. If the turns ended before the
 * words got there, they are sent as a message of their own and a toast says so.
 *
 * ⏎ sends, ⇧⏎ is a new line, Esc or a click outside closes, and what was typed stays for next time.
 */
export function InsertMessage({
  conversationId,
  messageId,
  agentIds,
  names,
}: {
  conversationId: string;
  messageId: string;
  /** The agents answering the message. */
  agentIds: readonly string[];
  /** Their names, as one phrase. */
  names: string;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const [open, setOpen] = useState(false);
  const draft = useInsertDrafts((state) => state.drafts[messageId] ?? "");
  const insert = useInsert();
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // A few lines high, and taller as the words need it.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [draft, open]);

  function send() {
    const text = draft.trim();
    if (text === "") return;
    setInsertDraft(messageId, "");
    setOpen(false);
    insert.mutate(
      {
        conversationId,
        text,
        into: messageId,
        mode: "steer",
        mentions: [...agentIds],
        clientId: randomUUID(),
      },
      {
        onSuccess: (result) => {
          if (result.message.data.into !== messageId)
            toast.message(translateText("insert.ended"));
        },
        onError: (error) => {
          // Not sent: the words go back where they were typed.
          setInsertDraft(messageId, text);
          toast.error(error.message);
        },
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // An Enter that finishes an input method's word is the input method's.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="message-insert-btn font-mono text-[10px] tracking-[0.1em] uppercase"
          data-open={open}
        >
          {translateText("insert.action")}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 gap-0 p-0"
        aria-label={translateText("insert.title")}
      >
        <textarea
          ref={boxRef}
          rows={3}
          value={draft}
          autoFocus
          aria-label={translateText("insert.title")}
          placeholder={translateText("insert.placeholder")}
          onChange={(event) => setInsertDraft(messageId, event.target.value)}
          onKeyDown={onKeyDown}
          className="m-2 max-h-60 min-h-[4.5rem] resize-none border border-border bg-transparent px-2 py-1.5 text-sm leading-normal outline-none placeholder:text-faint focus-visible:border-ring"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2 text-[11px] text-faint">
          <span className="min-w-0 truncate">
            {translateText("insert.to", { names })}
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={draft.trim() === ""}
            onClick={send}
          >
            {translateText("insert.send")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
