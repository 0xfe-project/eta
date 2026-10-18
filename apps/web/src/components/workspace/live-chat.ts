import { useEffect } from "react";
import { usePendingInteractions } from "@/queries/inbox";

/** Counts the questions waiting for the user in the tab's title. */
export function LiveChat() {
  const pending = usePendingInteractions().length;
  useEffect(() => {
    document.title = pending ? `(${pending}) eta` : "eta";
  }, [pending]);
  return null;
}
