/**
 * What each composer command does: the next state, and what the screen around the composer has
 * to do (send, run a command, stop the reply, open the panel). The component turns key presses
 * into these commands.
 */
import type { PasteRange } from "../contract";
import type { OpenMenu } from "./completion";
import type { ComposerState } from "./state";
import { acceptCompletion } from "./completion";
import {
  breakLineAtBackslash,
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBefore,
  insertText,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveToRowEnd,
  moveToRowStart,
  moveVertically,
} from "./editing";
import { afterSend, historyDown, historyUp } from "./history";
import { outgoing, pasteText } from "./paste";

export type ComposerCommand =
  | { kind: "insert"; text: string }
  | { kind: "paste"; text: string }
  | {
      kind:
        | "left"
        | "right"
        | "up"
        | "down"
        | "rowStart"
        | "rowEnd"
        | "lineStart"
        | "lineEnd"
        | "backspace"
        | "delete"
        | "deleteToLineStart"
        | "deleteToLineEnd"
        | "deleteWord"
        | "enter"
        | "newline"
        | "tab"
        | "escape"
        | "steer"
        | "stop"
        | "panel";
    };

export interface KeyContext {
  /** Columns the text has on screen. */
  columns: number;
  /** An agent in this conversation is replying. */
  replying: boolean;
  /** The completion menu as it shows now; undefined when closed. */
  menu: OpenMenu | undefined;
}

/** What the screen around the composer is asked to do. */
export type ComposerEffect =
  | {
      kind: "send";
      /** The text with pastes expanded, trimmed. */
      text: string;
      pastes: PasteRange[];
      mode: "queue" | "steer";
    }
  | { kind: "command"; line: string }
  | { kind: "stop" }
  | { kind: "panel" };

export interface CommandResult {
  state: ComposerState;
  effect?: ComposerEffect;
}

const isBlank = (state: ComposerState) => state.text.trim() === "";
const isCommandLine = (state: ComposerState) => state.text.startsWith("/");

export function canSteer(state: ComposerState, context: KeyContext): boolean {
  return (
    context.replying &&
    context.menu === undefined &&
    !isBlank(state) &&
    !isCommandLine(state)
  );
}

export function canStop(state: ComposerState, context: KeyContext): boolean {
  return context.replying && context.menu === undefined;
}

export function canOpenPanel(state: ComposerState): boolean {
  return state.text === "";
}

function send(state: ComposerState, mode: "queue" | "steer"): CommandResult {
  return {
    state: afterSend(state),
    effect: { kind: "send", ...outgoing(state), mode },
  };
}

function runLine(state: ComposerState): CommandResult {
  return {
    state: afterSend(state),
    effect: { kind: "command", line: outgoing(state).text },
  };
}

function submit(state: ComposerState): CommandResult {
  const broken = breakLineAtBackslash(state);
  if (broken) return { state: broken };
  if (isBlank(state)) return { state };
  return isCommandLine(state) ? runLine(state) : send(state, "queue");
}

function highlighted(menu: OpenMenu, state: ComposerState) {
  return menu.items[Math.min(state.menu.highlight, menu.items.length - 1)];
}

function accept(state: ComposerState, menu: OpenMenu): CommandResult {
  const item = highlighted(menu, state);
  if (item === undefined) return { state };
  return { state: acceptCompletion(state, menu.query, item) };
}

function enterWithMenu(state: ComposerState, menu: OpenMenu): CommandResult {
  const item = highlighted(menu, state);
  if (item?.kind === "command" && state.text === `/${item.command.name}`)
    return runLine(state);
  return accept(state, menu);
}

function moveHighlight(
  state: ComposerState,
  menu: OpenMenu,
  step: -1 | 1,
): ComposerState {
  const count = menu.items.length;
  const highlight =
    (Math.min(state.menu.highlight, count - 1) + step + count) % count;
  return { ...state, menu: { ...state.menu, highlight } };
}

/** Up: the previous history entry when history takes the key, else the row above. */
function up(state: ComposerState, columns: number): ComposerState {
  return historyUp(state) ?? moveVertically(state, columns, -1) ?? state;
}

/** Down: the next history entry when history takes the key, else the row below. */
function down(state: ComposerState, columns: number): ComposerState {
  return historyDown(state) ?? moveVertically(state, columns, 1) ?? state;
}

export function applyCommand(
  state: ComposerState,
  command: ComposerCommand,
  context: KeyContext,
): CommandResult {
  const { menu, columns } = context;
  switch (command.kind) {
    case "insert":
      return { state: insertText(state, command.text) };
    case "paste":
      return { state: pasteText(state, command.text) };
    case "newline":
      return { state: insertText(state, "\n") };
    case "left":
      return { state: moveLeft(state) };
    case "right":
      return { state: moveRight(state) };
    case "rowStart":
      return { state: moveToRowStart(state, columns) };
    case "rowEnd":
      return { state: moveToRowEnd(state, columns) };
    case "lineStart":
      return { state: moveToLineStart(state) };
    case "lineEnd":
      return { state: moveToLineEnd(state) };
    case "backspace":
      return { state: deleteBackward(state) };
    case "delete":
      return { state: deleteForward(state) };
    case "deleteToLineStart":
      return { state: deleteToLineStart(state) };
    case "deleteToLineEnd":
      return { state: deleteToLineEnd(state) };
    case "deleteWord":
      return { state: deleteWordBefore(state) };
    case "up":
      return {
        state: menu ? moveHighlight(state, menu, -1) : up(state, columns),
      };
    case "down":
      return {
        state: menu ? moveHighlight(state, menu, 1) : down(state, columns),
      };
    case "enter":
      return menu ? enterWithMenu(state, menu) : submit(state);
    case "tab":
      return menu ? accept(state, menu) : { state };
    case "escape":
      return menu
        ? { state: { ...state, menu: { ...state.menu, dismissed: true } } }
        : { state };
    case "steer":
      return canSteer(state, context) ? send(state, "steer") : { state };
    case "stop":
      return canStop(state, context)
        ? { state, effect: { kind: "stop" } }
        : { state };
    case "panel":
      return canOpenPanel(state)
        ? { state, effect: { kind: "panel" } }
        : { state };
  }
}
