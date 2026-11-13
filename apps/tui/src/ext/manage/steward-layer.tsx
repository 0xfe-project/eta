import type { ConversationInfo } from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import type { Row } from "../../ui/components/row-list";
import type { StewardChoice } from "./actions";
import type { NamedAgent } from "./facts";
import { useEffect } from "react";
import { useStore } from "zustand";
import { useShell } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { conversationTarget } from "../conversation/facts";
import { manageMessages } from "./messages";
import { PickLayer } from "./pick-layer";

/** Which row is the steward now, from the conversation's own facts; undefined before they arrive. */
function currentChoice(
  info: ConversationInfo | undefined,
): StewardChoice["kind"] | string | undefined {
  if (info === undefined) return undefined;
  if (info.noSteward) return "none";
  if (info.stewardOverrideId === null) return "project";
  return info.stewardOverrideId;
}

/**
 * The members, then following the project's steward, then no steward; the one in effect is
 * marked current once the conversation's facts arrive, which the layer follows while open.
 */
export function StewardLayer({
  conversationId,
  conversationName,
  members,
  onChoose,
  handle,
}: {
  conversationId: string;
  conversationName: string;
  members: readonly NamedAgent[];
  onChoose: (choice: StewardChoice) => void;
  handle: LayerHandle;
}) {
  const t = useMessages(manageMessages);
  const { wire } = useShell();
  const target = conversationTarget(conversationId);
  useEffect(() => wire.subscribe(target), [wire, target]);
  const info = useStore(
    wire.store,
    (state) =>
      state.targets[target]?.sections.info as ConversationInfo | undefined,
  );
  const current = currentChoice(info);
  const label = (text: string, key: string) =>
    key === current ? `${text}${t("current")}` : text;
  const choices: StewardChoice[] = [
    ...members.map((agent): StewardChoice => ({ kind: "agent", agent })),
    { kind: "project" },
    { kind: "none" },
  ];
  const rows: Row[] = choices.map((choice) => {
    if (choice.kind === "agent")
      return {
        key: choice.agent.id,
        label: label(choice.agent.name, choice.agent.id),
      };
    return choice.kind === "project"
      ? { key: "project", label: label(t("followProject"), "project") }
      : { key: "none", label: label(t("noSteward"), "none") };
  });
  return (
    <PickLayer
      title={t("stewardTitle", { conversation: conversationName })}
      rows={rows}
      onChoose={(index) => onChoose(choices[index]!)}
      handle={handle}
    />
  );
}
