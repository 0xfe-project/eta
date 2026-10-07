import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
  type Agent,
} from "@/queries/chat";
import { AgentMonogram } from "./agent-identity";
import { useAgents } from "./use-agents";
import { useWorkspace } from "./workspace-state";

const DESCRIPTION_MAX = 10_000;

// One schema for create and edit; new agent settings become new fields here.
const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入名称。")
    .max(100, "名称最多 100 个字符。"),
  description: z
    .string()
    .max(
      DESCRIPTION_MAX,
      `指令最多 ${DESCRIPTION_MAX.toLocaleString()} 个字符。`,
    ),
});
type AgentForm = z.infer<typeof agentFormSchema>;

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

function AgentEditorForm({
  agent,
  onDone,
}: {
  agent: Agent | undefined;
  onDone: () => void;
}) {
  const { select } = useAgents();
  const create = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
  } = useForm<AgentForm>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: agent?.name ?? "",
      description: agent?.description ?? "",
    },
  });
  const description = watch("description");
  const pending = create.isPending || updateAgent.isPending;
  const onError = (error: Error) => toast.error(error.message);

  const save = handleSubmit((draft) => {
    if (agent) {
      updateAgent.mutate(
        { id: agent.id, ...draft },
        {
          onSuccess: () => {
            toast.success("已保存");
            onDone();
          },
          onError,
        },
      );
    } else {
      create.mutate(draft, {
        onSuccess: (created) => {
          select(created.id);
          toast.success(`已创建「${created.name}」`);
          onDone();
        },
        onError,
      });
    }
  });

  return (
    <form noValidate onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">名称</Label>
          <Input
            id="agent-name"
            autoFocus={!agent}
            placeholder="例如：代码审查"
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? "agent-name-error" : undefined}
            {...register("name")}
          />
          {errors.name ? (
            <p
              id="agent-name-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {errors.name.message}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="agent-description">指令</Label>
            <span
              className="text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {description.length.toLocaleString()} /{" "}
              {DESCRIPTION_MAX.toLocaleString()}
            </span>
          </div>
          <Textarea
            id="agent-description"
            rows={12}
            className="max-h-[50dvh] min-h-48 font-mono leading-relaxed"
            placeholder="职责、工作方式和约束。例如：你负责审查 Pull Request，只指出会导致错误的问题。"
            aria-invalid={Boolean(errors.description)}
            aria-describedby="agent-description-hint"
            {...register("description")}
          />
          <p
            id="agent-description-hint"
            className={
              errors.description
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
            role={errors.description ? "alert" : undefined}
          >
            {errors.description?.message ??
              "注入智能体的上下文；修改在空闲时生效，不打断进行中的回复。"}
          </p>
        </div>
      </div>
      <DialogFooter className="shrink-0 border-t p-3 sm:justify-between">
        {agent ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <TrashIcon aria-hidden="true" data-icon="inline-start" />
            删除智能体
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button type="submit" disabled={pending || (agent && !isDirty)}>
            {agent ? "保存" : "创建"}
          </Button>
        </div>
      </DialogFooter>
      {agent ? (
        <DeleteAgentDialog
          agent={agent}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onDeleted={onDone}
        />
      ) : null}
    </form>
  );
}

/** Create or edit an agent; opened from the chat head, settings or empty state. */
export function AgentEditor() {
  const { agentEditor, setAgentEditor } = useWorkspace();
  const { agents } = useAgents();
  const agent = agents.find((item) => item.id === agentEditor.agentId);
  const close = () => setAgentEditor((state) => ({ ...state, open: false }));
  // An agent deleted elsewhere closes its editor.
  const missing = agentEditor.open && agentEditor.agentId !== null && !agent;
  useEffect(() => {
    if (missing) close();
  });

  return (
    <Dialog
      open={agentEditor.open && !missing}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 flex-row items-center gap-3 border-b p-3 pr-12">
          {agent ? <AgentMonogram agent={agent} /> : null}
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">
              {agent ? agent.name : "新建智能体"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {agent ? "编辑智能体" : "新建智能体"}
            </DialogDescription>
          </div>
        </DialogHeader>
        {agentEditor.open ? (
          // Keyed so each open starts from the agent's saved values.
          <AgentEditorForm
            key={agentEditor.agentId ?? "new"}
            agent={agent}
            onDone={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
