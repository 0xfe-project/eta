/** A waiting item, or a task to read, in a layer of its own. */
import type { LayerHandle, ShellContext } from "../../extensions/types";
import type { ItemMode } from "./item";
import type { ItemRef } from "./model";
import { CONVERSATION_VIEW } from "../conversation/kind";
import { ItemContent } from "./item";
import { keyOf } from "./model";

/** Brings a conversation to the front after closing the layers that led to it. */
export function goToConversation(
  ctx: ShellContext,
  handles: readonly LayerHandle[],
  conversationId: string,
): void {
  for (const handle of handles) handle.close();
  ctx.openTab({ kind: CONVERSATION_VIEW, id: conversationId });
}

/**
 * Opens one item in a layer of its own over whatever is open. Going to its conversation closes it
 * and the layers in `below` too.
 */
export function openItemLayer(
  ctx: ShellContext,
  item: ItemRef,
  mode: ItemMode,
  below: readonly LayerHandle[] = [],
): LayerHandle {
  return ctx.openLayer((handle) => (
    <ItemContent
      key={keyOf(item)}
      item={item}
      mode={mode}
      onFinished={handle.close}
      onLeave={handle.close}
      onOpenConversation={(id) => goToConversation(ctx, [handle, ...below], id)}
    />
  ));
}
