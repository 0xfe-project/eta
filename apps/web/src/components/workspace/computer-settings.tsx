import type { ReactNode } from "react";

import type { Computer, ComputerRuntime } from "@/queries/computers";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { listSeparator, translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  providerLabel,
  runtimeLabel,
  useAddComputer,
  useApproveRuntime,
  useComputers,
  useDeleteComputer,
  useRenewInstall,
  useSetComputerLimit,
} from "@/queries/computers";
import { when } from "./routine-format";

// Remote computers (#45): the user's other machines, whose Paseo and Herdr
// agents work on the task board through the agenvo relay.

const showError = (error: Error) => toast.error(error.message);

const stateLabels: Record<ComputerRuntime["state"], string> = {
  get waiting() {
    return translate("computers:status.awaitingPairing");
  },
  get pairing() {
    return translate("computers:status.awaitingApproval");
  },
  get needs_approval() {
    return translate("computers:status.changedAwaitingApproval");
  },
  get online() {
    return translate("common:status.online");
  },
  get offline() {
    return translate("common:status.offline");
  },
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
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
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
              ? runtime.providers.map(providerLabel).join(listSeparator()) ||
                translateText("runtimes.noProviders")
              : stateLabels[runtime.state]}
          </span>
          {runtime.needs_update ? (
            <span className="text-amber-600 dark:text-amber-500">
              {translateText("runtimes.connectorUpdateRequired", {
                version: runtime.connector_version,
              })}
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
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
  const agents = [
    ...new Set(
      runtimes
        .filter((runtime) => runtime.state === "online")
        .flatMap((runtime) => runtime.providers),
    ),
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">
        {translateText("runtimes.title")}
      </dt>
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
                  {translateText("runtimes.connectorUpdateRequired", {
                    version: runtime.connector_version,
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </dd>
      <dt className="text-muted-foreground">
        {translateText("common:entities.agents")}
      </dt>
      <dd className="min-w-0 break-words">
        {agents.map(providerLabel).join(listSeparator()) || (
          <span className="text-muted-foreground">
            {translateText("runtimes.noAgents")}
          </span>
        )}
      </dd>
    </dl>
  );
}

/**
 * A runtime that asked to pair: approve once the fingerprints match. Each
 * request under its label is listed; more than one means someone else asked
 * too, and only the one `eta setup` printed is to be approved.
 */
function Approval({
  computer,
  runtime,
}: {
  computer: Computer;
  runtime: ComputerRuntime;
}) {
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
  const approve = useApproveRuntime();
  const label = runtimeLabel(runtime.kind);
  const several = runtime.fingerprints.length > 1;
  return (
    <div className="space-y-1.5 bg-muted px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {runtime.state === "needs_approval"
          ? translateText("pairing.fingerprintChanged", { name: label })
          : several
            ? translateText("pairing.multipleRequests", {
                name: label,
                count: runtime.fingerprints.length,
              })
            : translateText("pairing.requestTitle", { name: label })}
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
                  onSuccess: () =>
                    toast(translateText("pairing.approved", { name: label })),
                  onError: showError,
                },
              )
            }
          >
            {translateText("common:actions.approve")}
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
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
  return (
    <div className="flex items-stretch border">
      <code className="min-w-0 flex-1 overflow-x-auto px-2 py-1.5 font-mono text-xs whitespace-nowrap">
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-auto shrink-0 border-l"
        aria-label={translateText("install.copyCommand")}
        onClick={() =>
          void navigator.clipboard
            .writeText(command)
            .then(() => toast(translateText("common:feedback.copied")))
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
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
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
            {made.id
              ? (computer?.name ?? translateText("install.connectTitle"))
              : translateText("actions.add")}
          </DialogTitle>
          <DialogDescription>
            {approveOnly
              ? translateText("pairing.verifyFingerprint")
              : update
                ? translateText("update.description", {
                    versionSuffix: connectorVersion
                      ? translateText("common:format.parenthesizedSuffix", {
                          value: connectorVersion,
                        })
                      : "",
                  })
                : translateText("install.permissionsNotice")}
          </DialogDescription>
        </DialogHeader>
        {approveOnly ? (
          progress
        ) : update ? (
          <ol className="space-y-4">
            <Step
              n={1}
              title={translateText("install.runCommand")}
              active={!done}
            >
              {made.command ? <CommandBox command={made.command} /> : null}
              <p className="text-xs text-muted-foreground">
                {translateText("update.commandHelp")}
              </p>
            </Step>
            <Step
              n={2}
              title={translateText("update.verify")}
              active={connected && !done}
            >
              {connected ? progress : null}
              <p className="text-xs text-muted-foreground">
                {done
                  ? translateText("update.allOnline")
                  : translateText("update.waitingForReconnect")}
              </p>
            </Step>
          </ol>
        ) : (
          <ol className="space-y-4">
            <Step
              n={1}
              title={translateText("install.chooseName")}
              active={!made.id}
            >
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
                    aria-label={translateText("fields.nameLabel")}
                    placeholder={translateText("fields.namePlaceholder")}
                    maxLength={100}
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Button
                    type="submit"
                    disabled={!name.trim() || add.isPending}
                  >
                    {translateText("install.generateCommand")}
                  </Button>
                </form>
              )}
            </Step>
            <Step
              n={2}
              title={translateText("install.runCommand")}
              active={Boolean(made.command) && !connected}
            >
              {made.command ? <CommandBox command={made.command} /> : null}
              <p className="text-xs text-muted-foreground">
                {translateText("install.requirements", {
                  expiryHint: computer?.enroll_expires_at
                    ? translateText("install.commandExpiry", {
                        time: when(computer.enroll_expires_at),
                      })
                    : translateText("install.commandExpiryDefault"),
                })}
              </p>
            </Step>
            <Step
              n={3}
              title={translateText("pairing.verifyAndApprove")}
              active={connected}
            >
              {connected ? (
                progress
              ) : (
                <p className="text-xs text-muted-foreground">
                  {made.command
                    ? translateText("install.waitingForCommand")
                    : translateText("pairing.commandFingerprintHelp")}
                </p>
              )}
            </Step>
          </ol>
        )}
        <DialogFooter>
          <Button variant={done ? "default" : "outline"} onClick={onClose}>
            {done
              ? translateText("common:actions.done")
              : made.id
                ? translateText("common:actions.close")
                : translateText("common:actions.cancel")}
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
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
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
          toast(
            translateText("limits.saved", {
              name: computer.name,
              limit,
            }),
          );
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
          <DialogTitle>
            {translateText("limits.dialogTitle", {
              name: computer.name,
            })}
          </DialogTitle>
          <DialogDescription>
            {translateText("limits.description")}
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
            {translateText("limits.label")}
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
                {translateText("validation:integerRange", {
                  min: MIN_LIMIT,
                  max: MAX_LIMIT,
                })}
              </li>
            )}
            <li>{translateText("limits.queueHelp")}</li>
            <li>{translateText("limits.slotUsageHelp")}</li>
            <li>{translateText("limits.loweringHelp")}</li>
          </ul>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translateText("common:actions.cancel")}
          </Button>
          <Button disabled={!valid || save.isPending} onClick={submit}>
            {translateText("common:actions.save")}
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
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
  const {
    active_runs: active,
    max_active_runs: max,
    queued_runs: queued,
  } = computer;
  const note =
    active > max
      ? translateText("limits.loweredHint")
      : queued && active >= max
        ? translateText("limits.atCapacity")
        : "";
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        {translateText("limits.summaryLabel")}
        <span className="text-foreground tabular-nums">{active}</span>/
        <span className="tabular-nums">{max}</span>
        {queued ? (
          <>{translateText("limits.queuedSummary", { count: queued })}</>
        ) : null}
        {note ? <span className="block">{note}</span> : null}
      </span>
      <Button
        variant="ghost"
        size="xs"
        aria-label={translateText("limits.adjustLabel", {
          name: computer.name,
        })}
        onClick={onEdit}
      >
        {translateText("limits.adjust")}
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
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
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
          label={
            computer.online
              ? translateText("common:status.online")
              : translateText("common:status.offline")
          }
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
            {translateText("common:actions.install")}
          </Button>
        ) : approvals.length ? (
          <Button size="sm" onClick={() => onOpen({ id: computer.id })}>
            {translateText("pairing.approveTarget", {
              target:
                approvals.length === 1
                  ? ` ${runtimeLabel(approvals[0].kind)}`
                  : translateText("pairing.label"),
            })}
          </Button>
        ) : updates.length ? (
          <Button size="sm" disabled={renew.isPending} onClick={startUpdate}>
            {translateText("common:actions.update")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={translateText("common:accessibility.itemActions", {
                name: computer.name,
              })}
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
                {translateText("actions.updateConnector")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirming(true)}
            >
              {translateText("actions.revokeAndRemove")}
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
        <p className="text-xs text-muted-foreground">
          {translateText("status.awaitingInstallation")}
        </p>
      ) : !computer.online ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {translateText("common:status.offline")}
          <Tooltip open={offlineHintOpen} onOpenChange={setOfflineHintOpen}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={translateText("offline.detailsLabel", {
                  name: computer.name,
                })}
                onClick={() => setOfflineHintOpen((open) => !open)}
              >
                <InfoIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{translateText("offline.help")}</TooltipContent>
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
            <AlertDialogTitle>
              {translateText("revoke.confirmTitle", { name: computer.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("revoke.confirmDescription", {
                activeRunsHint: computer.active_runs
                  ? translateText("revoke.cancelActiveRuns", {
                      count: computer.active_runs,
                    })
                  : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate(computer.id, {
                  onSuccess: () =>
                    toast(
                      translateText("revoke.success", {
                        name: computer.name,
                      }),
                    ),
                  onError: showError,
                })
              }
            >
              {translateText("actions.revokeAndRemove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Settings → 远程电脑. */
export function ComputerSettings() {
  const { t: translateText } = useTranslation([
    "computers",
    "common",
    "validation",
  ] as const);
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
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        {usable ? (
          <Button size="sm" variant="outline" onClick={() => open()}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("actions.add")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <LoadError
          what={translateText("title")}
          error={error}
          onRetry={() => void refetch()}
        />
      ) : !data ? (
        <Loading rows={2} />
      ) : !usable ? (
        <p className="text-sm text-muted-foreground">
          {translateText("empty.relayNotConfigured")}
        </p>
      ) : (
        <>
          {data.relay_error ? (
            <p role="alert" className="text-xs text-destructive">
              {translateText("errors.relayConnection", {
                relayUrl: data.relay_url,
                message: data.relay_error,
              })}
            </p>
          ) : null}
          {data.computers.some((c) => outdated(c).length) ? (
            <p
              role="status"
              className="text-xs text-amber-600 dark:text-amber-500"
            >
              {translateText("update.versionMismatch", {
                version: data.connector_version
                  ? ` ${data.connector_version}`
                  : "",
              })}
            </p>
          ) : null}
          {data.computers.length ? (
            <div className="@container">
              <ul
                aria-label={translateText("title")}
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
            <Empty icon={DesktopIcon} title={translateText("empty.title")}>
              {translateText("empty.description")}
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
