import type { TaskActor } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { AgentFace, UserFace } from "../../components/agent-face";
import { avatar, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

type AgentLookup = (
  id: string | null | undefined,
) => { name: string } | undefined;

/** Who an actor is: me, an agent by name (or as deleted once the host no longer knows it), or Eta. */
export function actorLabel(actor: TaskActor, agent: AgentLookup) {
  if (actor.kind === "user") return uiText("taskMe");
  if (actor.kind === "system") return "Eta";
  return agent(actor.agentId)?.name ?? uiText("taskDeletedAgent");
}

/** A row's secondary line: who it is for and who made it, the maker labelled; one mention when they are the same. */
export function ownerLine(
  task: { createdBy: TaskActor; assigneeAgentId: string | null },
  agent: AgentLookup,
) {
  const creator = uiText("taskCreatorValue", {
    name: actorLabel(task.createdBy, agent),
  });
  const assignee = task.assigneeAgentId;
  if (!assignee || assignee === task.createdBy.agentId) return creator;
  return `${actorLabel({ kind: "agent", agentId: assignee }, agent)} · ${creator}`;
}

/** An actor as a face and a name: its own face for an agent, the user's for anyone else. */
export function ActorName(props: { actor: TaskActor; size: number }) {
  const host = useHost();
  return (
    <View style={{ ...row, gap: space[4], flex: 1, minWidth: 0 }}>
      {props.actor.kind === "agent" ? (
        <AgentFace id={props.actor.agentId} size={props.size} />
      ) : (
        <UserFace size={props.size} />
      )}
      <Label
        variant="small"
        weight={weight.strong}
        lines={1}
        style={{ flexShrink: 1 }}
      >
        {actorLabel(props.actor, host.agent)}
      </Label>
    </View>
  );
}

/** The maker of a task as a chip under its title: "Creator", a face, a name. */
export function CreatorChip(props: { creator: TaskActor }) {
  const host = useHost();
  const c = colors();
  const name = () => actorLabel(props.creator, host.agent);
  return (
    <View
      accessibilityLabel={uiText("taskCreatorValue", { name: name() })}
      style={{
        ...row,
        gap: space[4],
        alignSelf: "flex-start",
        paddingVertical: space[2],
        paddingHorizontal: space[8],
        borderWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label variant="caption" tone="muted">
        {uiText("taskCreator")}
      </Label>
      {props.creator.kind === "agent" ? (
        <AgentFace id={props.creator.agentId} size={avatar.sm} />
      ) : (
        <UserFace size={avatar.sm} />
      )}
      <Label variant="caption" weight={weight.strong} lines={1}>
        {name()}
      </Label>
    </View>
  );
}
