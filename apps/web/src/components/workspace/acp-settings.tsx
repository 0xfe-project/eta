import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpMachineList,
  AcpTestResult,
  MachineView,
} from "@eta/client-contracts";
import type { AcpDraft, AcpDraftProblems } from "./acp-form";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useId, useState } from "react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  useAcpLists,
  useDeleteAcpAgent,
  useSaveAcpAgent,
  useTestAcpAgent,
} from "@/queries/acp";
import { useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import {
  acpCommandLine,
  acpDraftOf,
  acpSlug,
  checkAcpDraft,
  emptyAcpDraft,
} from "./acp-form";
import { Select, SelectOption } from "./select-field";

// Settings → External agents: every machine's ACP agents at once, grouped by machine. Each machine
// keeps its own ~/.eta/acp.json, and each agent there is a runtime an agent on that machine can
// run on as `acp.<id>`. The page asks every reachable machine for its list and shows them
// together; every save, delete and test names the machine its agent is on. An offline daemon
// keeps its group and says it cannot be read: nothing goes to another machine instead.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** The stored part of a listed agent: what `save` and `test` take. */
function configOf({
  runtime: _runtime,
  status: _status,
  version: _version,
  detail: _detail,
  ...config
}: AcpAgentView): AcpAgentConfig {
  return config;
}

/** The primary and every daemon not revoked: the primary first, then by name. */
function acpMachines(machines: readonly MachineView[]): MachineView[] {
  return machines
    .filter(
      (machine) =>
        (machine.kind === "primary" || machine.kind === "daemon") &&
        machine.status !== "revoked",
    )
    .sort(
      (a, b) =>
        Number(b.kind === "primary") - Number(a.kind === "primary") ||
        a.name.localeCompare(b.name),
    );
}

/** A machine that can be asked: the primary always, a daemon while it is online. */
const reachable = (machine: MachineView) =>
  machine.kind === "primary" || machine.status === "online";

function machineName(machine: MachineView, primarySuffix: string): string {
  return `${machine.name}${machine.kind === "primary" ? primarySuffix : ""}`;
}

/** A test's outcome as one toast: what answered, or why nothing did. */
function useReportTest() {
  const { t: translateText } = useTranslation(["acp"] as const);
  return (label: string, result: AcpTestResult) => {
    const who = [result.agentName, result.version].filter(Boolean).join(" ");
    if (result.ok)
      toast.success(
        translateText("test.ok", { label, agent: who || label }),
        result.detail ? { description: result.detail } : undefined,
      );
    else
      toast.error(
        translateText("test.failed", {
          label,
          status: translateText(`status.${result.status}`),
        }),
        result.detail ? { description: result.detail } : undefined,
      );
  };
}

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  return text === undefined ? null : (
    <p id={id} role="alert" className="text-xs text-destructive">
      {text}
    </p>
  );
}

/**
 * Add or edit one agent. `agent` is the one being edited, on `machineId`, which then cannot
 * change; none adds, on the machine chosen first (`machineId` to begin with). Only a machine
 * whose list came whole can be chosen.
 */
function AgentDialog({
  machines,
  lists,
  machineId: initialMachineId,
  agent,
  onClose,
}: {
  machines: readonly MachineView[];
  lists: Record<string, AcpMachineList>;
  machineId: string;
  agent: AcpAgentView | undefined;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation([
    "acp",
    "machines",
    "common",
  ] as const);
  const save = useSaveAcpAgent();
  const test = useTestAcpAgent();
  const report = useReportTest();
  const baseId = useId();
  const [machineId, setMachineId] = useState(initialMachineId);
  const machine = machines.find((item) => item.id === machineId);
  const [draft, setDraft] = useState<AcpDraft>(() =>
    agent === undefined ? emptyAcpDraft : acpDraftOf(agent),
  );
  // A new agent's id follows its name until the id is typed in by hand.
  const [idTouched, setIdTouched] = useState(agent !== undefined);
  const [problems, setProblems] = useState<AcpDraftProblems>({});
  const [failure, setFailure] = useState<string>();
  const primarySuffix = translateText("machine.primarySuffix");
  // The chosen machine's ids only: another machine may have the same one.
  const taken = (lists[machineId]?.agents ?? [])
    .map((item) => item.id)
    .filter((id) => id !== agent?.id);

  const change = <K extends keyof AcpDraft>(key: K, value: AcpDraft[K]) => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === "label" && !idTouched) next.id = acpSlug(value as string);
      return next;
    });
    if (key in problems || (key === "label" && !idTouched))
      setProblems((current) => {
        const rest = { ...current };
        delete rest[key as keyof AcpDraftProblems];
        if (key === "label" && !idTouched) delete rest.id;
        return rest;
      });
  };

  const chooseMachine = (next: string) => {
    setMachineId(next);
    setFailure(undefined);
    // A clash was with the other machine's ids.
    setProblems(({ id: _id, ...rest }) => rest);
  };

  const problemText = (field: keyof AcpDraftProblems) => {
    const problem = problems[field];
    return problem === undefined
      ? undefined
      : translateText(problem.key as "errors.idFormat", {
          line: problem.line,
        });
  };

  const checked = (): AcpAgentConfig | undefined => {
    const result = checkAcpDraft(draft, taken);
    if (!result.ok) {
      setProblems(result.problems);
      return undefined;
    }
    setProblems({});
    return result.config;
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const config = checked();
    if (config === undefined) return;
    setFailure(undefined);
    // The promise, not mutate's callbacks: a rename's new list can close this dialog first.
    save
      .mutateAsync({
        machineId,
        agent: config,
        // An edit always names the agent it edits: without `previousId` the host takes it for a
        // new one, and refuses the id it already has.
        ...(agent === undefined ? {} : { previousId: agent.id }),
      })
      .then(
        (saved) => {
          toast.success(
            translateText("feedback.saved", { label: saved.label }),
          );
          onClose();
        },
        // The host's own words: a clash it saw, an agent still using the old id.
        (error: Error) => setFailure(wireErrorMessage(error)),
      );
  };

  const onTest = () => {
    const config = checked();
    if (config === undefined) return;
    test.mutate(
      { machineId, agent: config },
      {
        onSuccess: (result) => report(config.label, result),
        onError: showError,
      },
    );
  };

  const field = (name: keyof AcpDraftProblems) => {
    const error = problemText(name);
    return {
      id: `${baseId}-${name}`,
      "aria-invalid": error !== undefined,
      "aria-describedby":
        error === undefined ? undefined : `${baseId}-${name}-error`,
      error,
    };
  };
  const label = field("label");
  const id = field("id");
  const command = field("command");
  const env = field("env");
  const machineFieldId = `${baseId}-machine`;
  const machineHintId = `${baseId}-machine-hint`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {agent === undefined
              ? translateText("form.addTitle")
              : translateText("form.editTitle", { label: agent.label })}
          </DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="space-y-3"
          aria-label={translateText("form.addTitle")}
          onSubmit={onSubmit}
        >
          <div className="space-y-1.5">
            <Label htmlFor={machineFieldId}>
              {translateText("machine.label")}
            </Label>
            {agent === undefined ? (
              <Select
                id={machineFieldId}
                aria-describedby={machineHintId}
                className="w-full"
                value={machineId}
                onValueChange={chooseMachine}
              >
                {machines.map((item) => {
                  const list = lists[item.id];
                  const usable =
                    reachable(item) &&
                    list !== undefined &&
                    list.error === undefined;
                  return (
                    <SelectOption
                      key={item.id}
                      value={item.id}
                      disabled={!usable}
                    >
                      {machineName(item, primarySuffix)}
                      {reachable(item) ? null : (
                        <span className="text-muted-foreground">
                          {" · "}
                          {translateText(`machines:status.${item.status}`)}
                        </span>
                      )}
                    </SelectOption>
                  );
                })}
              </Select>
            ) : (
              <Input
                id={machineFieldId}
                readOnly
                aria-describedby={machineHintId}
                className="text-muted-foreground"
                value={
                  machine === undefined
                    ? machineId
                    : machineName(machine, primarySuffix)
                }
              />
            )}
            <DialogDescription
              id={machineHintId}
              className="text-xs text-muted-foreground"
            >
              {agent === undefined
                ? translateText("machine.addHint")
                : translateText("machine.editHint")}
            </DialogDescription>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={label.id}>{translateText("form.label")}</Label>
            <Input
              id={label.id}
              autoFocus
              autoComplete="off"
              placeholder={translateText("form.labelPlaceholder")}
              aria-invalid={label["aria-invalid"]}
              aria-describedby={label["aria-describedby"]}
              value={draft.label}
              onChange={(event) => change("label", event.target.value)}
            />
            <FieldError id={`${label.id}-error`} text={label.error} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id.id}>{translateText("form.id")}</Label>
            <Input
              id={id.id}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="my-agent"
              aria-invalid={id["aria-invalid"]}
              aria-describedby={id["aria-describedby"] ?? `${id.id}-hint`}
              value={draft.id}
              onChange={(event) => {
                setIdTouched(true);
                change("id", event.target.value);
              }}
            />
            {id.error === undefined ? (
              <p id={`${id.id}-hint`} className="text-xs text-muted-foreground">
                {translateText("form.idHint", {
                  runtime: `acp.${draft.id || "…"}`,
                })}
              </p>
            ) : (
              <FieldError id={`${id.id}-error`} text={id.error} />
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={command.id}>{translateText("form.command")}</Label>
            <Input
              id={command.id}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="npx"
              aria-invalid={command["aria-invalid"]}
              aria-describedby={command["aria-describedby"]}
              value={draft.command}
              onChange={(event) => change("command", event.target.value)}
            />
            <FieldError id={`${command.id}-error`} text={command.error} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${baseId}-args`}>
              {translateText("form.args")}
            </Label>
            <Textarea
              id={`${baseId}-args`}
              rows={3}
              spellCheck={false}
              className="font-mono"
              placeholder={"-y\n@example/agent\n--acp"}
              aria-describedby={`${baseId}-args-hint`}
              value={draft.args}
              onChange={(event) => change("args", event.target.value)}
            />
            <p
              id={`${baseId}-args-hint`}
              className="text-xs text-muted-foreground"
            >
              {translateText("form.argsHint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={env.id}>{translateText("form.env")}</Label>
            <Textarea
              id={env.id}
              rows={3}
              spellCheck={false}
              className="font-mono"
              placeholder="API_KEY=…"
              aria-invalid={env["aria-invalid"]}
              aria-describedby={env["aria-describedby"] ?? `${env.id}-hint`}
              value={draft.env}
              onChange={(event) => change("env", event.target.value)}
            />
            {env.error === undefined ? (
              <p
                id={`${env.id}-hint`}
                className="text-xs text-muted-foreground"
              >
                {translateText("form.envHint")}
              </p>
            ) : (
              <FieldError id={`${env.id}-error`} text={env.error} />
            )}
          </div>
          {failure === undefined ? null : (
            <p
              role="alert"
              className="bg-destructive/10 px-3 py-2 text-sm break-words text-destructive"
            >
              {translateText("feedback.saveFailed", { message: failure })}
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground sm:mr-auto"
              disabled={test.isPending}
              onClick={onTest}
            >
              {test.isPending
                ? translateText("actions.testing")
                : translateText("actions.test")}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              {translateText("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending
                ? translateText("common:states.saving")
                : agent === undefined
                  ? translateText("form.add")
                  : translateText("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A dot and one word: whether the agent can be used. */
function AgentStatus({ status }: { status: AcpAgentView["status"] }) {
  const { t: translateText } = useTranslation(["acp"] as const);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap",
        status === "available" && "text-muted-foreground",
        (status === "unauthenticated" || status === "missing") &&
          "text-state-warning-ink",
        status === "error" && "text-state-error-ink",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0",
          status === "available" && "bg-state-success",
          (status === "unauthenticated" || status === "missing") &&
            "bg-state-warning",
          status === "error" && "bg-state-error",
        )}
      />
      {translateText(`status.${status}`)}
    </span>
  );
}

function AgentRow({
  machine,
  agent,
  onEdit,
}: {
  machine: MachineView;
  agent: AcpAgentView;
  onEdit: () => void;
}) {
  const { t: translateText } = useTranslation(["acp", "common"] as const);
  const test = useTestAcpAgent();
  const remove = useDeleteAcpAgent();
  const report = useReportTest();
  const [deleting, setDeleting] = useState(false);
  const version =
    agent.version === undefined || agent.version === ""
      ? undefined
      : /^v\d/i.test(agent.version)
        ? agent.version
        : `v${agent.version}`;
  // What is wrong and what to do next, only when it cannot be used.
  const reason =
    agent.status === "available"
      ? undefined
      : agent.status === "error"
        ? [agent.detail, translateText("reason.error")]
            .filter(Boolean)
            .join(" ")
        : translateText(`reason.${agent.status}`, {
            machine: machine.name,
            label: agent.label,
            command: agent.command,
          });
  const runTest = () =>
    test.mutate(
      { machineId: machine.id, agent: configOf(agent) },
      {
        onSuccess: (result) => report(agent.label, result),
        onError: showError,
      },
    );
  const copyCommand = () =>
    void navigator.clipboard.writeText(acpCommandLine(agent)).then(
      () => toast(translateText("common:feedback.copied")),
      () => toast.error(translateText("common:errors.clipboardBlocked")),
    );
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{agent.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {version === undefined
              ? agent.runtime
              : `${agent.runtime} · ${version}`}
          </p>
        </div>
        <AgentStatus status={agent.status} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1.5 text-muted-foreground"
              aria-label={translateText("actions.more", { label: agent.label })}
            >
              <DotsThreeIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-36">
            <DropdownMenuItem disabled={test.isPending} onSelect={runTest}>
              {test.isPending
                ? translateText("actions.testing")
                : translateText("actions.test")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              {translateText("common:actions.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={copyCommand}>
              {translateText("actions.copyCommand")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={remove.isPending}
              onSelect={() => setDeleting(true)}
            >
              {translateText("common:actions.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {reason === undefined ? null : (
        <p
          className={cn(
            "mt-0.5 text-xs break-words",
            agent.status === "error"
              ? "text-state-error-ink"
              : "text-state-warning-ink",
          )}
        >
          {reason}
        </p>
      )}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("delete.title", { label: agent.label })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("delete.description", { runtime: agent.runtime })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              // The promise, not mutate's callbacks: the host's new list drops this row, and an
              // unmounted row's callbacks never run.
              onClick={() =>
                void remove
                  .mutateAsync({ machineId: machine.id, id: agent.id })
                  .then(
                    () =>
                      toast(
                        translateText("feedback.deleted", {
                          label: agent.label,
                        }),
                      ),
                    showError,
                  )
              }
            >
              {translateText("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** One machine's group: its name, what it holds, and its agents or why they cannot be shown. */
function MachineGroup({
  machine,
  list,
  onEdit,
}: {
  machine: MachineView;
  list: AcpMachineList | undefined;
  onEdit: (agentId: string) => void;
}) {
  const { t: translateText } = useTranslation(["acp", "machines"] as const);
  const headingId = useId();
  const online = reachable(machine);
  const agents = list?.agents;
  const meta = !online
    ? translateText(`machines:status.${machine.status}`)
    : agents === undefined
      ? machine.kind === "primary"
        ? translateText("machines:kinds.primary")
        : undefined
      : machine.kind === "primary"
        ? translateText("machine.primaryCount", { count: agents.length })
        : translateText("machine.count", { count: agents.length });
  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <h3 className="flex min-w-0 items-baseline gap-2 text-xs">
        <span id={headingId} className="truncate font-medium">
          {machine.name}
        </span>
        {meta === undefined ? null : (
          <span className="shrink-0 text-muted-foreground">{meta}</span>
        )}
      </h3>
      {!online ? (
        <p
          role="status"
          className="border bg-[repeating-linear-gradient(-45deg,var(--background)_0_7px,var(--muted)_7px_8px)] px-3 py-3 text-xs text-muted-foreground"
        >
          {translateText("machine.offline", { name: machine.name })}
        </p>
      ) : list === undefined ? (
        <Loading rows={1} />
      ) : list.error !== undefined ? (
        <p
          role="alert"
          className="border px-3 py-2 text-xs break-words text-destructive"
        >
          {list.error}
        </p>
      ) : list.agents.length === 0 ? null : (
        <ul
          aria-label={translateText("list.label", { machine: machine.name })}
          className="divide-y border"
        >
          {[...list.agents]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((agent) => (
              <AgentRow
                key={agent.id}
                machine={machine}
                agent={agent}
                onEdit={() => onEdit(agent.id)}
              />
            ))}
        </ul>
      )}
    </section>
  );
}

/** Settings → External agents. */
export function AcpSettings() {
  const { t: translateText } = useTranslation(["acp", "common"] as const);
  const { machines, loaded: machinesLoaded } = useMachines();
  const listed = acpMachines(machines);
  // The ones that can be asked first, then each one that cannot, in a group of its own.
  const ordered = [
    ...listed.filter(reachable),
    ...listed.filter((machine) => !reachable(machine)),
  ];
  const asked = listed.filter(reachable).map((machine) => machine.id);
  const { lists, loaded, error } = useAcpLists(asked);
  // undefined: no dialog; agentId null: adding (from that machine); an id: editing that one.
  const [editing, setEditing] = useState<{
    machineId: string;
    agentId: string | null;
  }>();
  // Where a new agent goes unless another is chosen: the primary, or the first that can take one.
  const addable = listed.find(
    (machine) =>
      reachable(machine) &&
      lists[machine.id] !== undefined &&
      lists[machine.id]!.error === undefined,
  );
  const editedMachine = listed.find(
    (machine) => machine.id === editing?.machineId,
  );
  const edited =
    typeof editing?.agentId === "string"
      ? lists[editing.machineId]?.agents?.find(
          (agent) => agent.id === editing.agentId,
        )
      : undefined;
  const everyListCame = asked.every(
    (machineId) => lists[machineId] !== undefined,
  );
  const none =
    everyListCame &&
    asked.every(
      (machineId) =>
        lists[machineId]?.error === undefined &&
        lists[machineId]?.agents?.length === 0,
    );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        {error ? null : (
          <Button
            size="sm"
            disabled={addable === undefined}
            onClick={() =>
              addable && setEditing({ machineId: addable.id, agentId: null })
            }
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("actions.add")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {translateText("description")}
      </p>
      {error ? (
        <LoadError what={translateText("title")} error={error} />
      ) : !machinesLoaded || !loaded ? (
        <Loading rows={3} />
      ) : (
        <div className="space-y-4">
          {none ? (
            <Empty
              icon={PlugsConnectedIcon}
              title={translateText("empty.title")}
            >
              {translateText("empty.description")}
            </Empty>
          ) : null}
          {ordered
            .filter((machine) => !(none && reachable(machine)))
            .map((machine) => (
              <MachineGroup
                key={machine.id}
                machine={machine}
                list={lists[machine.id]}
                onEdit={(agentId) =>
                  setEditing({ machineId: machine.id, agentId })
                }
              />
            ))}
        </div>
      )}
      {editing !== undefined &&
      editedMachine !== undefined &&
      reachable(editedMachine) &&
      (editing.agentId === null || edited !== undefined) ? (
        <AgentDialog
          key={`${editing.machineId}/${editing.agentId ?? ""}`}
          machines={ordered}
          lists={lists}
          machineId={editing.machineId}
          agent={edited}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}
