import type { BoardTaskStatus, TaskActivityView } from "@eta/client-contracts";
import { dependencyEntry } from "@eta/client-contracts";
import { View } from "nsh";
import { Caption, Label, Markdown } from "../../components";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { statusKeys, statusName } from "./status";

function taskActivityLabel(entry: TaskActivityView): string {
  if (entry.kind === "status") {
    const next = entry.data.to as BoardTaskStatus;
    if (Object.hasOwn(statusKeys, next)) return `moved to ${statusName(next)}`;
  }
  if (entry.kind === "dependency") {
    const edge = dependencyEntry(entry.data);
    if (edge) {
      if (edge.action === "unblocked") return "unblocked";
      const ref = `#${edge.number}`;
      if (edge.action === "added") return `waiting for ${ref}`;
      if (edge.action === "blocked") return `blocked by ${ref}`;
      return `dependency ${ref} ${
        edge.action === "required" ? "updated" : edge.action
      }`;
    }
  }
  return entry.kind.replaceAll("_", " ");
}

export function TaskActivity(props: {
  entries: TaskActivityView[];
  phone: boolean;
}) {
  const host = useHost();
  return (
    <View style={{ gap: 5, marginTop: 3 }}>
      <Caption text={uiText("activity")} />
      <Each
        of={
          props.phone
            ? props.entries
                .slice()
                .reverse()
                .filter((entry) => entry.kind !== "run_queued")
            : props.entries
        }
        key={(entry) => entry.id}
      >
        {(entry) => (
          <View style={{ gap: 2 }}>
            <Label size={11} tone="muted">
              {`${
                host.agent(entry().actor.agentId)?.name ??
                (entry().actor.kind === "user" ? "You" : "Eta")
              } · ${taskActivityLabel(entry())} · ${relativeTime(entry().createdAt)}`}
            </Label>
            <If when={entry().body}>
              <Markdown value={entry().body ?? ""} line={22} />
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}
