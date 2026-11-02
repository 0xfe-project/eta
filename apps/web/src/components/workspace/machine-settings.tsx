import type { MachineView } from "@eta/client-contracts";
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
  useRenameMachine,
  useRevokeMachine,
  useSetMaxActiveRuns,
  useUpgradeMachine,
} from "@/queries/machines";
import { useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { AddMachine, Approval } from "./add-machine";
import { when } from "./routine-format";

// Settings → 机器: the primary and the machines that run the daemon. Adding one turns this panel
// into the way in (`add-machine.tsx`): a command to run on it, or an install over SSH. A machine
// shows up here pending until its fingerprint is approved; the user's own tailnet nodes are let in
// without one.

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
  const upgrade = useUpgradeMachine();
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [limiting, setLimiting] = useState(false);
  const status = translateText(`status.${machine.status}`);
  // The line truncates, so what an offline machine's card is there to say, when it was last seen,
  // goes first. Every machine but the primary runs the daemon, so only the primary is marked. The
  // build is only worth reading when it is behind, which the header says in words; the exact one
  // is on hover there.
  const details = [
    machine.status === "offline" && machine.lastSeenAt !== null
      ? translateText("lastSeen", { time: when(machine.lastSeenAt) })
      : null,
    machine.kind === "primary" ? translateText("kinds.primary") : null,
    machine.os ? (osLabels[machine.os] ?? machine.os) : null,
    machine.home,
    machine.status === "pending" || machine.status === "revoked"
      ? null
      : translateText("runs.summary", { count: machine.maxActiveRuns }),
  ]
    .filter(Boolean)
    .join(" · ");
  const closed = machine.status === "revoked";
  const build =
    machine.build === "outdated" || machine.build === "updating"
      ? translateText(`build.${machine.build}`)
      : null;
  const updatable =
    machine.kind === "daemon" &&
    machine.status === "online" &&
    (machine.build === "outdated" || machine.updateError !== null);

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
        <span
          className="text-xs text-muted-foreground"
          title={
            machine.version === null
              ? undefined
              : translateText("build.version", { version: machine.version })
          }
        >
          {build === null ? status : `${status} · ${build}`}
        </span>
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
              {updatable ? (
                <DropdownMenuItem
                  disabled={upgrade.isPending}
                  onSelect={() =>
                    upgrade.mutate(
                      { machineId: machine.id },
                      {
                        onSuccess: () =>
                          toast(
                            translateText("upgrade.started", {
                              name: machine.name,
                            }),
                          ),
                        onError: showError,
                      },
                    )
                  }
                >
                  {translateText("actions.upgrade")}
                </DropdownMenuItem>
              ) : null}
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
      {machine.updateError !== null && !closed ? (
        <p
          className="text-xs break-words text-state-warning"
          title={machine.updateError}
        >
          {machine.updateError}
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
  const [adding, setAdding] = useState(false);
  // The primary is always there; "none yet" is about the others.
  const others = machines.filter((machine) => machine.kind !== "primary");
  if (adding)
    return <AddMachine machines={machines} onBack={() => setAdding(false)} />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
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
    </div>
  );
}
