import type { Key } from "ink";
import type { PickItem } from "./list-cursor";
import type { ListKeyHandler } from "./pick-list";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { useInputActive, useTheme } from "../../extensions/react";
import { useLayerCursor, useListFit } from "../../ui/components/layer-space";
import { inkColor } from "../../ui/theme";
import { DEFAULT_HEIGHT, separateKeys, useListCursor } from "./list-cursor";
import { ListRow, ListWindow } from "./list-rows";

/**
 * A list to tick any number of items in. It moves and scrolls like `PickList`; Space ticks or
 * unticks the marked item unless it is disabled, and Enter confirms the ticked set.
 *
 * The ticks are the list's own, starting from `initialChecked`, unless the caller passes
 * `checked`: then the list shows exactly that set and Space only calls `onToggle`.
 */
export function CheckList({
  items,
  onConfirm,
  empty,
  checked,
  onToggle,
  initialChecked,
  initialKey,
  height: preferredHeight = DEFAULT_HEIGHT,
  onKey,
}: {
  items: readonly PickItem[];
  onConfirm: (checked: ReadonlySet<string>) => void;
  /** Drawn instead of the list when it has no items. */
  empty: string;
  checked?: ReadonlySet<string>;
  /** Called for every tick and untick, with the state the item would go to. */
  onToggle?: (key: string, next: boolean) => void;
  initialChecked?: Iterable<string>;
  initialKey?: string;
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
  const [own, setOwn] = useState<ReadonlySet<string>>(
    () => new Set(initialChecked),
  );
  const ticked = checked ?? own;
  // The ticks as of the last Space, also one since the last render: a later key of the same read
  // (another Space, Enter) must see it. See `ListCursor.current`.
  const ownLatestRef = useRef(own);
  ownLatestRef.current = own;
  // Held ticks change only when the caller renders again, which is after the whole read. Until
  // then the Spaces of this read are kept here; they are dropped once the read is over, so a
  // caller that refused them is not overruled by a later Enter.
  const heldInReadRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const tickedNow = () =>
    checked === undefined
      ? ownLatestRef.current
      : (heldInReadRef.current ?? checked);

  const toggle = (item: PickItem) => {
    const now = tickedNow();
    const next = !now.has(item.key);
    const copy = new Set(now);
    if (next) copy.add(item.key);
    else copy.delete(item.key);
    if (checked === undefined) {
      ownLatestRef.current = copy;
      setOwn(copy);
    } else {
      if (heldInReadRef.current === undefined)
        queueMicrotask(() => {
          heldInReadRef.current = undefined;
        });
      heldInReadRef.current = copy;
    }
    onToggle?.(item.key, next);
  };

  const handleKey = (input: string, key: Key) => {
    if ((key.pageUp || key.pageDown) && layerCursor.framePages) return;
    if (cursor.move(key)) return;
    const { index, markedKey } = cursor.current();
    if (input === " ") {
      if (!layerCursor.takeAction()) return;
      const marked = items[index];
      if (marked !== undefined && !marked.disabled) toggle(marked);
      return;
    }
    if (key.return) {
      if (layerCursor.takeAction()) onConfirm(tickedNow());
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
            prefix={ticked.has(item.key) ? "[x] " : "[ ] "}
          />
        ))}
      </ListWindow>
    </Box>
  );
}
