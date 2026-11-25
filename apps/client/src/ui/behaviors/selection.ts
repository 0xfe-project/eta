import { signal } from "nsh";

interface SelectionOptions<T extends string = string> {
  mode?: "single" | "multiple";
  /** Controlled selection value(s). */
  value?: () => readonly T[];
  defaultValue?: readonly T[];
  onChange?: (next: readonly T[]) => void;
}

/**
 * Atomic single/multi selection state behavior for Tabs, Segmented, Select, List, and Checkbox groups.
 */
export function createSelection<T extends string = string>(
  options: SelectionOptions<T> = {},
) {
  const mode = options.mode ?? "single";
  const own = signal<readonly T[]>(options.defaultValue ?? []);

  const selected = (): readonly T[] =>
    options.value ? options.value() : own();

  function commit(next: readonly T[]) {
    if (!options.value) own.set(next);
    options.onChange?.(next);
  }

  function isSelected(id: T) {
    return selected().includes(id);
  }

  function select(id: T) {
    if (mode === "single") {
      if (selected().length === 1 && selected()[0] === id) return;
      commit([id]);
      return;
    }
    if (isSelected(id)) return;
    commit([...selected(), id]);
  }

  function toggle(id: T) {
    if (mode === "single") {
      commit(isSelected(id) ? [] : [id]);
      return;
    }
    commit(
      isSelected(id)
        ? selected().filter((entry) => entry !== id)
        : [...selected(), id],
    );
  }

  function clear() {
    if (selected().length === 0) return;
    commit([]);
  }

  return {
    selected,
    first: () => selected()[0],
    isSelected,
    select,
    toggle,
    clear,
  };
}
