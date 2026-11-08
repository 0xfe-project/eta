import type { RenderedItem, RenderItem, TranscriptItem } from "../contract";
import type { DrawContext, DrawnItem } from "./context";
import { createElement } from "react";
import { MarkdownDisplay } from "../../../ui/gemini/markdown-display";
import { contextFor } from "./context";
import { drawSummary, drawThinking } from "./folded-text";
import { drawAuthor, drawNotice, drawOutcome } from "./labels";
import { draw, trimBlank } from "./lines";
import { drawTool } from "./tool";
import { drawUser } from "./user";

/** Draws one transcript item into lines no wider than `options.width`, without blank lines at either end. */
export const renderItem: RenderItem = (item, options): RenderedItem => {
  const drawn = drawItem(item, contextFor(options));
  const lines = trimBlank(drawn.lines);
  return {
    lines: lines.styled,
    plain: lines.plain,
    source: drawn.source,
    foldable: drawn.foldable,
  };
};

function drawItem(item: TranscriptItem, context: DrawContext): DrawnItem {
  switch (item.kind) {
    case "user":
      return drawUser(item, context);
    case "author":
      return drawAuthor(item, context);
    case "thinking":
      return drawThinking(item, context);
    case "text":
      return {
        lines: draw(
          createElement(MarkdownDisplay, {
            text: item.text,
            width: context.width,
            palette: context.palette,
          }),
          context.width,
        ),
        source: item.text,
        foldable: false,
      };
    case "tool":
      return drawTool(item, context);
    case "outcome":
      return drawOutcome(item, context);
    case "summary":
      return drawSummary(item, context);
    case "notice":
      return drawNotice(item, context);
  }
}
