import { codeBlock } from "./plugins/code-block";
import { pasteBlock } from "./plugins/paste-block";
import { richText } from "./plugins/rich-text";
import { createTextSystem } from "./text-system";

/**
 * The text of a chat: formatted (Markdown as you type), long pastes folded, code from an editor
 * as a code block. Each place adds its own: mentions and files in the composer, neither in the
 * insert popover.
 */
export const chatText = createTextSystem([
  richText(),
  codeBlock(),
  pasteBlock(),
]);
