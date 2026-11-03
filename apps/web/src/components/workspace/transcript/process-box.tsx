import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TranscriptDialog } from "./transcript-dialog";

/**
 * A reply's process (thinking and tool calls) in a group. While the agent still works it is the
 * same stacked steps in a fixed-height frame that scrolls inside itself, so a long run does not
 * push the conversation away; the frame follows its newest step, unless the reader scrolled up
 * inside it, and follows again back at the bottom. Once the reply reaches its final text (always,
 * for a finished one) the frame folds into one "thinking process" row that opens in place.
 * "View more" opens the whole process, with the answer, in the same fixed frame a task run's log
 * is read in.
 */
export function ProcessBox({
  steps,
  count,
  running,
  folded,
  author,
  time,
  answer,
}: {
  /** The thinking blocks and tool cards, in order. */
  steps: React.ReactNode;
  /** How many steps there are: a new one is what the frame follows. 0 before the first one. */
  count: number;
  running: boolean;
  /** The reply is at its final text: the process folds into one "thinking process" row. */
  folded: boolean;
  author?: string | undefined;
  time: string;
  /** The reply's text, shown under the whole process in the dialog. */
  answer: React.ReactNode;
}) {
  const { t: translateText } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Glued to the newest step; same 16px slack as a stray wheel tick.
  const pinned = useRef(true);

  function follow() {
    const box = boxRef.current;
    if (box && running && pinned.current) box.scrollTop = box.scrollHeight;
  }
  useLayoutEffect(follow, [count, running]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  });

  const viewAll = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      // Nothing to view yet (before the first step): kept in place, so the first step moves nothing.
      className={cn("text-muted-foreground", count === 0 && "invisible")}
      onClick={() => setOpen(true)}
    >
      {translateText("process.viewAll")}
    </Button>
  );

  return (
    <>
      {folded ? (
        <details className="process-fold">
          <summary className="thinking-block-header">
            <span aria-hidden="true" className="thinking-block-chevron">
              ▶
            </span>
            {translateText("process.fold")}
            <span className="ml-auto">
              {translateText("process.steps", { count })}
            </span>
          </summary>
          <div className="process-fold-body">{steps}</div>
          <div className="flex justify-end">{viewAll}</div>
        </details>
      ) : (
        <div className="flex flex-col items-end">
          <div
            ref={boxRef}
            role="region"
            tabIndex={0}
            aria-label={translateText("process.label", {
              name: author ?? "",
            })}
            className="process-box w-full"
            onScroll={(event) => {
              const box = event.currentTarget;
              pinned.current =
                box.scrollHeight - box.scrollTop - box.clientHeight < 16;
            }}
          >
            <div ref={contentRef}>{steps}</div>
          </div>
          {viewAll}
        </div>
      )}
      <TranscriptDialog
        open={open}
        onOpenChange={setOpen}
        title={author ?? translateText("process.title")}
        meta={<time>{time}</time>}
        description={translateText("process.title")}
        quietDescription
        bodyClassName="message assistant"
      >
        {steps}
        {answer}
      </TranscriptDialog>
    </>
  );
}
