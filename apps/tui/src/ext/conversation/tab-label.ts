/** What the tab bar shows for a conversation tab: its name, its qualifiers and its status mark. */
import type { TabRef } from "../../config/types";
import type { TabStatus } from "../../extensions/types";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { useShell } from "../../extensions/react";
import {
  conversationQualifiers,
  conversationStewardName,
  conversationTabStatus,
  conversationTarget,
  conversationTitle,
} from "./facts";

export function useConversationTitle(tab: TabRef): string {
  const { wire } = useShell();
  return useStore(wire.store, (state) => conversationTitle(state, tab.id));
}

/** Follows the agents list while the tab is open, so a renamed steward shows its new name. */
export function useConversationQualifiers(tab: TabRef): readonly string[] {
  const { wire } = useShell();
  useEffect(() => wire.subscribe("agents"), [wire]);
  const stewardName = useStore(wire.store, (state) =>
    conversationStewardName(state, tab.id),
  );
  return useMemo(
    () => conversationQualifiers(stewardName, tab.id),
    [stewardName, tab.id],
  );
}

/**
 * Follows the conversation's own target while the tab is open, also while it is not in front,
 * so a reply that ends behind another tab still marks it.
 */
export function useConversationStatus(tab: TabRef): TabStatus | undefined {
  const { wire } = useShell();
  useEffect(() => wire.subscribe(conversationTarget(tab.id)), [wire, tab.id]);
  return useStore(wire.store, (state) => conversationTabStatus(state, tab.id));
}
