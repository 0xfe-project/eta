import type { AgentView } from "@eta/client-contracts";
import type { Icon } from "@phosphor-icons/react";
import type { AgentForm } from "./agent-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PuzzlePieceIcon } from "@phosphor-icons/react/PuzzlePiece";
import { ScrollIcon } from "@phosphor-icons/react/Scroll";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useEffect, useState } from "react";
import { useForm, useFormState, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  useAgentRuntimeChoices,
  useDeleteAgent,
  useUpdateAgent,
} from "@/queries/agents";
import {
  InstructionsField,
  ModelField,
  NameField,
  PersonaField,
  RuntimeField,
  ThinkingField,
} from "./agent-fields";
import { agentDraft, agentFormSchema, agentNameTaken } from "./agent-form";
import { AgentAvatar } from "./agent-identity";
import { AgentPluginsField } from "./agent-plugins";
import { CreateAgentWizard } from "./create-agent-wizard";
import { MachinePicker } from "./machine-picker";
import { useReturnFocus } from "./return-focus";
import { SettingsNav } from "./settings-nav";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

export function DeleteAgentDialog({
  agent,
  open,
  onOpenChange,
  onDeleted,
}: {
  agent: AgentView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t: translateText } = useTranslation([
    "agents",
    "common",
    "validation",
  ] as const);
  const remove = useDeleteAgent();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {translateText("delete.confirmTitle", { name: agent.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {translateText("delete.confirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {translateText("common:actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              remove.mutate(
                { agentId: agent.id },
                {
                  onSuccess: () => {
                    toast.success(
                      translateText("common:feedback.deletedItem", {
                        name: agent.name,
                      }),
                    );
                    onDeleted?.();
                  },
                  onError: (error) => toast.error(error.message),
                },
              )
            }
          >
            {translateText("common:actions.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Tab = "general" | "instructions" | "plugins";
// The editor's tabs and the fields on each, to show where errors are.
const tabs: {
  value: Tab;
  label: string;
  icon: Icon;
  fields: (keyof AgentForm)[];
}[] = [
  {
    value: "general",
    get label() {
      return translate("agents:editor.tabs.general");
    },
    icon: SlidersHorizontalIcon,
    fields: ["name", "runtime", "model", "thinkingLevel", "persona"],
  },
  {
    value: "instructions",
    get label() {
      return translate("agents:editor.tabs.instructions");
    },
    icon: ScrollIcon,
    fields: ["description"],
  },
  {
    value: "plugins",
    get label() {
      return translate("agents:editor.tabs.plugins");
    },
    icon: PuzzlePieceIcon,
    fields: ["plugins"],
  },
];

function AgentEditorForm({
  agent,
  onDone,
}: {
  agent: AgentView;
  onDone: () => void;
}) {
  const { t: translateText } = useTranslation([
    "agents",
    "common",
    "validation",
  ] as const);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const updateAgent = useUpdateAgent();
  const { agents } = useAgents();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<Tab>("general");
  const form = useForm<AgentForm>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: agent.name,
      description: agent.instructions,
      runtime: agent.runtime,
      model: agent.model ?? "",
      persona: agent.persona,
      thinkingLevel: agent.thinkingLevel ?? "",
      machineId: agent.machineId ?? "",
      plugins: agent.plugins,
    },
  });
  // A field with an error, to focus once its tab shows.
  const [focus, setFocus] = useState<{ field: keyof AgentForm }>();
  useEffect(() => {
    if (focus) form.setFocus(focus.field);
  }, [focus, form]);
  const openProviders = () => {
    onDone();
    setSettings({ open: true, section: "providers" });
  };
  const openPlugins = () => {
    onDone();
    setSettings({ open: true, section: "plugins" });
  };

  // Fields on other tabs are not mounted: open the error's tab first.
  const showError = (field: keyof AgentForm) => {
    const target = tabs.find((t) => t.fields.includes(field));
    if (target) setTab(target.value);
    setFocus({ field });
  };
  const { errors } = useFormState({ control: form.control });
  const runtime = useWatch({ control: form.control, name: "runtime" });
  const machineId = useWatch({ control: form.control, name: "machineId" });
  const { runtimes, models } = useAgentRuntimeChoices(runtime, machineId);

  const save = form.handleSubmit(
    (values) => {
      // An agent on eta's own loop runs on the model it names; there is no default to fall back
      // to. An external runtime runs its own default when none is chosen.
      if (values.runtime === "eta" && !values.model) {
        form.setError("model", {
          message: translateText("validation:modelRequired"),
        });
        showError("model");
        return;
      }
      if (agentNameTaken(agents, values.name, agent.id)) {
        form.setError("name", {
          message: translateText("validation:nameTaken", {
            name: values.name.trim(),
          }),
        });
        showError("name");
        return;
      }
      if (values.model && values.runtime === "eta") {
        setWorkspace((state) => ({ ...state, lastModel: values.model }));
      }
      updateAgent.mutate(
        { agentId: agent.id, ...agentDraft(values) },
        {
          onSuccess: () => {
            toast.success(translateText("common:feedback.saved"));
            onDone();
          },
          onError: (error) => toast.error(error.message),
        },
      );
    },
    (invalid) => {
      const field = tabs.flatMap((t) => t.fields).find((name) => invalid[name]);
      if (field) showError(field);
    },
  );

  return (
    <form noValidate onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <SettingsNav
          label={translateText("editor.sectionsLabel")}
          sections={tabs.map((t) => ({
            ...t,
            attention: t.fields.some((name) => errors[name]),
            hint: translateText("common:states.hasErrors"),
          }))}
          value={tab}
          onChange={setTab}
        />
        <section className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
          {tab === "general" ? (
            <>
              <NameField form={form} />
              <MachinePicker form={form} />
              <RuntimeField form={form} runtimes={runtimes} />
              <ModelField
                form={form}
                models={models}
                onOpenProviders={openProviders}
                external={runtime !== "eta"}
              />
              <ThinkingField form={form} />
              <PersonaField form={form} />
            </>
          ) : tab === "instructions" ? (
            <InstructionsField form={form} />
          ) : (
            <AgentPluginsField
              form={form}
              skipped={agent.skippedPlugins}
              external={runtime !== "eta"}
              onOpenSettings={openPlugins}
            />
          )}
        </section>
      </div>
      <DialogFooter className="shrink-0 border-t p-3 sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <TrashIcon aria-hidden="true" data-icon="inline-start" />
          {translateText("actions.delete")}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            {translateText("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={updateAgent.isPending || !form.formState.isDirty}
          >
            {translateText("common:actions.save")}
          </Button>
        </div>
      </DialogFooter>
      <DeleteAgentDialog
        agent={agent}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        onDeleted={onDone}
      />
    </form>
  );
}

/**
 * Create an agent step by step, or edit one in tabs; every
 * entry (the chat head, settings, empty states) opens this one dialog.
 */
export function AgentEditor() {
  const { t: translateText } = useTranslation([
    "agents",
    "common",
    "validation",
  ] as const);
  const agentEditor = useWorkspaceStore((s) => s.agentEditor);
  const setAgentEditor = useWorkspaceStore((s) => s.setAgentEditor);
  const { agents } = useAgents();
  const agent = agents.find((item) => item.id === agentEditor.agentId);
  const close = () => setAgentEditor((state) => ({ ...state, open: false }));
  // An agent deleted elsewhere closes its editor.
  const missing = agentEditor.open && agentEditor.agentId !== null && !agent;
  const open = agentEditor.open && !missing;
  const returnFocus = useReturnFocus(open);
  useEffect(() => {
    if (missing) close();
  });

  return (
    <Dialog open={open} onOpenChange={(open) => !open && close()}>
      <DialogContent
        onCloseAutoFocus={returnFocus}
        className={cn(
          "flex max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0",
          // Editing is laid out as settings are; creating is a short wizard,
          // capped to its own width at every viewport, not full-width by default.
          agent
            ? "h-[min(36rem,calc(100dvh-2rem))] sm:max-w-3xl"
            : "max-h-[calc(100dvh-2rem)] max-w-[min(28rem,calc(100%-2rem))]",
        )}
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-3 border-b p-3 pr-12">
          {agent ? <AgentAvatar agent={agent} /> : null}
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">
              {agent ? agent.name : translateText("actions.create")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {agent
                ? translateText("actions.edit")
                : translateText("actions.create")}
            </DialogDescription>
          </div>
        </DialogHeader>
        {!agentEditor.open ? null : agent ? (
          // Keyed so each open starts from the agent's saved values.
          <AgentEditorForm key={agent.id} agent={agent} onDone={close} />
        ) : agentEditor.agentId === null ? (
          // Unmounted on close: reopening starts a new, empty draft.
          <CreateAgentWizard onDone={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
