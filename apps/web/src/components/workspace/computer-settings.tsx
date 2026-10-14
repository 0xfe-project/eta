import type { ReactNode } from "react";
import type { Computer, ComputerRuntime } from "@/queries/tasks";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { InfoIcon } from "@phosphor-icons/react/Info";
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
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  useAddComputer,
  useApproveRuntime,
  useComputers,
  useDeleteComputer,
  useRenewInstall,
  useSetComputerLimit,
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
        <li
          key={runtime.kind}
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5"
        >
          <StatusDot
            online={runtime.state === "online"}
            label={stateLabels[runtime.state]}
          />
          <span className="font-medium">{runtimeLabel(runtime.kind)}</span>
          <span className="min-w-0 text-muted-foreground">
            {runtime.state === "online"
              ? runtime.providers.map(providerLabel).join("、") ||
                "没有可用的 provider"
              : stateLabels[runtime.state]}
          </span>
          {runtime.needs_update ? (
            <span className="text-amber-600 dark:text-amber-500">
              connector {runtime.connector_version}，需要更新
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A card's runtimes on one line, and below them the agents they offer
 * together: which runtime offers which agent does not matter here.
 */
function RuntimeSummary({ runtimes }: { runtimes: ComputerRuntime[] }) {
  const agents = [
    ...new Set(
      runtimes
        .filter((runtime) => runtime.state === "online")
        .flatMap((runtime) => runtime.providers),
    ),
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">运行时</dt>
      <dd>
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
          {runtimes.map((runtime) => (
            <li
              key={runtime.kind}
              className="flex min-w-0 flex-wrap items-center gap-x-1.5"
            >
              <StatusDot
                online={runtime.state === "online"}
                label={stateLabels[runtime.state]}
              />
              <span className="font-medium">{runtimeLabel(runtime.kind)}</span>
              {runtime.state === "online" ? null : (
                <span className="text-muted-foreground">
                  {stateLabels[runtime.state]}
                </span>
              )}
              {runtime.needs_update ? (
                <span className="text-amber-600 dark:text-amber-500">
                  connector {runtime.connector_version}，需要更新
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </dd>
      <dt className="text-muted-foreground">智能体</dt>
      <dd className="min-w-0 break-words">
        {agents.map(providerLabel).join("、") || (
          <span className="text-muted-foreground">没有可用的智能体</span>
        )}
      </dd>
    </dl>
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

const outdated = (computer: Computer) =>
  computer.runtimes.filter((runtime) => runtime.needs_update);

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
 * What the dialog is opened on: nothing (a new computer), a computer and
 * its new install command (to install or, with `update`, to update it), or
 * a computer alone (to approve its runtimes).
 */
interface Target {
  id?: string;
  command?: string;
  update?: boolean;
}

/**
 * One computer's way in, all three steps in view from the start: a name,
 * the install command, then the computer connecting and being approved.
 * For an installed computer, only its runtimes waiting for approval; to
 * update one, the update command and then its runtimes coming back.
 */
function ComputerDialog({
  target,
  computers,
  connectorVersion,
  onClose,
}: {
  target: Target;
  computers: Computer[];
  connectorVersion?: string | null;
  onClose: () => void;
}) {
  const add = useAddComputer();
  const [name, setName] = useState("");
  const [made, setMade] = useState(target);
  const computer = computers.find((c) => c.id === made.id);
  const approvals = computer ? pending(computer) : [];
  const connected = Boolean(computer?.runtimes.length);
  const done =
    computer?.online &&
    connected &&
    !approvals.length &&
    !(computer && outdated(computer).length);
  // Opened on an installed computer to approve; decided once, so the steps
  // stay put while the computer enrolls.
  const approveOnly = Boolean(target.id && !target.command);
  const update = Boolean(target.update);

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
              : update
                ? `把这台电脑上的 axp 和 agenvo connector 更新到 AXP 当前提供的版本${connectorVersion ? `（${connectorVersion}）` : ""}，并连到 AXP 当前的中继地址。`
                : "智能体会在那台电脑上以完全权限运行，请只接入专门用来干活的电脑。"}
          </DialogDescription>
        </DialogHeader>
        {approveOnly ? (
          progress
        ) : update ? (
          <ol className="space-y-4">
            <Step n={1} title="在那台电脑的终端里运行" active={!done}>
              {made.command ? <CommandBox command={made.command} /> : null}
              <p className="text-xs text-muted-foreground">
                它会下载新的 axp，安装新的 connector，把 connector
                改到当前的中继地址并重启它们的服务，不需要重新配对。Paseo 和
                Herdr 里正在运行的智能体不会被停止。命令只能用一次，24
                小时内有效；运行后这台电脑原来的令牌失效。
              </p>
            </Step>
            <Step n={2} title="确认已更新" active={connected && !done}>
              {connected ? progress : null}
              <p className="text-xs text-muted-foreground">
                {done
                  ? "已更新，所有运行时都在线。"
                  : "等待那台电脑重新连上。若出现“等待批准”（connector 有变化），核对指纹与终端里打印的一致后批准。"}
              </p>
            </Step>
          </ol>
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

/**
 * One card per computer: its name and whatever needs doing on top, then
 * where it runs and its runtimes.
 */
// The control plane's bounds on a computer's limit.
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;

/**
 * How many runs the computer works on at once, as the runner counts them:
 * every run that has started and not ended, the assignee's and assisting
 * agents' alike, on Paseo and Herdr together.
 */
function LimitDialog({
  computer,
  onClose,
}: {
  computer: Computer;
  onClose: () => void;
}) {
  const save = useSetComputerLimit();
  const [value, setValue] = useState(String(computer.max_active_runs));
  const limit = Number(value);
  const valid =
    /^\d+$/.test(value.trim()) && limit >= MIN_LIMIT && limit <= MAX_LIMIT;
  const submit = () => {
    if (!valid) return;
    save.mutate(
      { id: computer.id, maxActiveRuns: limit },
      {
        onSuccess: () => {
          toast(`${computer.name} 最多同时执行 ${limit} 个`);
          onClose();
        },
        onError: showError,
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{computer.name} 的并发执行上限</DialogTitle>
          <DialogDescription>
            这台电脑上最多同时执行几个任务运行。主执行、协助和审查各算一个，Paseo
            和 Herdr 共用这个上限。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Label htmlFor={`limit-${computer.id}`} className="text-xs">
            并发执行数
          </Label>
          <Input
            id={`limit-${computer.id}`}
            type="number"
            inputMode="numeric"
            min={MIN_LIMIT}
            max={MAX_LIMIT}
            step={1}
            value={value}
            aria-invalid={!valid}
            aria-describedby={`limit-${computer.id}-hint`}
            onChange={(event) => setValue(event.target.value)}
            className="w-28"
          />
          <ul
            id={`limit-${computer.id}-hint`}
            className="list-disc space-y-1 pl-4 text-xs text-muted-foreground"
          >
            {valid ? null : (
              <li className="text-destructive">
                请输入 {MIN_LIMIT} 到 {MAX_LIMIT} 之间的整数。
              </li>
            )}
            <li>
              超过上限的运行会排队，不会失败；有运行结束后，按排队先后自动开始。
            </li>
            <li>
              从开始打开工作区起，到确认结束（完成、失败或停止）为止都占名额；电脑离线时，正在执行的仍然占着。
            </li>
            <li>调低不会停止正在执行的运行：它们做完后，再按新上限派新的。</li>
          </ul>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!valid || save.isPending} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The computer's places at work, its limit and its queue. */
function Load({
  computer,
  onEdit,
}: {
  computer: Computer;
  onEdit: () => void;
}) {
  const {
    active_runs: active,
    max_active_runs: max,
    queued_runs: queued,
  } = computer;
  const note =
    active > max
      ? "上限调低了：正在执行的做完后再派新的"
      : queued && active >= max
        ? "已满，新的运行排队等名额"
        : "";
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        并发执行 <span className="text-foreground tabular-nums">{active}</span>/
        <span className="tabular-nums">{max}</span>
        {queued ? <> · 排队 {queued}</> : null}
        {note ? <span className="block">{note}</span> : null}
      </span>
      <Button
        variant="ghost"
        size="xs"
        aria-label={`调整 ${computer.name} 的并发执行上限`}
        onClick={onEdit}
      >
        调整上限
      </Button>
    </div>
  );
}

function ComputerCard({
  computer,
  onOpen,
}: {
  computer: Computer;
  onOpen: (target: Target) => void;
}) {
  const renew = useRenewInstall();
  const remove = useDeleteComputer();
  const [confirming, setConfirming] = useState(false);
  const [offlineHintOpen, setOfflineHintOpen] = useState(false);
  const [editingLimit, setEditingLimit] = useState(false);
  const approvals = pending(computer);
  const updates = outdated(computer);
  const startUpdate = () =>
    renew.mutate(computer.id, {
      onSuccess: (install) =>
        onOpen({ id: computer.id, command: install.command, update: true }),
      onError: showError,
    });
  const details = [
    computer.hostname,
    computer.os &&
      [osLabels[computer.os] ?? computer.os, computer.arch]
        .filter(Boolean)
        .join(" "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex min-w-0 flex-col gap-2 border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot
          online={computer.online}
          label={computer.online ? "在线" : "离线"}
        />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={computer.name}
        >
          {computer.name}
        </span>
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
        ) : updates.length ? (
          <Button size="sm" disabled={renew.isPending} onClick={startUpdate}>
            更新
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
            {computer.enrolled ? (
              <DropdownMenuItem
                disabled={renew.isPending}
                onSelect={startUpdate}
              >
                更新 connector
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirming(true)}
            >
              撤销并移除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {details ? (
        <p className="truncate text-xs text-muted-foreground" title={details}>
          {details}
        </p>
      ) : null}
      {!computer.enrolled ? (
        <p className="text-xs text-muted-foreground">等待安装</p>
      ) : !computer.online ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          离线
          <Tooltip open={offlineHintOpen} onOpenChange={setOfflineHintOpen}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={`${computer.name} 的离线说明`}
                onClick={() => setOfflineHintOpen((open) => !open)}
              >
                <InfoIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              离线的电脑如果开着机，可能是 connector
              版本过旧或中继地址变了：在它的“⋯”菜单里选“更新
              connector”，按提示在那台电脑上运行命令。
            </TooltipContent>
          </Tooltip>
        </div>
      ) : (
        <RuntimeSummary runtimes={computer.runtimes} />
      )}
      {computer.enrolled ? (
        <Load computer={computer} onEdit={() => setEditingLimit(true)} />
      ) : null}
      {editingLimit ? (
        <LimitDialog
          computer={computer}
          onClose={() => setEditingLimit(false)}
        />
      ) : null}
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
    target: Target;
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
          {data.computers.some((c) => outdated(c).length) ? (
            <p
              role="status"
              className="text-xs text-amber-600 dark:text-amber-500"
            >
              有电脑的 agenvo connector 与 AXP 提供的版本
              {data.connector_version ? ` ${data.connector_version}` : ""}{" "}
              不一致：点那台电脑上的“更新”，按提示在那台电脑上运行命令。
            </p>
          ) : null}
          {data.computers.length ? (
            <div className="@container">
              <ul
                aria-label="远程电脑"
                className="grid grid-cols-1 gap-2 @lg:grid-cols-2"
              >
                {data.computers.map((computer) => (
                  <ComputerCard
                    key={computer.id}
                    computer={computer}
                    onOpen={open}
                  />
                ))}
              </ul>
            </div>
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
              connectorVersion={data.connector_version}
              onClose={() => setDialog(undefined)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
