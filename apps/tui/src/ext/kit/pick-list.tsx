import type { Key } from "ink";
import type { PickItem } from "./list-cursor";
import { Box, Text, useInput } from "ink";
import { useInputActive, useTheme } from "../../extensions/react";
import { useLayerCursor, useListFit } from "../../ui/components/layer-space";
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
 * page, Home and End go to the ends, Enter picks the marked item unless it is disabled. At most
 * `height` items show at a time, with a line for how many more are above and below; fewer in a
 * layer frame that has not got the rows for them (see `useListFit`). In a layer frame whose
 * content is taller than it, PageUp and PageDown scroll the frame instead (see `useLayerCursor`).
 */
export function PickList({
  items,
  onPick,
  empty,
  initialKey,
  height: preferredHeight = DEFAULT_HEIGHT,
  onKey,
}: {
  items: readonly PickItem[];
  onPick: (key: string) => void;
  /** Drawn instead of the list when it has no items. */
  empty: string;
  /** The item the marker starts on; the first when absent or not in the list. */
  initialKey?: string;
  /** The most items shown at a time; ten when absent. */
  height?: number;
  onKey?: ListKeyHandler;
}) {
  const theme = useTheme();
  const active = useInputActive();
  const { height, drew } = useListFit(items.length, preferredHeight);
  const cursor = useListCursor(items, height, initialKey);
  const layerCursor = useLayerCursor(
    cursor.index,
    (cursor.start > 0 ? 1 : 0) + cursor.index - cursor.start,
  );
  const handleKey = (input: string, key: Key) => {
    if ((key.pageUp || key.pageDown) && layerCursor.framePages) return;
    if (cursor.move(key)) return;
    const { index, markedKey } = cursor.current();
    if (key.return) {
      if (!layerCursor.takeAction()) return;
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
  if (items.length === 0) {
    drew(1);
    return <Text color={inkColor(theme.muted)}>{empty}</Text>;
  }
  const visible = items.slice(cursor.start, cursor.start + height);
  const below = items.length - cursor.start - visible.length;
  drew(visible.length + (cursor.start > 0 ? 1 : 0) + (below > 0 ? 1 : 0));
  return (
    <Box ref={layerCursor.ref} flexDirection="column">
      <ListWindow above={cursor.start} below={below}>
        {visible.map((item, offset) => (
          <ListRow
            key={item.key}
            item={item}
            marked={cursor.start + offset === cursor.index}
          />
        ))}
      </ListWindow>
    </Box>
  );
}
