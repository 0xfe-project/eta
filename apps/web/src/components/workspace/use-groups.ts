import { useNavigate } from "@tanstack/react-router";
import { parseAsString, useQueryState } from "nuqs";
import { useEffect, useMemo } from "react";
import { useConversationList } from "@/queries/conversations";
import { useWorkspaceStore } from "./workspace-store";

/** The conversations, newest activity first, and the one open (`?group=`, else the last one). */
export function useGroups() {
  const { conversations } = useConversationList();
  const [groupId] = useQueryState("group", parseAsString);
  const recent = useMemo(
    () =>
      [...conversations].sort(
        (a, b) =>
          (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt),
      ),
    [conversations],
  );
  const selected = useWorkspaceStore((s) => s.workspace.selectedGroupId);
  const current = groupId
    ? recent.find((g) => g.id === groupId)
    : (recent.find((g) => g.id === selected) ??
      recent.find((g) => !g.archived));
  useEffect(() => {
    if (current && selected !== current.id)
      useWorkspaceStore
        .getState()
        .setWorkspace((s) => ({ ...s, selectedGroupId: current.id }));
  }, [current, selected]);
  return { groups: recent, groupId, current };
}
export function useOpenGroup() {
  const navigate = useNavigate();
  return (group: string) => {
    useWorkspaceStore.getState().setMobilePanel("chat");
    void navigate({ to: "/", search: { group, view: "context" } });
  };
}
