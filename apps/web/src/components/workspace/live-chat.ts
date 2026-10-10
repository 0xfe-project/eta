import { useLiveChat } from "@/queries/chat";

/** The one chat subscription, on every page; see RootDocument. */
export function LiveChat() {
  useLiveChat();
  return null;
}
