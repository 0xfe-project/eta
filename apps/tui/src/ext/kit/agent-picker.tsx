import type { AgentView } from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import { Text, useInput } from "ink";
import { useInputActive, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { useAgents } from "./agents";
import { kitMessages } from "./messages";
import { PickList } from "./pick-list";

/** A layer that asks which agent: the live list under `title`. Esc closes the layer. */
export function AgentPicker({
  title,
  handle,
  onPick,
  initialId,
}: {
  title: string;
  handle: LayerHandle;
  onPick: (agent: AgentView) => void;
  /** The agent the marker starts on. */
  initialId?: string;
}) {
  const t = useMessages(kitMessages);
  const theme = useTheme();
  const agents = useAgents();
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) handle.close();
    },
    { isActive: active },
  );
  return (
    <LayerFrame title={title} footer={t("pickerFooter")}>
      {agents === undefined ? (
        <Text color={inkColor(theme.muted)}>{t("agentsLoading")}</Text>
      ) : (
        <PickList
          items={agents.map((agent) => ({
            key: agent.id,
            label: agent.name,
            hint: agent.model ?? undefined,
          }))}
          empty={t("agentsEmpty")}
          initialKey={initialId}
          onPick={(id) => {
            const agent = agents.find((a) => a.id === id);
            if (agent !== undefined) onPick(agent);
          }}
        />
      )}
    </LayerFrame>
  );
}
