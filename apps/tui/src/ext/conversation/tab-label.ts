/** What the tab bar shows for a conversation tab: its name and whether someone is answering. */
import type { TabRef } from "../../config/types";
import type { TabStatus } from "../../extensions/types";
import { useStore } from "zustand";
import { useShell } from "../../extensions/react";
import { conversationStatus, conversationTitle } from "./facts";

export function useConversationTitle(tab: TabRef): string {
  const { wire } = useShell();
  return useStore(wire.store, (state) => conversationTitle(state, tab.id));
}

export function useConversationStatus(tab: TabRef): TabStatus | undefined {
  const { wire } = useShell();
  return useStore(wire.store, (state) => conversationStatus(state, tab.id));
}
