import { bareCode, codeBlock } from "./plugins/code-block";
import { pasteBlock } from "./plugins/paste-block";
import { pictures } from "./plugins/picture";
import { richText } from "./plugins/rich-text";
import { createTextSystem } from "./text-system";

/**
 * The text of a chat: formatted (Markdown as you type), long pastes folded, code from an editor
 * as a code block; shown, its pictures as Settings › Appearance says. Each place adds its own:
 * mentions and files in the composer, neither in the insert popover; a sent message its mentions
 * (`shownMentions`) and files (`shownFiles`); `@` for the task's agents in a task's comment box.
 */
export const chatText = createTextSystem([
  richText(),
  codeBlock(),
  pasteBlock(),
  pictures(),
]);

/**
 * A task's description: formatted, code as code. No folded pastes: a description is kept as its
 * Markdown alone (nowhere to keep where a paste was), so a paste goes in as the text it is.
 */
export const descriptionText = createTextSystem([richText(), codeBlock()]);

/**
 * Code shown on its own (a tool call's input): one fenced block, highlighted as the chat's code
 * blocks are, with their Copy, in a frame of the place's own (which scrolls it when it is long).
 */
export const codeText = createTextSystem([richText(), codeBlock(), bareCode()]);
