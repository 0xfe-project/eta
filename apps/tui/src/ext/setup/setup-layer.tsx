import type { LayerHandle } from "../../extensions/types";
import type { AgentsProgress } from "./agents-step";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { usableModels, useModels, useProvidersProblem } from "../kit/models";
import { ProvidersPanel } from "../providers/providers-panel";
import { AgentsStep } from "./agents-step";
import { defaultUsableModel } from "./first-run";
import { setupMessages } from "./messages";

type Step = "accounts" | "agents";

/**
 * The first-time setup: connect model accounts, then create one agent per persona card. It starts
 * on the second step when a model is usable already. Esc leaves it and says how to come back;
 * finishing closes it and says how many agents were made.
 */
export function SetupLayer({ handle }: { handle: LayerHandle }) {
  const t = useMessages(setupMessages);
  const theme = useTheme();
  const shell = useShell();
  const models = useModels();
  const usable = models === undefined ? [] : usableModels(models);
  const [step, setStep] = useState<Step>();
  const [progress, setProgress] = useState<AgentsProgress>(() => ({
    unticked: new Set(),
    created: new Set(),
  }));

  // Decided once, when the models first come: a model usable already skips the accounts.
  if (step === undefined && models !== undefined)
    setStep(usable.length > 0 ? "agents" : "accounts");

  const leave = () => {
    handle.close();
    shell.notify(t("left"));
  };

  // Until a step shows, nothing else takes Esc: reading the host, or a host it cannot read.
  const providersProblem = useProvidersProblem();
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) leave();
    },
    { isActive: active && step === undefined },
  );

  return (
    <LayerFrame title={t("title")}>
      {step === undefined && providersProblem !== undefined ? (
        <Text color={inkColor(theme.error)}>
          {t("providersProblem", { problem: providersProblem })}
        </Text>
      ) : step === undefined ? (
        <Text color={inkColor(theme.muted)}>{t("loading")}</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>
            {step === "accounts" ? t("stepAccounts") : t("stepAgents")}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {step === "accounts" ? (
              <ProvidersPanel
                onLeave={leave}
                leading={{
                  label: t("next"),
                  ...(usable.length === 0
                    ? { blockedReason: t("noUsableModel") }
                    : {}),
                  onPick: () => setStep("agents"),
                }}
              />
            ) : (
              <AgentsStep
                model={defaultUsableModel(models ?? [])}
                progress={progress}
                onProgress={setProgress}
                onBack={() => setStep("accounts")}
                onLeave={leave}
                onDone={(created) => {
                  handle.close();
                  shell.notify(t("done", { count: created }));
                }}
              />
            )}
          </Box>
        </Box>
      )}
    </LayerFrame>
  );
}
