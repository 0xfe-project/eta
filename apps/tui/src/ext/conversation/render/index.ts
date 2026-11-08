import type {
  AuthorDrawing,
  AuthorItem,
  RenderedItem,
  RenderOptions,
  TranscriptItem,
} from "../contract";
import type { DrawContext, DrawnItem } from "./context";
import { createElement } from "react";
import { MarkdownDisplay } from "../../../ui/gemini/markdown-display";
import { contextFor } from "./context";
import { drawSummary, drawThinking } from "./folded-text";
import { drawAuthor, drawNotice, drawOutcome } from "./labels";
import { draw, trimBlank } from "./lines";
import { drawSteps } from "./steps";
import { drawTool } from "./tool";
import { drawUser } from "./user";

/**
 * Draws one transcript item into lines no wider than `options.width`, without blank lines at
 * either end; an author with the style of the frame its reply is drawn in.
 */
export function renderItem(
  item: AuthorItem,
  options: RenderOptions,
): AuthorDrawing;
export function renderItem(
  item: TranscriptItem,
  options: RenderOptions,
): RenderedItem;
export function renderItem(
  item: TranscriptItem,
  options: RenderOptions,
): RenderedItem {
  const context = contextFor(options);
  if (item.kind === "author") {
    const drawn = drawAuthor(item, context);
    return { ...finished(drawn), frame: drawn.frame };
  }
  return finished(drawItem(item, context));
}

function finished(drawn: DrawnItem): RenderedItem {
  const lines = trimBlank(drawn.lines);
  return {
    lines: lines.styled,
    plain: lines.plain,
    source: drawn.source,
    foldable: drawn.foldable,
  };
}

/** Every item but an author, which `renderItem` draws itself. */
function drawItem(
  item: Exclude<TranscriptItem, AuthorItem>,
  context: DrawContext,
): DrawnItem {
  switch (item.kind) {
    case "user":
      return drawUser(item, context);
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
    case "steps":
      return drawSteps(item, context);
    case "outcome":
      return drawOutcome(item, context);
    case "summary":
      return drawSummary(item, context);
    case "notice":
      return drawNotice(item, context);
  }
}
