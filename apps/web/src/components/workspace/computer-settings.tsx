import type { Computer, ComputerRuntime } from "@/queries/tasks";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useAddComputer,
  useApproveRuntime,
  useComputers,
  useDeleteComputer,
  useRenewInstall,
} from "@/queries/tasks";
import { when } from "./routine-format";
import { providerLabel, runtimeLabel } from "./task-format";

// Remote computers (#45): the user's other machines, whose Paseo and Herdr
// agents work on the task board through the agenvo relay.

const showError = (error: Error) => toast.error(error.message);

const stateLabels: Record<ComputerRuntime["state"], string> = {
  waiting: "等待那台电脑发起配对",
  pairing: "等待批准",
  needs_approval: "运行时有变化，等待批准",
  online: "在线",
  offline: "离线",
};

function InstallCommand({ command }: { command: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch border">
        <code className="min-w-0 flex-1 overflow-x-auto px-2 py-1.5 text-xs whitespace-nowrap">
          {command}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-auto shrink-0 border-l"
          aria-label="复制安装命令"
          onClick={() =>
            void navigator.clipboard
              .writeText(command)
              .then(() => toast("已复制"))
          }
        >
          <CopyIcon aria-hidden="true" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        在那台电脑的终端里运行。它需要 Node.js 24.13+，以及正在运行的 Paseo
        daemon 或 Herdr；安装 agenvo connector 和 axp
        命令，并注册为开机启动的服务。命令只能用一次，24 小时内有效。
      </p>
    </div>
  );
}

function RuntimeRow({
  computer,
  runtime,
}: {
  computer: Computer;
  runtime: ComputerRuntime;
}) {
  const approve = useApproveRuntime();
  const waiting =
    runtime.state === "pairing" || runtime.state === "needs_approval";
  return (
    <li className="space-y-1.5 py-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0",
            runtime.state === "online" && "bg-emerald-500",
            runtime.state === "offline" && "bg-muted-foreground/40",
            waiting && "bg-amber-500 motion-safe:animate-pulse",
            runtime.state === "waiting" && "bg-muted-foreground/40",
          )}
        />
        <span className="font-medium">{runtimeLabel(runtime.kind)}</span>
        <span className="text-xs text-muted-foreground">
          {stateLabels[runtime.state]}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {runtime.providers.map(providerLabel).join("、") ||
            "没有可用的 provider"}
        </span>
      </div>
      {waiting && runtime.fingerprint ? (
        <div className="space-y-1.5 border-l-2 border-amber-500 pl-3">
          <p className="text-xs text-muted-foreground">
            核对指纹与那台电脑上安装命令打印的一致，再批准：
          </p>
          <code className="block text-xs break-all">{runtime.fingerprint}</code>
          <Button
            size="sm"
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate(
                { id: computer.id, kind: runtime.kind },
                {
                  onSuccess: () =>
                    toast(`已批准 ${runtimeLabel(runtime.kind)}`),
                  onError: showError,
                },
              )
            }
          >
            指纹一致，批准
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function ComputerCard({
  computer,
  command,
  onCommand,
}: {
  computer: Computer;
  command?: string;
  onCommand: (command: string) => void;
}) {
  const renew = useRenewInstall();
  const remove = useDeleteComputer();
  return (
    <li className="space-y-2 border p-3">
      <div className="flex items-start gap-2">
        <DesktopIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{computer.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {computer.enrolled
              ? [
                  computer.online ? "在线" : "离线",
                  computer.hostname,
                  computer.os && `${computer.os}/${computer.arch}`,
                  computer.active_runs
                    ? `${computer.active_runs} 个任务进行中`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : computer.enroll_expires_at
                ? `等待安装（安装命令 ${when(computer.enroll_expires_at)} 前有效）`
                : "等待安装"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="更多">
              <DotsThreeIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {computer.enrolled ? null : (
              <DropdownMenuItem
                onSelect={() =>
                  renew.mutate(computer.id, {
                    onSuccess: (install) => onCommand(install.command),
                    onError: showError,
                  })
                }
              >
                重新生成安装命令
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                remove.mutate(computer.id, {
                  onSuccess: () => toast(`已撤销 ${computer.name}`),
                  onError: showError,
                })
              }
            >
              撤销并移除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!computer.enrolled && command ? (
        <InstallCommand command={command} />
      ) : null}
      {computer.runtimes.length ? (
        <ul className="divide-y border-t">
          {computer.runtimes.map((runtime) => (
            <RuntimeRow
              key={runtime.kind}
              computer={computer}
              runtime={runtime}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AddComputer({
  onAdded,
}: {
  onAdded: (id: string, command: string) => void;
}) {
  const add = useAddComputer();
  const [name, setName] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        add.mutate(name.trim(), {
          onSuccess: (install) => {
            setName("");
            onAdded(install.computer.id, install.command);
          },
          onError: showError,
        });
      }}
    >
      <Input
        aria-label="电脑名称"
        placeholder="电脑名称，例如：家里的 Mac mini"
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit" disabled={!name.trim() || add.isPending}>
        <PlusIcon aria-hidden="true" />
        添加电脑
      </Button>
    </form>
  );
}

export function ComputerSettings() {
  const { data, error } = useComputers();
  // Install commands are shown once, right after they are made.
  const [commands, setCommands] = useState<Record<string, string>>({});
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">远程电脑</h2>
        <p className="text-xs text-muted-foreground">
          接入你的其他电脑后，可以把任务指派给它们上面的 Paseo 或 Herdr
          智能体：在已有的工作区里干活，或者新开一个
          worktree。智能体以完全权限运行，请只接入专门用来干活的电脑。
        </p>
      </div>
      {error ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : !data ? null : !data.relay_configured ? (
        <p className="text-sm text-muted-foreground">
          服务器没有配置中继（agenvo relay），暂时不能接入远程电脑。
        </p>
      ) : (
        <>
          {data.relay_error ? (
            <p className="text-xs text-destructive">
              无法连接中继：{data.relay_error}
            </p>
          ) : null}
          <AddComputer
            onAdded={(id, command) =>
              setCommands({ ...commands, [id]: command })
            }
          />
          <ul className="space-y-2">
            {data.computers.map((computer) => (
              <ComputerCard
                key={computer.id}
                computer={computer}
                command={commands[computer.id]}
                onCommand={(command) =>
                  setCommands({ ...commands, [computer.id]: command })
                }
              />
            ))}
          </ul>
          {data.relay_origin ? (
            <p className="text-xs text-muted-foreground">
              中继：<code>{data.relay_origin}</code>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
