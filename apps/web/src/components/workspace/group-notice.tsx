import type { ChatMessage } from "@/queries/chat";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useGroupActions } from "@/queries/groups";
import { CreateGroup } from "./groups";
import { useGroups } from "./use-groups";

export function GroupNotice({ message }: { message: ChatMessage }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { groups } = useGroups();
  const { member } = useGroupActions();
  const group = groups.find((g) => g.id === message.group_id);
  const guest =
    typeof message.data.invite_agent_id === "string"
      ? message.data.invite_agent_id
      : undefined;
  const invited = group?.participants.some(
    (p) => p.agent_id === guest && p.member,
  );
  return (
    <div className="border-l pl-3 text-xs text-muted-foreground">
      {message.blocks.map((b) =>
        b.type === "text" ? <p key={b.id}>{b.text}</p> : null,
      )}
      {guest &&
        !invited &&
        group &&
        (group.kind === "direct" ? (
          <CreateGroup
            members={[
              ...group.participants
                .filter((p) => p.member)
                .map((p) => p.agent_id),
              guest,
            ]}
          >
            <Button size="xs" variant="outline" className="mt-2">
              {translateText("groups.createWithMembers")}
            </Button>
          </CreateGroup>
        ) : (
          <Button
            size="xs"
            variant="outline"
            className="mt-2"
            disabled={member.isPending || group.archived}
            onClick={() =>
              member.mutate(
                { groupId: group.id, agentId: guest, member: true },
                { onError: (error) => toast.error(error.message) },
              )
            }
          >
            {translateText("groups.inviteSelected")}
          </Button>
        ))}
      {guest && invited && <span>{translateText("groups.joined")}</span>}
    </div>
  );
}
