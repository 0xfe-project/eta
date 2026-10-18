import { useEffect } from "react";
import { useQuestions } from "@/queries/questions";

/** Counts the questions waiting for the user in the tab's title. */
export function LiveChat() {
  const pending = useQuestions().length;
  useEffect(() => {
    document.title = pending ? `(${pending}) eta` : "eta";
  }, [pending]);
  return null;
}
