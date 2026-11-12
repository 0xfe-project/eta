import type { KeyBinding, NamedKey } from "./types";
import { NAMED_KEYS } from "./types";

const MODIFIERS = ["ctrl", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

const isModifier = (part: string): part is Modifier =>
  (MODIFIERS as readonly string[]).includes(part);

const isNamedKey = (part: string): part is NamedKey =>
  (NAMED_KEYS as readonly string[]).includes(part);

/** One character that shows something: not whitespace, not a control character. */
function isPrintableCharacter(part: string): boolean {
  return [...part].length === 1 && !/[\s\p{Cc}]/u.test(part);
}

/**
 * Read a binding such as `alt+left` or `Ctrl+Shift+R`: up to three distinct modifiers (`ctrl`,
 * `alt`, `shift`, any order, any case) and one key, a `NAMED_KEYS` name or one printable
 * character. A lone `+` is the plus key, so `ctrl++` binds it. Undefined for anything else.
 */
export function parseKeyBinding(text: string): KeyBinding | undefined {
  const lower = text.toLowerCase();
  const { modifierParts, key } = splitKey(lower);
  if (key === "" || isModifier(key)) return undefined;
  if (!isNamedKey(key) && !isPrintableCharacter(key)) return undefined;
  const seen = new Set<Modifier>();
  for (const part of modifierParts) {
    if (!isModifier(part) || seen.has(part)) return undefined;
    seen.add(part);
  }
  return {
    key,
    ctrl: seen.has("ctrl"),
    alt: seen.has("alt"),
    shift: seen.has("shift"),
  };
}

// `+` joins the parts and is also a key, so a trailing `++` (or the whole text `+`) is the
// plus key and everything before it is modifiers.
function splitKey(text: string): { modifierParts: string[]; key: string } {
  if (text === "+") return { modifierParts: [], key: "+" };
  if (text.endsWith("++")) {
    const before = text.slice(0, -2);
    return {
      modifierParts: before === "" ? [""] : before.split("+"),
      key: "+",
    };
  }
  const parts = text.split("+");
  return { modifierParts: parts.slice(0, -1), key: parts.at(-1) ?? "" };
}

/** The canonical text of a binding: `ctrl`, `alt`, `shift` in that order, then the key. */
export function formatKeyBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("ctrl");
  if (binding.alt) parts.push("alt");
  if (binding.shift) parts.push("shift");
  parts.push(binding.key);
  return parts.join("+");
}
