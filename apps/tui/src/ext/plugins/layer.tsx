import type { AgentView, PluginView } from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import type { Translate } from "../../i18n/messages";
import { Box, Text } from "ink";
import { useRef, useState } from "react";
import { useShell, useTheme } from "../../extensions/react";
import { useLocale, useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { useAgents } from "../kit/agents";
import { CheckList } from "../kit/check-list";
import { callErrorText } from "../kit/errors";
import { useHostCall } from "../kit/host-call";
import { PickList } from "../kit/pick-list";
import { useTarget } from "../kit/wire-hooks";
import { pluginsMessages } from "./messages";

type PluginsText = Translate<keyof (typeof pluginsMessages)["en"]>;

/** The host's plugins, and for the one opened, which agents have it on. */
export function PluginsLayer({ handle }: { handle: LayerHandle }) {
  const plugins = useTarget("plugins")?.sections.list as
    | PluginView[]
    | undefined;
  const [opened, setOpened] = useState<string>();
  if (opened !== undefined)
    return (
      <PluginDetail
        name={opened}
        plugin={plugins?.find((plugin) => plugin.name === opened)}
        onBack={() => setOpened(undefined)}
      />
    );
  return (
    <PluginList
      plugins={plugins}
      onOpen={setOpened}
      onClose={() => handle.close()}
    />
  );
}

function stateText(plugin: PluginView, t: PluginsText): string {
  return plugin.state === "ready" ? t("ready") : t("needsConfig");
}

function PluginList({
  plugins,
  onOpen,
  onClose,
}: {
  plugins: PluginView[] | undefined;
  onOpen: (name: string) => void;
  onClose: () => void;
}) {
  const t = useMessages(pluginsMessages);
  const items = (plugins ?? []).map((plugin) => {
    const facts = {
      version: plugin.version ?? t("unknownVersion"),
      state: stateText(plugin, t),
      count: plugin.agents.length,
    };
    return {
      key: plugin.name,
      label: plugin.name,
      hint:
        plugin.problem === null
          ? t("row", facts)
          : t("rowProblem", { ...facts, problem: plugin.problem }),
    };
  });
  return (
    <LayerFrame title={t("title")} footer={t("listFooter")}>
      <PickList
        items={items}
        empty={plugins === undefined ? t("loading") : t("empty")}
        onPick={onOpen}
        onKey={(_input, key) => {
          if (!key.escape) return false;
          onClose();
          return true;
        }}
      />
    </LayerFrame>
  );
}

interface Refusal {
  agent: string;
  error: string;
}

/** The plugin list an agent ends up with when this plugin is turned on or off for it. */
function withPlugin(agent: AgentView, name: string, on: boolean): string[] {
  const others = agent.plugins.filter((plugin) => plugin !== name);
  return on ? [...others, name] : others;
}

function PluginDetail({
  name,
  plugin,
  onBack,
}: {
  name: string;
  plugin: PluginView | undefined;
  onBack: () => void;
}) {
  const t = useMessages(pluginsMessages);
  const theme = useTheme();
  const locale = useLocale();
  const { wire } = useShell();
  const agents = useAgents();
  // The user's ticks that differ from the host, by agent id, until they are applied. The ref is
  // what key handlers read: keys read together run before the next render.
  const wantedRef = useRef<ReadonlyMap<string, boolean>>(new Map());
  const [wanted, setWanted] = useState(wantedRef.current);
  const { busy, run } = useHostCall();
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const muted = inkColor(theme.muted);

  const hasOn = (agent: AgentView) => agent.plugins.includes(name);
  const ticked = (agent: AgentView) => wanted.get(agent.id) ?? hasOn(agent);
  const needsConfig = plugin?.state === "needs_config";

  const setWantedNow = (next: ReadonlyMap<string, boolean>) => {
    wantedRef.current = next;
    setWanted(next);
  };

  // Flips from what this layer last asked for, not from the list's idea of the tick, which lags
  // behind keys read together.
  const toggle = (agentId: string) => {
    const agent = agents?.find((entry) => entry.id === agentId);
    if (agent === undefined) return;
    const next = !(wantedRef.current.get(agentId) ?? hasOn(agent));
    const copy = new Map(wantedRef.current);
    if (next === hasOn(agent)) copy.delete(agentId);
    else copy.set(agentId, next);
    setWantedNow(copy);
  };

  const apply = () => {
    if (agents === undefined) return;
    const asked = wantedRef.current;
    const changed = agents.filter(
      (agent) => asked.has(agent.id) && asked.get(agent.id) !== hasOn(agent),
    );
    if (changed.length === 0) return;
    const started = run(
      async () =>
        Promise.allSettled(
          changed.map(async (agent) =>
            wire.call("agents", "update", {
              agentId: agent.id,
              plugins: withPlugin(agent, name, asked.get(agent.id) === true),
            }),
          ),
        ),
      (outcomes) => {
        setRefusals(
          outcomes.flatMap((outcome, index) =>
            outcome.status === "rejected"
              ? [
                  {
                    agent: changed[index]!.name,
                    error: callErrorText(outcome.reason, locale),
                  },
                ]
              : [],
          ),
        );
        setWantedNow(new Map());
      },
    );
    if (started) setRefusals([]);
  };

  return (
    <LayerFrame title={name} footer={t("detailFooter")}>
      {plugin === undefined ? (
        <Text color={muted}>{t("gone")}</Text>
      ) : (
        <>
          {plugin.description !== "" && <Text>{plugin.description}</Text>}
          <Text color={muted}>
            {t("counts", {
              skills: plugin.skills.length,
              servers: plugin.servers.length,
            })}
          </Text>
          {plugin.problem !== null && (
            <Text color={inkColor(theme.error)}>
              {t("problem", { problem: plugin.problem })}
            </Text>
          )}
          {needsConfig && (
            <Text color={inkColor(theme.warning)}>{t("configureFirst")}</Text>
          )}
        </>
      )}
      <Box marginTop={1}>
        <Text bold>{t("agentsHeading")}</Text>
      </Box>
      <CheckList
        items={(agents ?? []).map((agent) => ({
          key: agent.id,
          label: agent.name,
          disabled: plugin === undefined || (needsConfig && !hasOn(agent)),
        }))}
        checked={
          new Set((agents ?? []).filter(ticked).map((agent) => agent.id))
        }
        onToggle={toggle}
        onConfirm={apply}
        empty={agents === undefined ? t("loading") : t("noAgents")}
        onKey={(_input, key) => {
          if (!key.escape) return false;
          onBack();
          return true;
        }}
      />
      {busy && <Text color={muted}>{t("applying")}</Text>}
      {refusals.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={inkColor(theme.error)}>{t("refused")}</Text>
          {refusals.map((refusal) => (
            <Text key={refusal.agent} color={inkColor(theme.error)}>
              {t("refusedAgent", { ...refusal })}
            </Text>
          ))}
        </Box>
      )}
    </LayerFrame>
  );
}
