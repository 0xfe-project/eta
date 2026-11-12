import type { Extension, PinnedTab } from "../../extensions/types";
import { useStore } from "zustand";
import { useShell } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { PendingBackground } from "./background";
import { pendingMessages } from "./messages";
import { pendingCount } from "./model";
import { openPanel } from "./open";
import { tasksCommand } from "./tasks-command";

function usePendingCount(): number {
  const { wire } = useShell();
  return useStore(wire.store, pendingCount);
}

const pendingTab: PinnedTab = {
  id: "pending",
  useLabel: () => {
    const t = useMessages(pendingMessages);
    return t("pinned", { count: usePendingCount() });
  },
  useAttention: () => usePendingCount() > 0,
  onSelect: openPanel,
};

const extension: Extension = {
  id: "pending",
  messages: pendingMessages,
  commands: [tasksCommand],
  pinnedTabs: [pendingTab],
  Background: PendingBackground,
};

export default extension;
