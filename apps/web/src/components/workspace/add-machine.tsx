import type {
  MachineInstallView,
  MachineView,
  TailnetPeerView,
} from "@eta/client-contracts";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  useApproveMachine,
  useDiscoverMachines,
  useEnrollMachine,
  useInstallMachine,
  useMachineAddresses,
  useMachineInstalls,
} from "@/queries/machines";
import { useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { when } from "./routine-format";
import { Select, SelectOption } from "./select-field";

// Settings → 机器 → 添加机器: the machines panel turned into the way in, not a dialog over it.
// Running a command on the new machine is the way that always works; installing over SSH is the
// shortcut, with or without a password. No name is asked for up front: the host names a machine
// after its hostname (or the SSH host), and its card can rename it.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/**
 * Whether what is typed here reaches the host encrypted: over https, over the tailnet (WireGuard)
 * or on this computer. Only then is a password asked for here.
 */
function connectionIsPrivate(location: Location = window.location): boolean {
  const host = location.hostname.replace(/^\[|\]$/g, "");
  return (
    location.protocol === "https:" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".ts.net") ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
  );
}

/** A pending machine: approved once the pasted fingerprint is the one its terminal printed. */
export function Approval({ machine }: { machine: MachineView }) {
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

/** Where a machine that came in stands: let in, or waiting for its fingerprint. */
function Arrived({ machine }: { machine: MachineView }) {
  const { t: translateText } = useTranslation(["machines"] as const);
  return machine.status === "pending" ? (
    <Approval machine={machine} />
  ) : (
    <p role="status" className="text-sm">
      {translateText("add.joined", { name: machine.name })}
    </p>
  );
}

/** Run a command on the new machine: the way in that always works. */
function CommandWay() {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const { machines } = useMachines();
  const enroll = useEnrollMachine();
  const { data: addresses } = useMachineAddresses();
  const here = window.location.origin;
  const tailnet =
    addresses?.tailnet !== null &&
    addresses?.tailnet !== undefined &&
    addresses.tailnet !== here
      ? addresses.tailnet
      : undefined;
  const [address, setAddress] = useState<string>();
  const chosen = address ?? tailnet ?? here;
  const [made, setMade] = useState<{
    command: string;
    expiresAt: number;
    known: ReadonlySet<string>;
  }>();
  const arrived = made
    ? machines.filter(
        (machine) => machine.kind === "daemon" && !made.known.has(machine.id),
      )
    : [];
  return (
    <div className="space-y-3">
      {tailnet === undefined ? null : (
        <div className="space-y-1.5">
          <Label htmlFor="machine-address">
            {translateText("add.address")}
          </Label>
          <Select
            id="machine-address"
            className="w-full"
            value={chosen}
            onValueChange={(next) => {
              setAddress(next);
              setMade(undefined);
            }}
          >
            <SelectOption value={tailnet}>
              {translateText("add.addressTailnet", { url: tailnet })}
            </SelectOption>
            <SelectOption value={here}>
              {translateText("add.addressCurrent", { url: here })}
            </SelectOption>
          </Select>
        </div>
      )}
      {made ? (
        <div className="space-y-1.5">
          <p className="text-sm">{translateText("install.runCommand")}</p>
          <CommandBox command={made.command} />
          <p className="text-xs text-muted-foreground">
            {translateText("install.commandExpiry", {
              time: when(made.expiresAt),
            })}
          </p>
        </div>
      ) : (
        <Button
          disabled={enroll.isPending}
          onClick={() => {
            const known = new Set(machines.map((machine) => machine.id));
            enroll.mutate(
              { url: chosen },
              {
                onSuccess: ({ command, expiresAt }) =>
                  setMade({ command, expiresAt, known }),
                onError: showError,
              },
            );
          }}
        >
          {translateText("install.generateCommand")}
        </Button>
      )}
      {made ? (
        arrived.length > 0 ? (
          <div aria-live="polite" className="space-y-2">
            {arrived.map((machine) => (
              <Arrived key={machine.id} machine={machine} />
            ))}
          </div>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {translateText("install.waitingForCommand")}
          </p>
        )
      ) : null}
    </div>
  );
}

const STEPS = ["connect", "send", "register", "service"] as const;

/** An install over SSH as it goes: the four steps, and where it stopped if it did. */
function InstallProgress({ install }: { install: MachineInstallView }) {
  const { t: translateText } = useTranslation(["machines"] as const);
  const { machines } = useMachines();
  const at =
    install.step === "done"
      ? STEPS.length
      : install.step === "failed"
        ? -1
        : STEPS.indexOf(install.step);
  const machine =
    install.machineId === null
      ? undefined
      : machines.find((candidate) => candidate.id === install.machineId);
  return (
    <div className="space-y-2">
      {install.step === "failed" ? (
        <p role="alert" className="text-xs break-words text-destructive">
          {install.error}
        </p>
      ) : (
        <ol
          aria-label={translateText("ssh.progress")}
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        >
          {STEPS.map((step, index) => (
            <li
              key={step}
              aria-current={index === at ? "step" : undefined}
              className={cn(
                "flex items-center gap-1",
                index > at && "text-muted-foreground",
                index === at && "animate-pulse",
              )}
            >
              {index < at ? <CheckIcon aria-hidden="true" /> : null}
              {translateText(`ssh.steps.${step}`)}
            </li>
          ))}
        </ol>
      )}
      {machine === undefined ? null : <Arrived machine={machine} />}
    </div>
  );
}

/** Install over SSH from here: with the user's keys, or with a password for this once. */
function SshWay() {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const install = useInstallMachine();
  const installs = useMachineInstalls();
  const { data: tailnet } = useDiscoverMachines();
  const listId = useId();
  const [host, setHost] = useState("");
  const [keyless, setKeyless] = useState(false);
  const [password, setPassword] = useState("");
  const [installId, setInstallId] = useState<string>();
  const secure = connectionIsPrivate();
  const running = installs.find((entry) => entry.id === installId);
  const busy =
    install.isPending ||
    (running !== undefined &&
      running.step !== "done" &&
      running.step !== "failed");
  const ready =
    host.trim() !== "" && (keyless || (secure && password !== "")) && !busy;
  const peers = (tailnet?.peers ?? []).filter(
    (peer: TailnetPeerView) => peer.online && peer.machineId === null,
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        install.mutate(
          { host: host.trim(), ...(keyless ? {} : { password }) },
          {
            onSuccess: ({ installId: id }) => {
              setInstallId(id);
              setPassword("");
            },
            onError: showError,
          },
        );
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="machine-ssh-host">{translateText("ssh.target")}</Label>
        <Input
          id="machine-ssh-host"
          list={peers.length > 0 ? listId : undefined}
          placeholder="user@host"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
        {peers.length > 0 ? (
          <datalist id={listId}>
            {peers.map((peer) => (
              <option key={peer.node} value={peer.dnsName || peer.name}>
                {peer.name}
              </option>
            ))}
          </datalist>
        ) : null}
      </div>
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox
          checked={keyless}
          onCheckedChange={(on) => setKeyless(on === true)}
        />
        {translateText("ssh.keyless")}
      </Label>
      {keyless ? null : (
        <div className="space-y-1.5">
          <Label htmlFor="machine-ssh-password">
            {translateText("ssh.password")}
          </Label>
          <Input
            id="machine-ssh-password"
            type="password"
            autoComplete="off"
            disabled={!secure}
            aria-describedby="machine-ssh-password-note"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p
            id="machine-ssh-password-note"
            className={cn(
              "text-xs",
              secure ? "text-muted-foreground" : "text-state-warning",
            )}
          >
            {secure
              ? translateText("ssh.passwordPromise")
              : translateText("ssh.insecure")}
          </p>
        </div>
      )}
      <Button type="submit" disabled={!ready}>
        {translateText("ssh.install")}
      </Button>
      {running === undefined ? null : <InstallProgress install={running} />}
    </form>
  );
}

/** The machines panel while a machine is being added. */
export function AddMachine({ onBack }: { onBack: () => void }) {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={translateText("common:actions.back")}
          onClick={onBack}
        >
          <ArrowLeftIcon aria-hidden="true" />
        </Button>
        <h2 className="text-sm font-semibold">
          {translateText("actions.add")}
        </h2>
      </div>
      <p className="text-xs text-muted-foreground">
        {translateText("install.permissionsNotice")}
      </p>
      <Tabs defaultValue="command">
        <TabsList>
          <TabsTrigger value="command">
            {translateText("add.tabs.command")}
          </TabsTrigger>
          <TabsTrigger value="ssh">{translateText("add.tabs.ssh")}</TabsTrigger>
        </TabsList>
        <TabsContent value="command">
          <CommandWay />
        </TabsContent>
        <TabsContent value="ssh">
          <SshWay />
        </TabsContent>
      </Tabs>
    </div>
  );
}
