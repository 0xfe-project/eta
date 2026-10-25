import { useNavigate } from "@tanstack/react-router";
import { useQueryState } from "nuqs";
import { useEffect, useMemo } from "react";
import { useConversationList } from "@/queries/conversations";
import { idParam } from "./id-param";
import { useWorkspaceStore } from "./workspace-store";

/** The conversations, newest activity first, and the one open (`?group=`, else the last one). */
export function useGroups() {
  const { conversations } = useConversationList();
  const [groupId] = useQueryState("group", idParam);
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
  // Opening a conversation is not asking for a tab. It used to carry `view: "context"` — the
  // panel's first tab — and on a phone that was read as "the URL wants this tab", which opened the
  // panel over the chat you had just asked for: 点一行会话，先看到右侧边栏。
  //
  // Nothing is lost by dropping it: `view` falls back to `context` on its own, so the panel still
  // shows the same tab wherever it is drawn, a stale `view=tasks` from the last place still clears,
  // and the one thing that changes is the one thing that should — a conversation opens on itself.
  return (group: string) => {
    useWorkspaceStore.getState().setMobilePanel("chat");
    void navigate({ to: "/", search: { group } });
  };
}
