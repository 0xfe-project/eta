import { codeBlock } from "./plugins/code-block";
import { pasteBlock } from "./plugins/paste-block";
import { pictures } from "./plugins/picture";
import { plainText } from "./plugins/plain-text";
import { richText } from "./plugins/rich-text";
import { createTextSystem } from "./text-system";

/**
 * The text of a chat: formatted (Markdown as you type), long pastes folded, code from an editor
 * as a code block; shown, its pictures as Settings › Appearance says. Each place adds its own:
 * mentions and files in the composer, neither in the insert popover; a sent message its mentions
 * (`shownMentions`) and files (`shownFiles`).
 */
export const chatText = createTextSystem([
  richText(),
  codeBlock(),
  pasteBlock(),
  pictures(),
]);

/** A task's comment: plain text, long pastes folded. `@` is the place's (the task's agents). */
export const commentText = createTextSystem([plainText(), pasteBlock()]);
