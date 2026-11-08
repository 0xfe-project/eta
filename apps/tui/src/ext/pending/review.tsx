/** Review mode: the waiting items one after another, oldest first, in one layer. */
import type { LayerHandle } from "../../extensions/types";
import type { ItemRef, PendingItem } from "./model";
import { useRef, useState } from "react";
import { useShell } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { usePendingItems } from "./hooks";
import { ItemContent } from "./item";
import { goToConversation } from "./item-layer";
import { pendingMessages } from "./messages";
import { pendingItems } from "./model";

const refOf = (item: PendingItem): ItemRef => ({
  kind: item.kind,
  id: item.kind === "question" ? item.interaction.id : item.task.id,
});

/** Review mode's layer, starting at `first`. */
export function Review({
  handle,
  first,
}: {
  handle: LayerHandle;
  first: PendingItem;
}) {
  const ctx = useShell();
  const { wire } = ctx;
  const t = useMessages(pendingMessages);
  const items = usePendingItems();
  // Both live only as long as this review: skipped by the user, and handled while shown. They
  // are read from calls that settle after a later render, so they are kept outside render state.
  const skippedRef = useRef(new Set<string>());
  const handledRef = useRef(new Set<string>());
  const [shown, setShown] = useState<PendingItem>(first);

  const left = items.filter(
    (item) =>
      !skippedRef.current.has(item.key) && !handledRef.current.has(item.key),
  );

  /** Shows the next item that is neither skipped nor handled, or ends the review. */
  const goOn = () => {
    const now = pendingItems(wire.store.getState()).filter(
      (item) => !handledRef.current.has(item.key),
    );
    const next = now.find((item) => !skippedRef.current.has(item.key));
    if (next !== undefined) {
      setShown(next);
      return;
    }
    handle.close();
    ctx.notify(t(now.length > 0 ? "skippedRest" : "allCaughtUp"), "info");
  };

  return (
    <ItemContent
      key={shown.key}
      item={refOf(shown)}
      mode="pending"
      frameTitle={t("reviewTitle", { count: Math.max(1, left.length) })}
      onFinished={() => {
        handledRef.current.add(shown.key);
        goOn();
      }}
      onLeave={handle.close}
      onSkip={() => {
        skippedRef.current.add(shown.key);
        goOn();
      }}
      onOpenConversation={(id) => goToConversation(ctx, [handle], id)}
    />
  );
}
