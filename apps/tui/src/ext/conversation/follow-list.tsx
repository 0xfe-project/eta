import { useEffect } from "react";
import { useShell } from "../../extensions/react";

/**
 * Follows the eager `conversations` list while the shell shows. The host sends that list with
 * hello and pushes changes to it only to a subscriber; tab names and marks and `/open` read it.
 */
export function FollowConversationList() {
  const { wire } = useShell();
  useEffect(() => wire.subscribe("conversations"), [wire]);
  return null;
}
