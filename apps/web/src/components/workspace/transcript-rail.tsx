import { useTranslation } from "react-i18next";
import { preview, railRows } from "@/lib/rail";
import { cn } from "@/lib/utils";

/**
 * The two lanes down the right edge of a conversation.
 *
 * Squares are what the agents said, circles are what you said. They are two lanes because a
 * conversation has two clocks: one prompt can set off sixty replies, and a rail that mixed them
 * would give that prompt a number sixty turns long.
 *
 * Each handful of rows is `lib/rail.ts`'s arithmetic: the first and last turn, five anchors evenly
 * spread between them, and a window around what is on screen — with `⋯` carrying the count of what
 * was skipped. The current entry is lit, and the rail scrolls itself so the light stays visible.
 */
export interface RailEntry {
  id: string;
  /** The words to show in the tooltip; cut to 44 characters. */
  text?: string | undefined;
}

export function TranscriptRail({
  replies,
  prompts,
  activeId,
  onJump,
}: {
  replies: readonly RailEntry[];
  prompts: readonly RailEntry[];
  activeId: string | undefined;
  onJump: (id: string) => void;
}) {
  const { t: translateText } = useTranslation("chat");
  const replyRows = railRows(
    replies.length,
    replies.findIndex((entry) => entry.id === activeId),
  );
  const promptRows = railRows(
    prompts.length,
    prompts.findIndex((entry) => entry.id === activeId),
  );
  if (replyRows.length === 0 && promptRows.length === 0) return null;

  const lane = (
    entries: readonly RailEntry[],
    rows: ReturnType<typeof railRows>,
    shape: "square" | "round",
    label: string,
  ) => (
    <div
      aria-label={label}
      className="no-scrollbar flex max-h-[60vh] flex-col items-end gap-[3px] overflow-y-auto overscroll-contain pr-1 pb-1"
    >
      {rows.map((row, at) =>
        row.index === undefined ? (
          <span
            key={`skip-${at}`}
            title={translateText("rail.skipped", { count: row.skipped })}
            className="px-1 font-mono text-[8px] leading-4 text-faint"
          >
            ⋯
          </span>
        ) : (
          <button
            key={entries[row.index!]!.id}
            type="button"
            aria-current={entries[row.index]!.id === activeId}
            title={`${row.index! + 1} · ${preview(entries[row.index!]!.text)}`}
            onClick={() => onJump(entries[row.index!]!.id)}
            className={cn(
              "h-4 min-w-4 border px-1 font-mono text-[9px] leading-4 tabular-nums",
              shape === "round"
                ? "rounded-full border-border-strong"
                : "border-border",
              entries[row.index!]!.id === activeId
                ? "border-foreground bg-foreground text-background"
                : "bg-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {row.index! + 1}
          </button>
        ),
      )}
    </div>
  );

  return (
    <div className="sticky top-16 flex shrink-0 flex-row items-start gap-1 self-start">
      {replyRows.length > 0
        ? lane(replies, replyRows, "square", translateText("rail.replies"))
        : null}
      {promptRows.length > 0
        ? lane(prompts, promptRows, "round", translateText("rail.prompts"))
        : null}
    </div>
  );
}
