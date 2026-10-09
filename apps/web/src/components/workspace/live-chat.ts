import { useEffect } from "react";
import { useLiveChat, usePendingInteractions } from "@/queries/chat";

/** Counts waiting confirmations in the tab's title. */
function usePendingTitle() {
  const pending = usePendingInteractions().length;
  useEffect(() => {
    document.title = pending ? `(${pending}) AXP` : "AXP";
  }, [pending]);
}

/** The one chat subscription, on every page; see RootDocument. */
export function LiveChat() {
  useLiveChat();
  usePendingTitle();
  return null;
}
