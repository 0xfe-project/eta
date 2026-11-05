import type { AgentForm } from "./agent-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useAgentRuntimeChoices, useCreateAgent } from "@/queries/agents";
import { useMachines } from "@/queries/projects";
import {
  InstructionsField,
  ModelField,
  NameField,
  PersonaField,
  RuntimeField,
  ThinkingField,
} from "./agent-fields";
import { agentDraft, agentFormSchema } from "./agent-form";
import { MachinePicker } from "./machine-picker";
import { Stepper } from "./stepper";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

const steps = [
  "agents:createWizard.nameAndModel",
  "agents:editor.tabs.instructions",
] as const;
// The fields each step checks before moving on.
const stepFields = [
  ["name", "machineId", "runtime", "model"],
  ["description"],
] as const;
const last = steps.length - 1;

/**
 * Creating an agent one step at a time, as in connecting GitHub. Nothing
 * is sent until 创建 on the last step; a failure stays there with every
 * field kept, to retry. Mounted per open, so a cancelled draft is gone.
 */
export function CreateAgentWizard({ onDone }: { onDone: () => void }) {
  const { t: translateText } = useTranslation([
    "agents",
    "common",
    "machines",
    "validation",
  ] as const);
  const { select } = useAgents();
  const lastModel = useWorkspaceStore((s) => s.workspace.lastModel);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
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
      runtime: "eta",
      model: "",
      persona: "",
      thinkingLevel: "",
      machineId: "",
      plugins: [],
    },
  });
  const model = useWatch({ control: form.control, name: "model" });
  const runtime = useWatch({ control: form.control, name: "runtime" });
  const external = runtime !== "eta";
  const machineId = useWatch({ control: form.control, name: "machineId" });
  const { machines } = useMachines();
  const machine = machines.find((item) => item.id === machineId);
  const { runtimes, models } = useAgentRuntimeChoices(runtime, machineId);
  const usable = (models ?? []).filter((item) => item.available);
  // New agents start with the last used model, else the default one, else the first usable one.
  // An external runtime starts on its own default, which is no choice at all.
  const preferred = external
    ? undefined
    : (usable.find((item) => item.id === lastModel) ??
      usable.find((item) => item.default) ??
      usable[0]);
  useEffect(() => {
    if (!model && preferred) form.setValue("model", preferred.id);
  }, [form, model, preferred]);

  // Why the runtime is not the one chosen, until the next choice of machine or runtime.
  const [runtimeNote, setRuntimeNote] = useState<string>();
  const clearRuntimeNote = () => setRuntimeNote(undefined);
  // Unlike the editor, nothing here has been saved on a runtime yet, so a machine without it moves
  // the draft to eta's own loop, which every machine has. It is checked as the answer comes in, and
  // 下一步 waits for that. A machine that cannot be asked can't vouch for the runtime either.
  const info = runtimes?.find((item) => item.id === runtime);
  const runtimeGone =
    external && runtimes !== undefined && info?.status !== "available";
  const runtimeLabel = info?.label ?? runtime;
  const machineName = machine?.name ?? translateText("machines:kinds.primary");
  useEffect(() => {
    if (!runtimeGone) return;
    const next = translateText("runtime.eta");
    setRuntimeNote(
      runtimes === null
        ? translateText("machine.runtimeUnknown", {
            machine: machineName,
            next,
          })
        : translateText("machine.runtimeMissing", {
            machine: machineName,
            runtime: runtimeLabel,
            next,
          }),
    );
    form.setValue("runtime", "eta");
    form.setValue("model", "");
    form.clearErrors("model");
  }, [
    form,
    machineName,
    runtime,
    runtimeGone,
    runtimeLabel,
    runtimes,
    translateText,
  ]);
  // The runtime is here but its model is not: the runtime's own default stands in.
  const modelGone =
    external &&
    Boolean(models) &&
    model !== "" &&
    !usable.some((item) => item.id === model);
  useEffect(() => {
    if (modelGone) form.setValue("model", "");
  }, [form, modelGone]);
  const checkingRuntime = external && runtimes === undefined;

  const openProviders = () => {
    onDone();
    setSettings({ open: true, section: "providers" });
  };

  const valid = async (at: number) => {
    if (!(await form.trigger([...stepFields[at]]))) return false;
    if (at === 0 && checkingRuntime) return false;
    // It was online when it was chosen; a new agent is not pinned to one that is out of reach.
    if (at === 0 && machine && machine.status !== "online") {
      form.setError("machineId", {
        message: translateText("machine.wentOffline", {
          machine: machine.name,
        }),
      });
      return false;
    }
    // Agents can be created before any account is connected, not after.
    if (at === 0 && !external && !form.getValues("model") && usable.length) {
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
    if (values.model && values.runtime === "eta") {
      setWorkspace((state) => ({ ...state, lastModel: values.model }));
    }
    create.mutate(agentDraft(values), {
      onSuccess: ({ agent }) => {
        select(agent.id);
        toast.success(translateText("feedback.created", { name: agent.name }));
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
            <MachinePicker form={form} onChange={clearRuntimeNote} />
            <RuntimeField
              form={form}
              runtimes={runtimes}
              note={runtimeNote}
              onChange={clearRuntimeNote}
            />
            <ModelField
              form={form}
              models={models}
              onOpenProviders={openProviders}
              external={external}
            />
            <ThinkingField form={form} />
          </>
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
            <InstructionsField form={form} autoFocus />
            <PersonaField form={form} />
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
            <Button key="next" type="submit" disabled={checkingRuntime}>
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
