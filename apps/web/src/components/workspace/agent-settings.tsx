import { useState } from "react";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { TrashIcon } from "@phosphor-icons/react/Trash";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useCreateAgent,
  useDeleteAgent,
  useRenameAgent,
  type Agent,
} from "@/queries/chat";
import { AgentMonogram, AgentStatus } from "./agent-identity";

function NameForm({
  initial = "",
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <Input
        autoFocus
        aria-label="智能体名称"
        placeholder="智能体名称"
        maxLength={100}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onCancel()}
        className="h-8 min-w-0 flex-1"
      />
      <Button type="submit" size="sm" disabled={!name.trim() || pending}>
        {submitLabel}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        取消
      </Button>
    </form>
  );
}

function AgentRow({
  agent,
  current,
  onSelect,
}: {
  agent: Agent;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rename = useRenameAgent();
  const remove = useDeleteAgent();
  const onError = (error: Error) => toast.error(error.message);

  return (
    <li
      className={cn(
        "group flex min-h-14 items-center gap-3 px-3 py-2 transition-colors duration-[60ms] ease-linear",
        current ? "bg-accent" : "hover:bg-muted/60",
      )}
    >
      <AgentMonogram
        agent={agent}
        className={current ? "bg-foreground text-background" : undefined}
      />
      {renaming ? (
        <NameForm
          initial={agent.name}
          submitLabel="保存"
          pending={rename.isPending}
          onCancel={() => setRenaming(false)}
          onSubmit={(name) =>
            rename.mutate(
              { id: agent.id, name },
              { onSuccess: () => setRenaming(false), onError },
            )
          }
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => onSelect(agent.id)}
            aria-current={current ? "true" : undefined}
            className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline"
          >
            <span className="flex max-w-full items-center gap-2">
              <span className="truncate text-sm font-medium">{agent.name}</span>
              {current ? <Badge variant="secondary">当前</Badge> : null}
            </span>
            <span className="text-xs">
              <AgentStatus status={agent.status} />
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${agent.name} 的操作`}
              >
                <DotsThreeIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem
                disabled={current}
                onSelect={() => onSelect(agent.id)}
              >
                <CheckIcon aria-hidden="true" />
                设为当前
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <PencilSimpleIcon aria-hidden="true" />
                重命名
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirming(true)}
              >
                <TrashIcon aria-hidden="true" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
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
                  onSuccess: () => toast.success(`已删除「${agent.name}」`),
                  onError,
                })
              }
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function AgentSettings({
  agents,
  currentId,
  creating,
  onCreatingChange,
  onSelect,
}: {
  agents: Agent[];
  currentId: string | undefined;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const create = useCreateAgent();

  const form = (
    <NameForm
      submitLabel="创建"
      pending={create.isPending}
      onCancel={() => onCreatingChange(false)}
      onSubmit={(name) =>
        create.mutate(name, {
          onSuccess: (agent) => {
            onSelect(agent.id);
            onCreatingChange(false);
            toast.success(`已创建「${agent.name}」`);
          },
          onError: (error) => toast.error(error.message),
        })
      }
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">智能体</h2>
          <p className="text-xs text-muted-foreground">
            {agents.length ? `共 ${agents.length} 个` : "尚未创建"}
          </p>
        </div>
        {agents.length && !creating ? (
          <Button size="sm" onClick={() => onCreatingChange(true)}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            新建
          </Button>
        ) : null}
      </div>

      {agents.length === 0 && !creating ? (
        <div className="flex flex-col items-center gap-3 border border-dashed px-6 py-10 text-center">
          <RobotIcon
            aria-hidden="true"
            className="size-8 text-muted-foreground"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">还没有智能体</p>
            <p className="text-xs text-muted-foreground">
              每个智能体有独立的工作区和会话。
            </p>
          </div>
          <Button size="sm" onClick={() => onCreatingChange(true)}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            新建智能体
          </Button>
        </div>
      ) : (
        <ul aria-label="智能体列表" className="divide-y border">
          {creating ? (
            <li className="flex min-h-14 items-center gap-3 px-3 py-2">
              <AgentMonogram agent={{ name: "+" }} />
              {form}
            </li>
          ) : null}
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              current={agent.id === currentId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
