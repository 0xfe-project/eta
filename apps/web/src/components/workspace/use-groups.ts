import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { parseAsString, useQueryState } from "nuqs";
import { useEffect } from "react";
import { chatQueryOptions } from "@/queries/chat";
import { useWorkspaceStore } from "./workspace-store";

export function useGroups() {
  const { data } = useQuery(chatQueryOptions());
  const [groupId] = useQueryState("group", parseAsString);
  const groups = data?.groups ?? [];
  const recent = [...groups].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  const selected = useWorkspaceStore((s) => s.workspace.selectedGroupId);
  const current = groupId
    ? groups.find((g) => g.id === groupId)
    : (groups.find((g) => g.id === selected) ??
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
