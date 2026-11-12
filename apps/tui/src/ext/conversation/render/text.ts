import type { Translate } from "../../../i18n/messages";
import type { RunImage } from "../model/run";
import type { RenderMessageKey } from "./messages";
import { withoutAnsi } from "../model/tool-shape";

const KIB = 1024;
const MIB = 1024 * 1024;
const TAB_SPACES = "    ";

/** How many lines a text has; one newline at the end does not start another. */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/** "1 line", "3 lines", in the reader's language. */
export function linesLabel(
  count: number,
  t: Translate<RenderMessageKey>,
): string {
  return count === 1 ? t("oneLine") : t("lines", { count });
}

/** A byte count in KB below a megabyte and in MB from there, with at most one decimal. */
export function formatSize(bytes: number): string {
  const [value, unit] = bytes < MIB ? [bytes / KIB, "KB"] : [bytes / MIB, "MB"];
  return `${Number(value.toFixed(1))} ${unit}`;
}

/* eslint-disable no-control-regex -- these match terminal control characters on purpose */
// A string sequence's body stops at whatever could start or end another sequence and at a line
// break, so a body that never ends is read once, up to that stop, and takes no line after it.
const STRING_SEQUENCE =
  /(?:\u001B[\]PX^_]|[\u0090\u0098\u009D-\u009F])[^\u0007\u001B\u009C\u0090\u0098\u009D-\u009F\n]*(?:\u0007|\u001B\\|\u009C)/g;
const OSC_OPENING = /\u001B\]/g;
const C1_CONTROL_SEQUENCE = /\u009B[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g;
const ESCAPE_SEQUENCE = /\u001B[\x20-\x2F]*[\x30-\x7E]?/g;
const LONE_CONTROL = /[\u0000-\u0008\v\f\u000E-\u001F\u007F-\u009F]/g;
/* eslint-enable no-control-regex */

/**
 * The text without terminal control sequences or control characters other than tab, line feed
 * and carriage return. A string sequence (OSC, DCS and the like) ends at BEL or ST, whichever
 * comes first, so the words after it stay. One not ended before the next line break or the next
 * escape loses only its opening.
 */
function withoutControls(text: string): string {
  // An OSC opening left after the first pass belongs to one that never ends. It goes before
  // `withoutAnsi`, which would read on from it to the next BEL anywhere after.
  const withoutStrings = text
    .replace(STRING_SEQUENCE, "")
    .replace(OSC_OPENING, "")
    .replace(C1_CONTROL_SEQUENCE, "");
  return withoutAnsi(withoutStrings)
    .replace(ESCAPE_SEQUENCE, "")
    .replace(LONE_CONTROL, "");
}

/**
 * What a program printed, as it reads on a terminal: no colour or cursor codes or other control
 * sequences, a carriage return overwriting the line it is on (a progress bar leaves its last
 * state), tabs as spaces.
 */
export function terminalText(output: string): string {
  return withoutControls(output)
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => lastWrite(line).replaceAll("\t", TAB_SPACES))
    .join("\n");
}

/** What is left of a line after each carriage return wrote over it; a bare return at the end erases nothing. */
function lastWrite(line: string): string {
  const writes = line.split("\r").filter((write) => write !== "");
  return writes.at(-1) ?? "";
}

/** `[image] <type> · <size>`; the size only when the view says it. */
export function imageLabel(
  image: RunImage,
  t: Translate<RenderMessageKey>,
): string {
  const size = image.bytes === undefined ? "" : ` · ${formatSize(image.bytes)}`;
  return `${t("image")} ${image.mimeType}${size}`;
}
