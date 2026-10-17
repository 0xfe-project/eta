import type { Group, GroupChanges } from "@/api/control-plane.gen";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { controlPlane, unwrap } from "@/lib/api";
import { chatQueryOptions } from "./chat";

export function useGroupActions() {
  const client = useQueryClient();
  const onSuccess = (group: Group) => {
    client.setQueryData(chatQueryOptions().queryKey, (s) =>
      s
        ? {
            ...s,
            groups: s.groups.some((g) => g.id === group.id)
              ? s.groups.map((g) =>
                  g.id === group.id && g.revision <= group.revision ? group : g,
                )
              : [...s.groups, group],
          }
        : s,
    );
  };
  return {
    create: useMutation({
      mutationFn: (body: {
        name: string;
        members: string[];
        goal?: string;
        /** The folder the group works in; left out means "not bound yet". */
        cwd?: string;
      }) => unwrap(controlPlane.POST("/api/v1/groups", { body })),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: GroupChanges & { id: string }) =>
        unwrap(
          controlPlane.PATCH("/api/v1/groups/{group_id}", {
            params: { path: { group_id: id } },
            body,
          }),
        ),
      onSuccess,
    }),
    member: useMutation({
      mutationFn: ({
        groupId,
        agentId,
        member,
      }: {
        groupId: string;
        agentId: string;
        member: boolean;
      }) =>
        unwrap(
          controlPlane.PUT("/api/v1/groups/{group_id}/members/{agent_id}", {
            params: { path: { group_id: groupId, agent_id: agentId } },
            body: { member },
          }),
        ),
      onSuccess,
    }),
    read: useMutation({
      mutationFn: ({ id, seq }: { id: string; seq: number }) =>
        unwrap(
          controlPlane.POST("/api/v1/groups/{group_id}/read", {
            params: { path: { group_id: id } },
            body: { seq },
          }),
        ),
      onSuccess,
    }),
    stop: useMutation({
      mutationFn: (id: string) =>
        unwrap(
          controlPlane.POST("/api/v1/groups/{group_id}/stop", {
            params: { path: { group_id: id } },
          }),
        ),
    }),
  };
}
