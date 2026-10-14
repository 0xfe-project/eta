import type { Icon } from "@phosphor-icons/react";
import type { AgentForm } from "./agent-form";
import type { Agent } from "@/queries/chat";
import { zodResolver } from "@hookform/resolvers/zod";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { ScrollIcon } from "@phosphor-icons/react/Scroll";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
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
import { cn } from "@/lib/utils";
import { useBundles, useDeleteAgent, useUpdateAgent } from "@/queries/chat";
import { useModels } from "@/queries/llm";
import {
  BundlesField,
  InstructionsField,
  ModelField,
  NameField,
} from "./agent-fields";
import { agentDraft, agentFormSchema } from "./agent-form";
import { AgentAvatar } from "./agent-identity";
import { CreateAgentWizard } from "./create-agent-wizard";
import { useReturnFocus } from "./return-focus";
import { SettingsNav } from "./settings-nav";
import { UsageLine } from "./usage-line";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

export function DeleteAgentDialog({
  agent,
  open,
  onOpenChange,
  onDeleted,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteAgent();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除「{agent.name}」？</AlertDialogTitle>
          <AlertDialogDescription>
            正在进行的回复会被停止，智能体不再运行。已有的对话记录会保留。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              remove.mutate(agent.id, {
                onSuccess: () => {
                  toast.success(`已删除「${agent.name}」`);
                  onDeleted?.();
                },
                onError: (error) => toast.error(error.message),
              })
            }
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Tab = "general" | "instructions" | "environment";
// The editor's tabs and the fields on each, to show where errors are.
const tabs: {
  value: Tab;
  label: string;
  icon: Icon;
  fields: (keyof AgentForm)[];
}[] = [
  {
    value: "general",
    label: "常规",
    icon: SlidersHorizontalIcon,
    fields: ["name", "model"],
  },
  {
    value: "instructions",
    label: "指令",
    icon: ScrollIcon,
    fields: ["description"],
  },
  {
    value: "environment",
    label: "环境",
    icon: PackageIcon,
    fields: ["bundles"],
  },
];

function AgentEditorForm({
  agent,
  onDone,
}: {
  agent: Agent;
  onDone: () => void;
}) {
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const { data: models } = useModels();
  const { data: bundles } = useBundles();
  const updateAgent = useUpdateAgent();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<Tab>("general");
  const form = useForm<AgentForm>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: agent.name,
      description: agent.description,
      model: agent.model ?? "",
      bundles: agent.bundles ?? null,
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

  // Fields on other tabs are not mounted: open the error's tab first.
  const showError = (field: keyof AgentForm) => {
    const target = tabs.find((t) => t.fields.includes(field));
    if (target) setTab(target.value);
    setFocus({ field });
  };
  const errors = form.formState.errors;

  const save = form.handleSubmit(
    (values) => {
      // Agents can be created before any account is connected, not after.
      if (!values.model && models?.some((model) => model.available)) {
        form.setError("model", { message: "请选择模型。" });
        showError("model");
        return;
      }
      if (values.model) {
        setWorkspace((state) => ({ ...state, lastModel: values.model }));
      }
      updateAgent.mutate(
        { id: agent.id, ...agentDraft(values) },
        {
          onSuccess: () => {
            toast.success("已保存");
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
          label="智能体设置分类"
          sections={tabs.map((t) => ({
            ...t,
            ...(t.value === "environment"
              ? { attention: Boolean(agent.build_error), hint: "环境构建失败" }
              : {
                  attention: t.fields.some((name) => errors[name]),
                  hint: "有错误",
                }),
          }))}
          value={tab}
          onChange={setTab}
        />
        <section className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
          {tab === "general" ? (
            <>
              <NameField form={form} />
              <ModelField
                form={form}
                models={models}
                onOpenProviders={openProviders}
              />
              <UsageLine principal={agent.id} />
            </>
          ) : tab === "instructions" ? (
            <InstructionsField form={form} />
          ) : (
            <>
              {bundles?.length ? (
                <BundlesField form={form} bundles={bundles} />
              ) : null}
              {agent.build_error ? (
                <div className="space-y-1.5" role="alert">
                  <p className="text-xs leading-none text-destructive">
                    环境构建失败
                  </p>
                  <pre
                    // The build's last lines say what failed: show them first.
                    ref={(pre) => {
                      if (pre) pre.scrollTop = pre.scrollHeight;
                    }}
                    className="max-h-48 overflow-auto border bg-muted/40 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap"
                  >
                    {agent.build_error}
                  </pre>
                </div>
              ) : null}
            </>
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
          删除智能体
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button
            type="submit"
            disabled={updateAgent.isPending || !form.formState.isDirty}
          >
            保存
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
          // Editing is laid out as settings are; creating is a short wizard.
          agent
            ? "h-[min(36rem,calc(100dvh-2rem))] sm:max-w-3xl"
            : "max-h-[calc(100dvh-2rem)] sm:max-w-xl",
        )}
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-3 border-b p-3 pr-12">
          {agent ? <AgentAvatar agent={agent} /> : null}
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">
              {agent ? agent.name : "新建智能体"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {agent ? "编辑智能体" : "新建智能体"}
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
