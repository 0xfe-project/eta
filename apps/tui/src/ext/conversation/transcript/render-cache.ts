import type {
  RenderedItem,
  RenderItem,
  RenderOptions,
  TranscriptItem,
} from "../contract";
import { useEffect, useMemo, useState } from "react";
import { drawWidths } from "./frames";

/** The options every item is drawn with; whether one is unfolded is asked per item. */
export type SharedRenderOptions = Omit<RenderOptions, "expanded">;

interface Entry {
  item: TranscriptItem;
  options: RenderOptions;
  drawn: RenderedItem;
}

function sameOptions(a: RenderOptions, b: RenderOptions): boolean {
  return (
    a.width === b.width &&
    a.previewLines === b.previewLines &&
    a.expanded === b.expanded &&
    a.theme === b.theme &&
    a.locale === b.locale
  );
}

/**
 * Draws items through `renderItem`, keeping each drawing by the item's key: an item that is the
 * same object, drawn with the same options and fold, gives back the drawing it gave last time
 * without calling `renderItem`. Only the keys of the latest call are kept. `options.width` is the
 * transcript's; each item is drawn at the width `drawWidths` gives it (inside a frame, the width
 * inside it), and drawn again when that width changes.
 */
export function createRenderCache(
  renderItem: RenderItem,
): (
  items: readonly TranscriptItem[],
  options: SharedRenderOptions,
  isExpanded: (key: string) => boolean,
) => RenderedItem[] {
  let entries = new Map<string, Entry>();
  return (items, shared, isExpanded) => {
    const next = new Map<string, Entry>();
    const widths = drawWidths(items, shared.width);
    const drawn = items.map((item, index) => {
      const options: RenderOptions = {
        ...shared,
        width: widths[index]!,
        expanded: isExpanded(item.key),
      };
      const kept = entries.get(item.key);
      const entry =
        kept !== undefined &&
        kept.item === item &&
        sameOptions(kept.options, options)
          ? kept
          : { item, options, drawn: renderItem(item, options) };
      next.set(item.key, entry);
      return entry.drawn;
    });
    entries = next;
    return drawn;
  };
}

/** Items and their drawings, in the same order. */
export interface DrawnItems {
  items: readonly TranscriptItem[];
  rendered: readonly RenderedItem[];
  /** The transcript's width the items were drawn for. */
  width: number;
}

/**
 * `createRenderCache` for a component: one cache for the component's life. The drawing happens
 * after the render, outside it, and comes back in a second render, so it follows the arguments
 * one step behind; undefined until the first drawing. A new `items` array, option or `isExpanded`
 * function starts a drawing, so `isExpanded` keeps its identity while the folds stay the same; a
 * new `renderItem` also drops the cache, so it must be the same function each render.
 */
export function useRenderedItems(
  renderItem: RenderItem,
  items: readonly TranscriptItem[],
  options: SharedRenderOptions,
  isExpanded: (key: string) => boolean,
): DrawnItems | undefined {
  const draw = useMemo(() => createRenderCache(renderItem), [renderItem]);
  const [drawn, setDrawn] = useState<DrawnItems>();
  const { width, previewLines, theme, locale } = options;
  useEffect(() => {
    // `renderItem` draws with Ink's own renderer, which cannot run while Ink renders this app.
    const timer = setImmediate(() => {
      const shared = { width, previewLines, theme, locale };
      setDrawn({ items, rendered: draw(items, shared, isExpanded), width });
    });
    return () => clearImmediate(timer);
  }, [draw, items, width, previewLines, theme, locale, isExpanded]);
  return drawn;
}
