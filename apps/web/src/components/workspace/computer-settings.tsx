import type { ReactNode } from "react";
import type { Computer, ComputerRuntime } from "@/queries/tasks";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
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
  waiting: "等待配对",
  pairing: "等待批准",
  needs_approval: "有变化，等待批准",
  online: "在线",
  offline: "离线",
};

const osLabels: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
};

const needsApproval = (runtime: ComputerRuntime) =>
  runtime.state === "pairing" || runtime.state === "needs_approval";

function StatusDot({ online, label }: { online: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "size-1.5 shrink-0",
        online ? "bg-emerald-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

/** Paseo · Claude、Codex, with the state when it is not simply online. */
function Runtimes({ runtimes }: { runtimes: ComputerRuntime[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {runtimes.map((runtime) => (
        <li key={runtime.kind} className="flex items-center gap-1.5">
          <StatusDot
            online={runtime.state === "online"}
            label={stateLabels[runtime.state]}
          />
          <span className="font-medium">{runtimeLabel(runtime.kind)}</span>
          <span className="text-muted-foreground">
            {runtime.state === "online"
              ? runtime.providers.map(providerLabel).join("、") ||
                "没有可用的 provider"
              : stateLabels[runtime.state]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A runtime that asked to pair: approve once the fingerprints match. Each
 * request under its label is listed; more than one means someone else asked
 * too, and only the one `axp setup` printed is to be approved.
 */
function Approval({
  computer,
  runtime,
}: {
  computer: Computer;
  runtime: ComputerRuntime;
}) {
  const approve = useApproveRuntime();
  const label = runtimeLabel(runtime.kind);
  const several = runtime.fingerprints.length > 1;
  return (
    <div className="space-y-1.5 bg-muted px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {runtime.state === "needs_approval"
          ? `${label} 的指纹变了`
          : several
            ? `${label} 收到 ${runtime.fingerprints.length} 个配对请求：只批准与电脑上 axp setup 输出一致的那个`
            : `${label} 请求配对`}
      </p>
      {runtime.fingerprints.map((fingerprint) => (
        <div key={fingerprint} className="flex items-center gap-3">
          <code className="min-w-0 flex-1 font-mono text-xs break-all">
            {fingerprint}
          </code>
          <Button
            size="sm"
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate(
                { id: computer.id, kind: runtime.kind, fingerprint },
                {
                  onSuccess: () => toast(`已批准 ${label}`),
                  onError: showError,
                },
              )
            }
          >
            批准
          </Button>
        </div>
      ))}
    </div>
  );
}

const pending = (computer: Computer) =>
  computer.runtimes.filter(
    (runtime) => needsApproval(runtime) && runtime.fingerprints.length > 0,
  );

function Step({
  n,
  title,
  active,
  children,
}: {
  n: number;
  title: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <li
      aria-current={active ? "step" : undefined}
      className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 gap-y-1.5"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-5 items-center justify-center text-xs tabular-nums",
          active
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {n}
      </span>
      <p
        className={cn(
          "self-center text-sm font-medium",
          !active && "text-muted-foreground",
        )}
      >
        {title}
      </p>
      <div className="col-start-2 space-y-2">{children}</div>
    </li>
  );
}

function CommandBox({ command }: { command: string }) {
  return (
    <div className="flex items-stretch border">
      <code className="min-w-0 flex-1 overflow-x-auto px-2 py-1.5 font-mono text-xs whitespace-nowrap">
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
  );
}

/**
 * One computer's way in, all three steps in view from the start: a name,
 * the install command, then the computer connecting and being approved.
 * For an installed computer, only its runtimes waiting for approval.
 */
function ComputerDialog({
  target,
  computers,
  onClose,
}: {
  target: { id?: string; command?: string };
  computers: Computer[];
  onClose: () => void;
}) {
  const add = useAddComputer();
  const [name, setName] = useState("");
  const [made, setMade] = useState(target);
  const computer = computers.find((c) => c.id === made.id);
  const approvals = computer ? pending(computer) : [];
  const connected = Boolean(computer?.runtimes.length);
  const done = computer?.online && connected && !approvals.length;
  // Opened on an installed computer to approve; decided once, so the steps
  // stay put while the computer enrolls.
  const approveOnly = Boolean(target.id && !target.command);

  const progress = (
    <div aria-live="polite" className="space-y-2">
      {connected ? (
        <Runtimes
          runtimes={computer!.runtimes.filter(
            (runtime) => !approvals.includes(runtime),
          )}
        />
      ) : null}
      {approvals.map((runtime) => (
        <Approval key={runtime.kind} computer={computer!} runtime={runtime} />
      ))}
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {made.id ? (computer?.name ?? "接入电脑") : "添加电脑"}
          </DialogTitle>
          <DialogDescription>
            {approveOnly
              ? "核对指纹与那台电脑终端里打印的一致，再批准。"
              : "智能体会在那台电脑上以完全权限运行，请只接入专门用来干活的电脑。"}
          </DialogDescription>
        </DialogHeader>
        {approveOnly ? (
          progress
        ) : (
          <ol className="space-y-4">
            <Step n={1} title="起个名字" active={!made.id}>
              {made.id ? (
                <p className="text-sm text-muted-foreground">
                  {computer?.name}
                </p>
              ) : (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!name.trim()) return;
                    add.mutate(name.trim(), {
                      onSuccess: (install) =>
                        setMade({
                          id: install.computer.id,
                          command: install.command,
                        }),
                      onError: showError,
                    });
                  }}
                >
                  <Input
                    aria-label="电脑名称"
                    placeholder="例如：家里的 Mac mini"
                    maxLength={100}
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Button
                    type="submit"
                    disabled={!name.trim() || add.isPending}
                  >
                    生成安装命令
                  </Button>
                </form>
              )}
            </Step>
            <Step
              n={2}
              title="在那台电脑的终端里运行"
              active={Boolean(made.command) && !connected}
            >
              {made.command ? <CommandBox command={made.command} /> : null}
              <p className="text-xs text-muted-foreground">
                需要 Node.js 24.13+，以及正在运行的 Paseo daemon 或
                Herdr。它会安装 agenvo connector 和 axp
                命令，并注册为开机启动的服务。
                {computer?.enroll_expires_at
                  ? `命令只能用一次，${when(computer.enroll_expires_at)} 前有效。`
                  : "命令只能用一次，24 小时内有效。"}
              </p>
            </Step>
            <Step n={3} title="核对指纹，批准连接" active={connected}>
              {connected ? (
                progress
              ) : (
                <p className="text-xs text-muted-foreground">
                  {made.command
                    ? "等待那台电脑运行命令…"
                    : "命令运行后，那台电脑的终端会打印一个指纹，与这里显示的一致再批准。"}
                </p>
              )}
            </Step>
          </ol>
        )}
        <DialogFooter>
          <Button variant={done ? "default" : "outline"} onClick={onClose}>
            {done ? "完成" : made.id ? "关闭" : "取消"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One line per computer; whatever needs doing is the one button on it. */
function ComputerRow({
  computer,
  onOpen,
}: {
  computer: Computer;
  onOpen: (target: { id: string; command?: string }) => void;
}) {
  const renew = useRenewInstall();
  const remove = useDeleteComputer();
  const [confirming, setConfirming] = useState(false);
  const approvals = pending(computer);
  const online = computer.runtimes.filter((r) => r.state === "online");
  const details = [
    computer.hostname,
    computer.os &&
      [osLabels[computer.os] ?? computer.os, computer.arch]
        .filter(Boolean)
        .join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
  const status = !computer.enrolled
    ? "等待安装"
    : !computer.online
      ? "离线"
      : [
          online.map((r) => runtimeLabel(r.kind)).join("、"),
          computer.active_runs ? `${computer.active_runs} 个任务进行中` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <li className="flex h-11 items-center gap-2 px-3">
      <StatusDot
        online={computer.online}
        label={computer.online ? "在线" : "离线"}
      />
      <span className="shrink-0 text-sm font-medium">{computer.name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {details}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
      {!computer.enrolled ? (
        <Button
          size="sm"
          variant="outline"
          disabled={renew.isPending}
          onClick={() =>
            renew.mutate(computer.id, {
              onSuccess: (install) =>
                onOpen({ id: computer.id, command: install.command }),
              onError: showError,
            })
          }
        >
          安装
        </Button>
      ) : approvals.length ? (
        <Button size="sm" onClick={() => onOpen({ id: computer.id })}>
          批准
          {approvals.length === 1
            ? ` ${runtimeLabel(approvals[0].kind)}`
            : "配对"}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${computer.name} 的操作`}
          >
            <DotsThreeIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
          >
            撤销并移除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销 {computer.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              指派给它的任务会变成未指派
              {computer.active_runs
                ? `，进行中的 ${computer.active_runs} 个会被取消`
                : ""}
              。要再接入，需要重新添加。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate(computer.id, {
                  onSuccess: () => toast(`已撤销 ${computer.name}`),
                  onError: showError,
                })
              }
            >
              撤销并移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Settings → 远程电脑. */
export function ComputerSettings() {
  const { data, error, refetch } = useComputers();
  // Install commands are shown once, in the dialog, right after they are
  // made; approvals happen there too. `n` keys the dialog so every open
  // starts fresh.
  const [dialog, setDialog] = useState<{
    n: number;
    target: { id?: string; command?: string };
  }>();
  const open = (target: { id?: string; command?: string } = {}) =>
    setDialog((d) => ({ n: (d?.n ?? 0) + 1, target }));
  const usable = data?.relay_configured;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">远程电脑</h2>
        {usable ? (
          <Button size="sm" variant="outline" onClick={() => open()}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            添加电脑
          </Button>
        ) : null}
      </div>
      {error ? (
        <LoadError
          what="远程电脑"
          error={error}
          onRetry={() => void refetch()}
        />
      ) : !data ? (
        <Loading rows={2} />
      ) : !usable ? (
        <p className="text-sm text-muted-foreground">
          服务器没有配置中继（agenvo relay），暂时不能接入远程电脑。
        </p>
      ) : (
        <>
          {data.relay_error ? (
            <p role="alert" className="text-xs text-destructive">
              无法连接中继 {data.relay_url}：{data.relay_error}
            </p>
          ) : null}
          {data.computers.length ? (
            <ul aria-label="远程电脑" className="divide-y border">
              {data.computers.map((computer) => (
                <ComputerRow
                  key={computer.id}
                  computer={computer}
                  onOpen={open}
                />
              ))}
            </ul>
          ) : (
            <Empty icon={DesktopIcon} title="还没有接入电脑">
              接入后，可以把任务指派给它上面的 Paseo 或 Herdr 智能体。
            </Empty>
          )}
          {dialog ? (
            <ComputerDialog
              key={dialog.n}
              target={dialog.target}
              computers={data.computers}
              onClose={() => setDialog(undefined)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
