import type { Key } from "ink";
import type { KeyBinding, NamedKey } from "../config/types";

const NAMED_KEY_FLAGS: Record<NamedKey, (input: string, key: Key) => boolean> =
  {
    left: (_, key) => key.leftArrow,
    right: (_, key) => key.rightArrow,
    up: (_, key) => key.upArrow,
    down: (_, key) => key.downArrow,
    escape: (_, key) => key.escape,
    enter: (_, key) => key.return,
    tab: (_, key) => key.tab,
    backspace: (_, key) => key.backspace,
    delete: (_, key) => key.delete,
    pageup: (_, key) => key.pageUp,
    pagedown: (_, key) => key.pageDown,
    home: (_, key) => key.home,
    end: (_, key) => key.end,
    space: (input) => input === " ",
  };

function isNamedKey(key: string): key is NamedKey {
  return Object.hasOwn(NAMED_KEY_FLAGS, key);
}

/**
 * Whether one key press from Ink's `useInput` is the bound key. Every modifier must match
 * exactly; Alt is what Ink reports as `meta`.
 */
export function matchesBinding(
  binding: KeyBinding,
  input: string,
  key: Key,
): boolean {
  if (binding.ctrl !== key.ctrl || binding.alt !== key.meta) return false;
  if (binding.shift !== key.shift) return false;
  if (isNamedKey(binding.key)) return NAMED_KEY_FLAGS[binding.key](input, key);
  return input.toLowerCase() === binding.key;
}
