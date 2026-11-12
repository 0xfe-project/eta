import type {
  AgentRuntimeInfo,
  AgentView,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import type { ModelChoice } from "./choices";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { findAgent, useAgents } from "../kit/agents";
import { callErrorText } from "../kit/errors";
import { usableModels, useModels } from "../kit/models";
import { PickList } from "../kit/pick-list";
import {
  choicesOfModels,
  choicesOfRuntime,
  choiceText,
  levelOfRow,
  levelRows,
  levelText,
  modelOfRow,
  modelRows,
  rowOfModel,
} from "./choices";
import { modelMessages } from "./messages";

/** Where the user is once an agent is settled: choosing its model, or its thinking level. */
type Step =
  | { name: "model"; agent: AgentView; picked?: string | null }
  | {
      name: "thinking";
      agent: AgentView;
      model: string | null;
      /** How the chosen model is said back to the user. */
      modelText: string;
    };

/**
 * The agent `query` names, read off the live list: the host's newer list may name it when the
 * one first at hand does not. Otherwise the agents to choose from, and whether none fitted.
 */
function resolveQuery(
  agents: readonly AgentView[],
  query: string,
): { agent: AgentView } | { choose: readonly AgentView[]; missed: boolean } {
  if (query === "") return { choose: agents, missed: false };
  const found = findAgent(agents, query);
  if ("agent" in found) return found;
  if ("ambiguous" in found) return { choose: found.ambiguous, missed: false };
  return { choose: agents, missed: true };
}

/**
 * `/model`: which agent (asked when `query` names none or several), which model, which thinking
 * level; the agent is updated once the level is chosen. Esc on the level goes back to the models.
 */
export function ModelLayer({
  handle,
  query,
}: {
  handle: LayerHandle;
  query: string;
}) {
  const t = useMessages(modelMessages);
  const theme = useTheme();
  const agents = useAgents();
  const [step, setStep] = useState<Step>();

  if (step !== undefined && step.name === "thinking")
    return (
      <ThinkingStep
        agent={step.agent}
        model={step.model}
        modelText={step.modelText}
        onBack={() =>
          setStep({ name: "model", agent: step.agent, picked: step.model })
        }
        onSaved={handle.close}
      />
    );
  if (agents === undefined)
    return (
      <LayerFrame title={t("whichAgent")}>
        <Text color={inkColor(theme.muted)}>…</Text>
      </LayerFrame>
    );
  const resolved = resolveQuery(agents, query);
  const agent =
    step?.agent ?? ("agent" in resolved ? resolved.agent : undefined);
  if (agent === undefined && "choose" in resolved)
    return (
      <AgentStep
        agents={resolved.choose}
        missed={resolved.missed ? query : undefined}
        onPick={(picked) => setStep({ name: "model", agent: picked })}
        onClose={handle.close}
      />
    );
  if (agent === undefined) return null;
  return (
    <ModelStep
      agent={agent}
      initial={step?.picked}
      onPick={(model, modelText) =>
        setStep({ name: "thinking", agent, model, modelText })
      }
      // Back to the agents when they were asked about; closed when the query named one.
      onBack={() =>
        step !== undefined && !("agent" in resolved)
          ? setStep(undefined)
          : handle.close()
      }
    />
  );
}

function useEscape(onEscape: () => void): void {
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) onEscape();
    },
    { isActive: active },
  );
}

function AgentStep({
  agents,
  missed,
  onPick,
  onClose,
}: {
  agents: readonly AgentView[];
  /** What the user typed, when no agent fitted it. */
  missed: string | undefined;
  onPick: (agent: AgentView) => void;
  onClose: () => void;
}) {
  const t = useMessages(modelMessages);
  const theme = useTheme();
  useEscape(onClose);
  return (
    <LayerFrame title={t("whichAgent")} footer={t("agentFooter")}>
      {missed !== undefined && (
        <Text color={inkColor(theme.error)}>
          {t("noAgent", { text: missed })}
        </Text>
      )}
      <PickList
        items={agents.map((agent) => ({
          key: agent.id,
          label: agent.name,
          ...(agent.model === null ? {} : { hint: agent.model }),
        }))}
        empty={t("noAgents")}
        onPick={(id) => {
          const agent = agents.find((a) => a.id === id);
          if (agent !== undefined) onPick(agent);
        }}
      />
    </LayerFrame>
  );
}

/** What an external runtime's agent can choose, asked of the machine it runs on. */
function useRuntimeChoices(
  agent: AgentView,
):
  | { loading: true }
  | { error: string }
  | { info: AgentRuntimeInfo | undefined } {
  const { wire, locale } = useShell();
  const external = agent.runtime !== "eta";
  const [answer, setAnswer] = useState<
    { error: string } | { info: AgentRuntimeInfo | undefined } | undefined
  >();
  useEffect(() => {
    if (!external) return;
    let stopped = false;
    void (async () => {
      try {
        const { runtimes } = await wire.call<{ runtimes: AgentRuntimeInfo[] }>(
          "agents",
          "runtimes",
          agent.machineId === null ? {} : { machineId: agent.machineId },
        );
        if (!stopped)
          setAnswer({
            info: runtimes.find((info) => info.id === agent.runtime),
          });
      } catch (cause) {
        if (!stopped) setAnswer({ error: callErrorText(cause, locale) });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [external, wire, locale, agent.machineId, agent.runtime]);
  return answer ?? { loading: true };
}

function ModelStep({
  agent,
  initial,
  onPick,
  onBack,
}: {
  agent: AgentView;
  /** The row to start on, when coming back from the levels. */
  initial: string | null | undefined;
  onPick: (model: string | null, modelText: string) => void;
  onBack: () => void;
}) {
  const t = useMessages(modelMessages);
  const theme = useTheme();
  const models = useModels();
  const runtime = useRuntimeChoices(agent);
  useEscape(onBack);

  let choices: ModelChoice[] = [];
  let notice: string | undefined;
  if (agent.runtime === "eta") {
    if (models === undefined) notice = "…";
    else {
      choices = choicesOfModels(usableModels(models));
      if (choices.length === 0) notice = t("noModels");
    }
  } else if ("loading" in runtime) notice = t("runtimesLoading");
  else if ("error" in runtime) notice = runtime.error;
  else if (runtime.info === undefined || runtime.info.models.length === 0)
    notice = t("noRuntimeModels", { runtime: agent.runtime });
  else if (runtime.info.status !== "available")
    notice = t("runtimeNotReady", {
      runtime: runtime.info.label,
      status: runtime.info.status,
    });
  else choices = choicesOfRuntime(runtime.info);

  const rows = modelRows(choices, agent.model, t);
  return (
    <LayerFrame
      title={t("modelFor", { name: agent.name })}
      footer={t("modelFooter")}
    >
      <PickList
        items={rows.items}
        empty=""
        initialKey={
          initial === undefined ? rows.currentKey : rowOfModel(initial)
        }
        onPick={(key) => {
          const model = modelOfRow(key);
          const choice = choices.find((entry) => entry.id === model);
          onPick(
            model,
            model === null
              ? t("settingsModel")
              : choice === undefined
                ? model
                : choiceText(choice),
          );
        }}
      />
      {notice !== undefined && (
        <Text color={inkColor(theme.muted)}>{notice}</Text>
      )}
    </LayerFrame>
  );
}

function ThinkingStep({
  agent,
  model,
  modelText,
  onBack,
  onSaved,
}: {
  agent: AgentView;
  model: string | null;
  modelText: string;
  onBack: () => void;
  onSaved: () => void;
}) {
  const t = useMessages(modelMessages);
  const theme = useTheme();
  const { wire, locale, notify } = useShell();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // Set in the key handler itself: a second key of the same read comes before any re-render.
  const savingRef = useRef(false);
  useEscape(() => {
    if (!savingRef.current) onBack();
  });

  const save = async (level: ThinkingLevel | null) => {
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await wire.call("agents", "update", {
        agentId: agent.id,
        model,
        thinkingLevel: level,
      });
      notify(
        t("saved", {
          name: agent.name,
          model: modelText,
          level: levelText(level, t),
        }),
      );
      onSaved();
    } catch (cause) {
      setError(callErrorText(cause, locale));
      savingRef.current = false;
      setSaving(false);
    }
  };

  const rows = levelRows(agent.thinkingLevel, t);
  return (
    <LayerFrame
      title={t("thinkingFor", { name: agent.name })}
      footer={t("thinkingFooter")}
    >
      <Text color={inkColor(theme.muted)}>{modelText}</Text>
      <Box flexDirection="column" marginTop={1}>
        <PickList
          items={rows.items}
          empty=""
          initialKey={rows.currentKey}
          onPick={(key) => {
            if (!savingRef.current) void save(levelOfRow(key));
          }}
        />
        {saving && <Text color={inkColor(theme.muted)}>{t("saving")}</Text>}
        {error !== undefined && (
          <Text color={inkColor(theme.error)}>{error}</Text>
        )}
      </Box>
    </LayerFrame>
  );
}
