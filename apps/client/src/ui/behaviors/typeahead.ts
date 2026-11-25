import type { KeyEvent } from "nsh";
import { cleanup } from "nsh";

interface TypeaheadItem<T extends string = string> {
  id: T;
  label: string;
  disabled?: boolean;
}

interface TypeaheadOptions<T extends string = string> {
  items: () => readonly TypeaheadItem<T>[];
  activeId?: () => T | undefined;
  timeoutMs?: number;
  onMatch: (id: T) => void;
}

/**
 * Timed prefix-matching keyboard typeahead behavior for Menus, Selects, and Listboxes.
 */
export function createTypeahead<T extends string = string>(
  options: TypeaheadOptions<T>,
) {
  const timeoutMs = options.timeoutMs ?? 500;
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  function reset() {
    buffer = "";
    clearTimeout(timer);
    timer = undefined;
  }

  cleanup(reset);

  function match(char: string): T | undefined {
    const query = (buffer + char).toLowerCase();
    buffer = query;
    clearTimeout(timer);
    timer = setTimeout(reset, timeoutMs);

    const enabled = options.items().filter((item) => !item.disabled);
    if (enabled.length === 0) return undefined;

    const current = options.activeId?.();
    const currentIndex = enabled.findIndex((item) => item.id === current);
    // Start searching after the active item when typing a single character repeatedly.
    const start =
      query.length === 1 && currentIndex >= 0
        ? (currentIndex + 1) % enabled.length
        : 0;

    for (let offset = 0; offset < enabled.length; offset++) {
      const item = enabled[(start + offset) % enabled.length]!;
      if (item.label.toLowerCase().startsWith(query)) {
        options.onMatch(item.id);
        return item.id;
      }
    }
    return undefined;
  }

  function onKeyDown(event: KeyEvent): boolean {
    if (
      event.modifiers.control ||
      event.modifiers.platform ||
      event.modifiers.alt ||
      event.key.length !== 1 ||
      event.key === " "
    )
      return false;
    return match(event.key) !== undefined;
  }

  return { onKeyDown, match, reset };
}
