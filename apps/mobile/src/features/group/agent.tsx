// 03h2 智能体信息: read-only. Editing an agent stays on the desktop.

import type { AgentView } from "@eta/client-contracts";
import { Text, View } from "nsh";
import { agentById, machineById } from "../../app/lists";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Body, Header, Page } from "../../ui/Page";
import { Empty } from "../../ui/States";
import { modelName, statusLabel } from "./shared";

const RUNTIMES: Record<Exclude<AgentView["runtime"], "eta">, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

function Fact(props: { label: string; value: string }) {
  return (
    <View class="h-12 shrink-0 flex-row items-center justify-between gap-4 border-t border-border px-4">
      <Text class="text-base leading-[18px] text-muted-foreground">
        {props.label}
      </Text>
      <Text class="truncate text-base leading-[18px] text-foreground">
        {props.value}
      </Text>
    </View>
  );
}

export function AgentInfoScreen(props: { id: string }) {
  const agent = () => agentById(props.id);
  const machine = () => {
    const pinned = agent()?.machineId ?? null;
    if (pinned === null) return t("group.agent.machineFollow");
    return machineById(pinned)?.name ?? pinned;
  };
  const runtime = () => {
    const current = agent()?.runtime ?? "eta";
    return current === "eta" ? t("group.agent.runtimeEta") : RUNTIMES[current];
  };
  const model = () => {
    const current = agent()?.model ?? null;
    if (current !== null) return modelName(current);
    return t(
      agent()?.runtime === "eta"
        ? "group.agent.modelDefault"
        : "group.agent.modelRuntimeDefault",
    );
  };
  return (
    <Page>
      <Header border={false} />
      <If
        when={agent() !== undefined}
        else={<Empty title={t("group.agent.gone")} />}
      >
        <Body>
          <View class="shrink-0 flex-row items-center gap-3 px-4 pb-4">
            <AgentAvatar id={props.id} size={44} />
            <Text class="truncate grow basis-0 text-gauge-sm leading-[34px] tracking-[-0.02em] text-foreground">
              {agent()?.name}
            </Text>
          </View>
          <View class="shrink-0">
            <Fact
              label={t("group.agent.status")}
              value={statusLabel(agent()?.status ?? "idle")}
            />
            <Fact label={t("group.agent.machine")} value={machine()} />
            <Fact label={t("group.agent.runtime")} value={runtime()} />
            <Fact label={t("group.agent.model")} value={model()} />
            <Fact
              label={t("group.agent.thinking")}
              value={agent()?.thinkingLevel ?? t("group.agent.thinkingDefault")}
            />
            <Fact
              label={t("group.agent.persona")}
              value={agent()?.persona || t("group.agent.personaDefault")}
            />
          </View>
          <If when={(agent()?.instructions ?? "") !== ""}>
            <View class="shrink-0 gap-[6px] border-t border-border px-4 pt-3 pb-4">
              <Text class="text-sm leading-[18px] text-muted-foreground">
                {t("group.agent.instructions")}
              </Text>
              <Text class="text-base leading-[23px] text-foreground">
                {agent()?.instructions}
              </Text>
            </View>
          </If>
        </Body>
      </If>
    </Page>
  );
}
