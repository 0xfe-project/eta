import type { TranscriptItem } from "../contract";
import type { DrawContext, DrawnItem } from "./context";
import { Text } from "ink";
import { concat, draw, indent, MARK_WIDTH } from "./lines";

import { countLines, linesLabel } from "./text";

type ThinkingItem = Extract<TranscriptItem, { kind: "thinking" }>;
type SummaryItem = Extract<TranscriptItem, { kind: "summary" }>;

/** A thinking block: one muted line folded; that line and the text under it, muted, unfolded. */
export function drawThinking(
  item: ThinkingItem,
  context: DrawContext,
): DrawnItem {
  const { t } = context;
  const title = item.streaming
    ? t("thinkingStreaming")
    : t("thinking", { lines: linesLabel(countLines(item.text), t) });
  return foldedText(title, item.text, context.colors.muted, context);
}

/** Where a session folded its history: one muted line folded; the summary under it unfolded. */
export function drawSummary(
  item: SummaryItem,
  context: DrawContext,
): DrawnItem {
  const { t } = context;
  const lines = linesLabel(countLines(item.text), t);
  const title =
    item.summary === "branch"
      ? t("branch", { lines })
      : t("compaction", { lines });
  return foldedText(title, item.text, context.colors.text, context);
}

function foldedText(
  title: string,
  text: string,
  bodyColor: string | undefined,
  context: DrawContext,
): DrawnItem {
  const titleLines = draw(
    <Text wrap="wrap" color={context.colors.muted}>
      {title}
    </Text>,
    context.width,
  );
  const hasText = text.trim() !== "";
  const lines =
    context.expanded && hasText
      ? concat(
          titleLines,
          indent(
            draw(
              <Text wrap="wrap" color={bodyColor}>
                {text}
              </Text>,
              context.width - MARK_WIDTH,
            ),
            MARK_WIDTH,
          ),
        )
      : titleLines;
  return { lines, source: text, foldable: hasText };
}
