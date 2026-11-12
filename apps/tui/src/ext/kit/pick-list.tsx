import type { Key } from "ink";
import type { PickItem } from "./list-cursor";
import { Text, useInput } from "ink";
import { useInputActive, useTheme } from "../../extensions/react";
import { inkColor } from "../../ui/theme";
import { DEFAULT_HEIGHT, separateKeys, useListCursor } from "./list-cursor";
import { ListRow, ListWindow } from "./list-rows";

export type { PickItem } from "./list-cursor";

/**
 * Handed the keys a list does not use itself, with the key of the marked item (undefined when the
 * list is empty). Returns true when it handled the key.
 */
export type ListKeyHandler = (
  input: string,
  key: Key,
  markedKey: string | undefined,
) => boolean;

/**
 * A list to pick one item from, of any length. ↑ ↓ move the marker, PageUp and PageDown turn a
 * page, Home and End go to the ends, Enter picks the marked item unless it is disabled. Only
 * `height` items show at a time, with a line for how many more are above and below.
 */
export function PickList({
  items,
  onPick,
  empty,
  initialKey,
  height = DEFAULT_HEIGHT,
  onKey,
}: {
  items: readonly PickItem[];
  onPick: (key: string) => void;
  /** Drawn instead of the list when it has no items. */
  empty: string;
  /** The item the marker starts on; the first when absent or not in the list. */
  initialKey?: string;
  height?: number;
  onKey?: ListKeyHandler;
}) {
  const theme = useTheme();
  const active = useInputActive();
  const cursor = useListCursor(items, height, initialKey);
  const handleKey = (input: string, key: Key) => {
    if (cursor.move(key)) return;
    const { index, markedKey } = cursor.current();
    if (key.return) {
      const marked = items[index];
      if (marked !== undefined && !marked.disabled) onPick(marked.key);
      return;
    }
    onKey?.(input, key, markedKey);
  };
  useInput(
    (input, key) => {
      for (const [one, oneKey] of separateKeys(input, key))
        handleKey(one, oneKey);
    },
    { isActive: active },
  );
  if (items.length === 0)
    return <Text color={inkColor(theme.muted)}>{empty}</Text>;
  const visible = items.slice(cursor.start, cursor.start + height);
  return (
    <ListWindow
      above={cursor.start}
      below={items.length - cursor.start - visible.length}
    >
      {visible.map((item, offset) => (
        <ListRow
          key={item.key}
          item={item}
          marked={cursor.start + offset === cursor.index}
        />
      ))}
    </ListWindow>
  );
}
