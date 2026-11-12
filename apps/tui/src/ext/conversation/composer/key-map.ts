/** Which composer command a key press from Ink's `useInput` is, apart from the bound actions. */
import type { Key } from "ink";
import type { ComposerCommand } from "./keys";

/** Ctrl+letter edits, as readline has them. */
const CTRL_COMMANDS: Partial<
  Record<
    string,
    | "lineStart"
    | "lineEnd"
    | "deleteToLineStart"
    | "deleteToLineEnd"
    | "deleteWord"
  >
> = {
  a: "lineStart",
  e: "lineEnd",
  u: "deleteToLineStart",
  k: "deleteToLineEnd",
  w: "deleteWord",
};

const withModifier = (key: Key) => key.ctrl || key.meta || key.shift;

function isPrintable(input: string): boolean {
  return (
    input !== "" &&
    [...input].every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

/**
 * The command for a key, or undefined for a key the composer leaves alone. Arrows, Home and End
 * with a modifier are left to the screen's own bindings (switching tabs, scrolling).
 */
export function commandForKey(
  input: string,
  key: Key,
): ComposerCommand | undefined {
  if (key.return) return { kind: "enter" };
  if (key.tab) return { kind: "tab" };
  if (key.escape) return { kind: "escape" };
  if (key.backspace) return { kind: "backspace" };
  if (key.delete) return { kind: "delete" };
  if (
    key.leftArrow ||
    key.rightArrow ||
    key.upArrow ||
    key.downArrow ||
    key.home ||
    key.end
  ) {
    if (withModifier(key)) return undefined;
    if (key.leftArrow) return { kind: "left" };
    if (key.rightArrow) return { kind: "right" };
    if (key.upArrow) return { kind: "up" };
    if (key.downArrow) return { kind: "down" };
    return { kind: key.home ? "rowStart" : "rowEnd" };
  }
  if (key.ctrl) {
    const kind = CTRL_COMMANDS[input];
    return kind === undefined ? undefined : { kind };
  }
  if (key.meta || key.pageUp || key.pageDown) return undefined;
  return isPrintable(input) ? { kind: "insert", text: input } : undefined;
}
