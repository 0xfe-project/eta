import { useEffect } from "react";
import { usePendingInteractions } from "@/queries/chat";

/** Counts waiting confirmations in the tab's title, on every page. */
export function usePendingTitle() {
  const pending = usePendingInteractions().length;
  useEffect(() => {
    document.title = pending ? `(${pending}) AXP` : "AXP";
  }, [pending]);
}
