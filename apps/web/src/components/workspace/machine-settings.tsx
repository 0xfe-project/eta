import type { MachineView } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
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
import { cn } from "@/lib/utils";
import {
  useApproveMachine,
  useEnrollMachine,
  useRenameMachine,
  useRevokeMachine,
  useSetMaxActiveRuns,
} from "@/queries/machines";
import { useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { when } from "./routine-format";

// Settings → 机器: the primary and the machines that run the daemon. A machine joins by an install
// command, shows up here as pending, and is let in when the user pastes back the fingerprint its
// terminal printed.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

const osLabels: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function StatusDot({
  status,
  label,
}: {
  status: MachineView["status"];
  label: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "size-1.5 shrink-0",
        status === "online" && "bg-state-success",
        status === "pending" && "bg-state-warning",
        (status === "offline" || status === "revoked") &&
          "bg-muted-foreground/40",
      )}
    />
  );
}

/** A pending machine: approved once the pasted fingerprint is the one its terminal printed. */
function Approval({ machine }: { machine: MachineView }) {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const approve = useApproveMachine();
  const [fingerprint, setFingerprint] = useState("");
  const submit = () => {
    if (!fingerprint.trim() || approve.isPending) return;
    approve.mutate(
      { machineId: machine.id, fingerprint: fingerprint.trim() },
      {
        onSuccess: () =>
          toast(translateText("approval.approved", { name: machine.name })),
        onError: showError,
      },
    );
  };
  return (
    <form
      className="space-y-1.5 bg-muted px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-xs text-muted-foreground">
        {translateText("approval.request", { name: machine.name })}
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label={translateText("approval.label", { name: machine.name })}
          placeholder={translateText("approval.placeholder")}
          value={fingerprint}
          onChange={(event) => setFingerprint(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!fingerprint.trim() || approve.isPending}
        >
          {translateText("common:actions.approve")}
        </Button>
      </div>
    </form>
  );
}

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
  const { t: translateText } = useTranslation(["machines", "common"] as const);
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

interface Made {
  command: string;
  expiresAt: number;
  /** The machines that existed when the command was made: the new one is not among them. */
  known: ReadonlySet<string>;
}

/**
 * One machine's way in, all three steps in view from the start: a name, the install command, then
 * the machine appearing and being approved.
 */
function EnrollDialog({
  machines,
  onClose,
}: {
  machines: readonly MachineView[];
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const enroll = useEnrollMachine();
  const [name, setName] = useState("");
  const [made, setMade] = useState<Made>();
  const arrived = made
    ? machines.filter(
        (machine) =>
          machine.status === "pending" && !made.known.has(machine.id),
      )
    : [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{translateText("install.title")}</DialogTitle>
          <DialogDescription>
            {translateText("install.permissionsNotice")}
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-4">
          <Step
            n={1}
            title={translateText("install.chooseName")}
            active={!made}
          >
            {made ? (
              <p className="text-sm text-muted-foreground">
                {name.trim() || "—"}
              </p>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (enroll.isPending) return;
                  const known = new Set(machines.map((machine) => machine.id));
                  enroll.mutate(
                    {
                      ...(name.trim() ? { name: name.trim() } : {}),
                      url: location.origin,
                    },
                    {
                      onSuccess: ({ command, expiresAt }) =>
                        setMade({ command, expiresAt, known }),
                      onError: showError,
                    },
                  );
                }}
              >
                <Input
                  aria-label={translateText("fields.nameLabel")}
                  placeholder={translateText("fields.namePlaceholder")}
                  maxLength={100}
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button type="submit" disabled={enroll.isPending}>
                  {translateText("install.generateCommand")}
                </Button>
              </form>
            )}
          </Step>
          <Step
            n={2}
            title={translateText("install.runCommand")}
            active={Boolean(made) && arrived.length === 0}
          >
            {made ? (
              <>
                <CommandBox command={made.command} />
                <p className="text-xs text-muted-foreground">
                  {translateText("install.commandExpiry", {
                    time: when(made.expiresAt),
                  })}
                </p>
              </>
            ) : null}
          </Step>
          <Step
            n={3}
            title={translateText("approval.title")}
            active={arrived.length > 0}
          >
            {arrived.length > 0 ? (
              <div aria-live="polite" className="space-y-2">
                {arrived.map((machine) => (
                  <Approval key={machine.id} machine={machine} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {made
                  ? translateText("install.waitingForCommand")
                  : translateText("approval.help")}
              </p>
            )}
          </Step>
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {made
              ? translateText("common:actions.close")
              : translateText("common:actions.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  machine,
  onClose,
}: {
  machine: MachineView;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const rename = useRenameMachine();
  const [name, setName] = useState(machine.name);
  const valid = name.trim() !== "" && name.trim() !== machine.name;
  const submit = () => {
    if (!valid || rename.isPending) return;
    rename.mutate(
      { machineId: machine.id, name: name.trim() },
      { onSuccess: onClose, onError: showError },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-4 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {translateText("rename.title", { name: machine.name })}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label={translateText("fields.nameLabel")}
            maxLength={100}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translateText("common:actions.cancel")}
          </Button>
          <Button disabled={!valid || rename.isPending} onClick={submit}>
            {translateText("common:actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How many task runs the machine works on at once; the rest wait in the queue. */
function RunsDialog({
  machine,
  onClose,
}: {
  machine: MachineView;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const set = useSetMaxActiveRuns();
  const [value, setValue] = useState(String(machine.maxActiveRuns));
  const runs = Number(value);
  const valid =
    Number.isInteger(runs) &&
    runs >= 1 &&
    runs <= 20 &&
    runs !== machine.maxActiveRuns;
  const submit = () => {
    if (!valid || set.isPending) return;
    set.mutate(
      { machineId: machine.id, maxActiveRuns: runs },
      { onSuccess: onClose, onError: showError },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-4 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {translateText("runs.title", { name: machine.name })}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            type="number"
            min={1}
            max={20}
            aria-label={translateText("runs.label")}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translateText("common:actions.cancel")}
          </Button>
          <Button disabled={!valid || set.isPending} onClick={submit}>
            {translateText("common:actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MachineCard({ machine }: { machine: MachineView }) {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const revoke = useRevokeMachine();
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [limiting, setLimiting] = useState(false);
  const status = translateText(`status.${machine.status}`);
  const details = [
    translateText(`kinds.${machine.kind}`),
    machine.os ? (osLabels[machine.os] ?? machine.os) : null,
    machine.home,
    machine.status === "pending" || machine.status === "revoked"
      ? null
      : translateText("runs.summary", { count: machine.maxActiveRuns }),
    machine.status === "offline" && machine.lastSeenAt !== null
      ? translateText("lastSeen", { time: when(machine.lastSeenAt) })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const closed = machine.status === "revoked";

  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-2 border p-3",
        closed && "text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={machine.status} label={status} />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={machine.name}
        >
          {machine.name}
        </span>
        <span className="text-xs text-muted-foreground">{status}</span>
        {closed ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translateText("common:accessibility.itemActions", {
                  name: machine.name,
                })}
              >
                <DotsThreeIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                {translateText("actions.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLimiting(true)}>
                {translateText("actions.runs")}
              </DropdownMenuItem>
              {machine.kind === "primary" ? null : (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setConfirming(true)}
                >
                  {translateText("actions.revoke")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {details ? (
        <p className="truncate text-xs text-muted-foreground" title={details}>
          {details}
        </p>
      ) : null}
      {machine.status === "pending" ? <Approval machine={machine} /> : null}
      {renaming ? (
        <RenameDialog machine={machine} onClose={() => setRenaming(false)} />
      ) : null}
      {limiting ? (
        <RunsDialog machine={machine} onClose={() => setLimiting(false)} />
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("revoke.confirmTitle", { name: machine.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("revoke.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                revoke.mutate(
                  { machineId: machine.id },
                  {
                    onSuccess: () =>
                      toast(
                        translateText("revoke.success", { name: machine.name }),
                      ),
                    onError: showError,
                  },
                )
              }
            >
              {translateText("actions.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Settings → 机器. */
export function MachineSettings() {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const { machines, loaded, error } = useMachines();
  const [enrolling, setEnrolling] = useState(0);
  // The primary is always there; "none yet" is about the others.
  const others = machines.filter((machine) => machine.kind !== "primary");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEnrolling((n) => n + 1)}
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          {translateText("actions.add")}
        </Button>
      </div>
      {error ? (
        <LoadError what={translateText("title")} error={error} />
      ) : !loaded ? (
        <Loading rows={2} />
      ) : (
        <>
          <div className="@container">
            <ul
              aria-label={translateText("title")}
              className="grid grid-cols-1 gap-2 @lg:grid-cols-2"
            >
              {machines.map((machine) => (
                <MachineCard key={machine.id} machine={machine} />
              ))}
            </ul>
          </div>
          {others.length === 0 ? (
            <Empty icon={DesktopIcon} title={translateText("empty.title")}>
              {translateText("empty.description")}
            </Empty>
          ) : null}
        </>
      )}
      {enrolling > 0 ? (
        <EnrollDialog
          key={enrolling}
          machines={machines}
          onClose={() => setEnrolling(0)}
        />
      ) : null}
    </div>
  );
}
