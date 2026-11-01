import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmailAccountForm } from "@/components/workspace/email-settings";
import { ProviderSettings } from "@/components/workspace/provider-settings";
import { Stepper } from "@/components/workspace/stepper";
import { markOnboarded } from "@/lib/onboard";
import { useAgentList, useCreateAgent } from "@/queries/agents";
import { usePersonas } from "@/queries/personas";
import { useModels } from "@/queries/providers";

/**
 * Setting up a fresh install in three steps: bind a model provider, create one
 * agent per persona card, then optionally connect an IMAP mailbox. Nothing is created until 安装;
 * a
 * persona whose agent already exists is marked and skipped, so re-running the
 * wizard only fills the gaps.
 */
export function Onboard() {
  const { t: translateText } = useTranslation(["onboard", "common"] as const);
  const navigate = useNavigate();
  const { data: models } = useModels();
  const { agents, loaded, error } = useAgentList();
  const personas = usePersonas();
  const create = useCreateAgent();
  const [step, setStep] = useState(0);
  // Every card starts checked, so the state holds the ones the user unchecked.
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const [failure, setFailure] = useState<string>();

  const usable = (models ?? []).filter((model) => model.available);
  const defaultModel = usable.find((model) => model.default) ?? usable[0];
  // One agent per persona is the whole install, so a persona with an agent is done.
  const installed = new Set(
    agents.flatMap((agent) => (agent.persona ? [agent.persona] : [])),
  );

  const install = async () => {
    setFailure(undefined);
    try {
      for (const card of personas) {
        if (installed.has(card.id) || unchecked.includes(card.id)) continue;
        await create.mutateAsync({
          name: card.name,
          persona: card.id,
          model: defaultModel?.id,
        });
      }
      markOnboarded();
      await navigate({ to: "/" });
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <main
      id="main"
      className="mx-auto flex h-svh w-full max-w-2xl flex-col gap-4 p-4"
    >
      <Stepper
        steps={[
          translateText("onboard:steps.providers"),
          translateText("onboard:steps.agents"),
          translateText("onboard:steps.email"),
        ]}
        step={step}
        label={translateText("onboard:stepsLabel")}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === 0 ? (
          <ProviderSettings />
        ) : step === 1 && !loaded && error === undefined ? (
          <Loading rows={2} />
        ) : step === 1 && error ? (
          <LoadError
            what={translateText("onboard:agents.what")}
            error={error}
          />
        ) : step === 1 && personas.length === 0 ? (
          <Empty title={translateText("onboard:agents.empty")} />
        ) : step === 1 ? (
          <ul className="divide-y border">
            {personas.map((card) => {
              const done = installed.has(card.id);
              return (
                <li key={card.id}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                    <Checkbox
                      className="mt-0.5"
                      checked={done || !unchecked.includes(card.id)}
                      disabled={done}
                      onCheckedChange={() =>
                        setUnchecked((current) =>
                          current.includes(card.id)
                            ? current.filter((id) => id !== card.id)
                            : [...current, card.id],
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {card.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {card.description}
                      </span>
                    </span>
                    {done ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {translateText("onboard:agents.installed")}
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {translateText("onboard:email.optional")}
            </p>
            <EmailAccountForm compact />
          </div>
        )}
      </div>
      {failure ? (
        <p
          role="alert"
          className="flex items-start gap-2 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">
            {translateText("onboard:agents.failed", { message: failure })}
          </span>
        </p>
      ) : null}
      <footer className="flex shrink-0 items-center justify-between border-t pt-3">
        {step > 0 ? (
          <Button
            type="button"
            variant="outline"
            disabled={create.isPending}
            onClick={() => setStep(step - 1)}
          >
            {translateText("common:actions.previous")}
          </Button>
        ) : null}
        {step < 2 ? (
          step === 0 ? (
            <Button
              type="button"
              className="ml-auto"
              disabled={usable.length === 0}
              onClick={() => setStep(1)}
            >
              {translateText("common:actions.next")}
            </Button>
          ) : (
            <Button
              type="button"
              className="ml-auto"
              onClick={() => setStep(2)}
            >
              {translateText("common:actions.next")}
            </Button>
          )
        ) : (
          <Button
            type="button"
            className="ml-auto"
            disabled={create.isPending}
            onClick={() => void install()}
          >
            {create.isPending
              ? translateText("onboard:states.installing")
              : failure
                ? translateText("onboard:agents.retry")
                : translateText("onboard:agents.install")}
          </Button>
        )}
      </footer>
    </main>
  );
}
