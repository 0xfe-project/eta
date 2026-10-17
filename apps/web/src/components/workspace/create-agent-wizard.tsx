import type { AgentForm } from "./agent-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useBundles, useCreateAgent } from "@/queries/chat";
import { useModels } from "@/queries/llm";
import {
  BundlesField,
  InstructionsField,
  ModelField,
  NameField,
} from "./agent-fields";
import { agentDraft, agentFormSchema } from "./agent-form";
import { Stepper } from "./stepper";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

const steps = [
  "agents:createWizard.nameAndModel",
  "agents:editor.tabs.instructions",
  "bundles:title",
] as const;
// The fields each step checks before moving on.
const stepFields = [["name", "model"], ["description"], ["bundles"]] as const;
const last = steps.length - 1;

/**
 * Creating an agent one step at a time, as in connecting GitHub. Nothing
 * is sent until 创建 on the last step; a failure stays there with every
 * field kept, to retry. Mounted per open, so a cancelled draft is gone.
 */
export function CreateAgentWizard({ onDone }: { onDone: () => void }) {
  const { t: translateText } = useTranslation([
    "agents",
    "bundles",
    "common",
    "validation",
  ] as const);
  const { select } = useAgents();
  const lastModel = useWorkspaceStore((s) => s.workspace.lastModel);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const { data: models } = useModels();
  const { data: bundles } = useBundles();
  const usable = (models ?? []).filter((model) => model.available);
  const create = useCreateAgent();
  const [step, setStep] = useState(0);
  const [failure, setFailure] = useState<string>();
  // isPending only updates on the next render; a second Enter or click in
  // between must not create the agent twice.
  const sendingRef = useRef(false);
  const form = useForm<AgentForm>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: "",
      description: "",
      model: "",
      bundles: null,
      persona: "",
    },
  });
  const model = form.watch("model");
  // New agents start with the last used model, or the first usable one.
  const preferred = usable.find((item) => item.id === lastModel) ?? usable[0];
  useEffect(() => {
    if (!model && preferred) form.setValue("model", preferred.id);
  }, [form, model, preferred]);

  const openProviders = () => {
    onDone();
    setSettings({ open: true, section: "providers" });
  };

  const valid = async (at: number) => {
    if (!(await form.trigger([...stepFields[at]]))) return false;
    // Agents can be created before any account is connected, not after.
    if (at === 0 && !form.getValues("model") && usable.length) {
      form.setError("model", {
        message: translateText("validation:modelRequired"),
      });
      return false;
    }
    return true;
  };

  // Not handleSubmit: it checks every field, and a step must not fail on
  // one it does not show.
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    // Enter in a step's field moves on; only the last step creates.
    if (step < last) {
      if (await valid(step)) setStep(step + 1);
      return;
    }
    // Every step again: one gone back to may have been left invalid.
    for (let at = 0; at < last; at++) {
      if (!(await valid(at))) {
        setStep(at);
        return;
      }
    }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setFailure(undefined);
    const values = agentFormSchema.parse(form.getValues());
    if (values.model) {
      setWorkspace((state) => ({ ...state, lastModel: values.model }));
    }
    create.mutate(agentDraft(values), {
      onSuccess: (created) => {
        select(created.id);
        toast.success(
          translateText("feedback.created", { name: created.name }),
        );
        onDone();
      },
      onError: (error) => setFailure(error.message),
      onSettled: () => {
        sendingRef.current = false;
      },
    });
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      aria-label={translateText("actions.create")}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b px-4 py-3">
        <Stepper
          steps={steps.map((key) => translateText(key))}
          step={step}
          label={translateText("createWizard.stepsLabel")}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {step === 0 ? (
          <>
            <NameField form={form} autoFocus />
            <ModelField
              form={form}
              models={models}
              onOpenProviders={openProviders}
            />
          </>
        ) : step === 1 ? (
          <InstructionsField form={form} autoFocus />
        ) : (
          <>
            {failure ? (
              <p
                role="alert"
                className="flex items-start gap-2 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <WarningIcon
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
                <span className="min-w-0 break-words">
                  {translateText("createWizard.failed", { message: failure })}
                </span>
              </p>
            ) : null}
            {!bundles ? (
              <Loading layout="lines" />
            ) : bundles.length ? (
              <BundlesField form={form} bundles={bundles} autoFocus />
            ) : (
              <p className="text-sm text-muted-foreground">
                {translateText("createWizard.noBundles")}
              </p>
            )}
          </>
        )}
      </div>
      <DialogFooter className="shrink-0 flex-row justify-between border-t p-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          {translateText("common:actions.cancel")}
        </Button>
        <div className="flex gap-2">
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
          {step < last ? (
            <Button key="next" type="submit">
              {translateText("common:actions.next")}
            </Button>
          ) : (
            <Button
              key="create"
              type="submit"
              disabled={create.isPending}
              // A double click on 下一步 lands its second click here.
              onClick={(event) => event.detail > 1 && event.preventDefault()}
            >
              {create.isPending
                ? translateText("common:states.creating")
                : failure
                  ? translateText("createWizard.retry")
                  : translateText("common:actions.create")}
            </Button>
          )}
        </div>
      </DialogFooter>
    </form>
  );
}
