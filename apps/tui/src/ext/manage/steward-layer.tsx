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

/** The key of the "No steward" row; an agent id never looks like it. */
const NONE = "\0none";

/** Which row is the steward now, from the conversation's own facts; undefined before they arrive. */
function currentChoice(info: ConversationInfo | undefined): string | undefined {
  if (info === undefined) return undefined;
  return info.stewardId ?? NONE;
}

/**
 * The group's members, then no steward; the one in effect is marked current once the
 * conversation's facts arrive, which the layer follows while open.
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
    { kind: "none" },
  ];
  const rows: Row[] = choices.map((choice) => {
    if (choice.kind === "agent")
      return {
        key: choice.agent.id,
        label: label(choice.agent.name, choice.agent.id),
      };
    return { key: NONE, label: label(t("noSteward"), NONE) };
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
