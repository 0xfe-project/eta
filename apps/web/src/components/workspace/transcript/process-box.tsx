import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * A reply's process (thinking and tool calls) in a group: the same stacked steps, in a fixed-height
 * frame that scrolls inside itself, so a long run does not push the conversation away.
 *
 * While the reply runs the frame follows its newest step, unless the reader scrolled up inside it;
 * back at the bottom it follows again. "View more" opens the whole process, with the answer, in a
 * near-full-screen dialog.
 */
export function ProcessBox({
  steps,
  count,
  running,
  author,
  time,
  answer,
}: {
  /** The thinking blocks and tool cards, in order. */
  steps: React.ReactNode;
  /** How many steps there are: a new one is what the frame follows. */
  count: number;
  running: boolean;
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

  return (
    <>
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
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          {translateText("process.viewAll")}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[3dvh] left-[3vw] flex h-[94dvh] w-[94vw] max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <div className="flex shrink-0 items-baseline gap-2 border-b px-3 py-2 pr-11">
            <DialogTitle className="truncate">
              {author ?? translateText("process.title")}
            </DialogTitle>
            <time className="font-mono text-[10px] text-muted-foreground">
              {time}
            </time>
          </div>
          <DialogDescription className="sr-only">
            {translateText("process.title")}
          </DialogDescription>
          <div className="message assistant min-h-0 flex-1 overflow-y-auto p-3">
            {steps}
            {answer}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
