import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpTestResult,
  MachineView,
} from "@eta/client-contracts";
import type { AcpDraft, AcpDraftProblems } from "./acp-form";
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
import { Badge } from "@/components/ui/badge";
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
  useAcpAgents,
  useDeleteAcpAgent,
  useSaveAcpAgent,
  useTestAcpAgent,
} from "@/queries/acp";
import { useMachines } from "@/queries/projects";
import { wireErrorMessage } from "@/queries/wire";
import { acpDraftOf, acpSlug, checkAcpDraft, emptyAcpDraft } from "./acp-form";
import { Select, SelectOption } from "./select-field";

// Settings → External agents: one machine at a time, the ACP agents in that machine's own
// ~/.eta/acp.json, each a runtime an agent on that machine can run on as `acp.<id>`. The machine
// keeps the file and checks every change; this page lists what it says, and sends a whole config
// to save, an id to delete, or a config (saved or not) to try, always naming the machine. A
// daemon that is offline stays chosen and says so: nothing goes to the primary instead.

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

function StatusBadge({ status }: { status: AcpAgentView["status"] }) {
  const { t: translateText } = useTranslation(["acp"] as const);
  return (
    <Badge
      variant={
        status === "available"
          ? "default"
          : status === "error"
            ? "destructive"
            : "outline"
      }
    >
      {translateText(`status.${status}`)}
    </Badge>
  );
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

/** Add or edit one agent. `agent` is the one being edited; none adds. */
function AgentDialog({
  machine,
  agent,
  taken,
  onClose,
}: {
  machine: MachineView;
  agent: AcpAgentView | undefined;
  /** Ids in use by the machine's other agents. */
  taken: readonly string[];
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["acp", "common"] as const);
  const save = useSaveAcpAgent();
  const test = useTestAcpAgent();
  const report = useReportTest();
  const baseId = useId();
  const [draft, setDraft] = useState<AcpDraft>(() =>
    agent === undefined ? emptyAcpDraft : acpDraftOf(agent),
  );
  // A new agent's id follows its name until the id is typed in by hand.
  const [idTouched, setIdTouched] = useState(agent !== undefined);
  const [problems, setProblems] = useState<AcpDraftProblems>({});
  const [failure, setFailure] = useState<string>();

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
        machineId: machine.id,
        agent: config,
        ...(agent !== undefined && agent.id !== config.id
          ? { previousId: agent.id }
          : {}),
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
      { machineId: machine.id, agent: config },
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

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {agent === undefined
              ? translateText("form.addTitle")
              : translateText("form.editTitle", { label: agent.label })}
          </DialogTitle>
          <DialogDescription>
            {translateText("form.description", { machine: machine.name })}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-3"
          aria-label={translateText("form.addTitle")}
          onSubmit={onSubmit}
        >
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
                : translateText("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({
  machineId,
  agent,
  onEdit,
}: {
  machineId: string;
  agent: AcpAgentView;
  onEdit: () => void;
}) {
  const { t: translateText } = useTranslation(["acp", "common"] as const);
  const test = useTestAcpAgent();
  const remove = useDeleteAcpAgent();
  const report = useReportTest();
  const [deleting, setDeleting] = useState(false);
  const commandLine = [agent.command, ...agent.args].join(" ");
  return (
    <li className="flex items-start gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          {agent.label}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {agent.runtime}
          </span>
          <StatusBadge status={agent.status} />
          {agent.version ? (
            <span className="text-xs font-normal text-muted-foreground">
              {agent.version}
            </span>
          ) : null}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {commandLine}
        </p>
        {agent.detail ? (
          <p
            className={
              agent.status === "available"
                ? "text-xs break-words text-muted-foreground"
                : "text-xs break-words text-destructive"
            }
          >
            {agent.detail}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${translateText("actions.test")} ${agent.label}`}
          disabled={test.isPending}
          onClick={() =>
            test.mutate(
              { machineId, agent: configOf(agent) },
              {
                onSuccess: (result) => report(agent.label, result),
                onError: showError,
              },
            )
          }
        >
          {test.isPending
            ? translateText("actions.testing")
            : translateText("actions.test")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${translateText("common:actions.edit")} ${agent.label}`}
          onClick={onEdit}
        >
          {translateText("common:actions.edit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          aria-label={`${translateText("common:actions.delete")} ${agent.label}`}
          disabled={remove.isPending}
          onClick={() => setDeleting(true)}
        >
          {translateText("common:actions.delete")}
        </Button>
      </div>
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
                void remove.mutateAsync({ machineId, id: agent.id }).then(
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

/** The machines that can run ACP agents: the primary and every daemon not revoked. */
function acpMachines(machines: readonly MachineView[]): MachineView[] {
  return machines
    .filter(
      (machine) =>
        (machine.kind === "primary" || machine.kind === "daemon") &&
        machine.status !== "revoked",
    )
    .sort(
      (a, b) => Number(b.kind === "primary") - Number(a.kind === "primary"),
    );
}

/** Which machine's agents the page shows: every one is listed, an offline one as offline. */
function MachineSelect({
  machines,
  value,
  onChange,
}: {
  machines: readonly MachineView[];
  value: string;
  onChange: (machineId: string) => void;
}) {
  const { t: translateText } = useTranslation(["acp", "machines"] as const);
  const baseId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label id={`${baseId}-machine`} className="text-xs">
        {translateText("machine.label")}
      </Label>
      <Select
        aria-labelledby={`${baseId}-machine`}
        size="sm"
        className="h-7 min-w-48 text-xs"
        value={value}
        onValueChange={onChange}
      >
        {machines.map((machine) => (
          <SelectOption key={machine.id} value={machine.id}>
            {machineName(machine, translateText("machine.primarySuffix"))}
            {machine.status === "online" ? null : (
              <span className="text-muted-foreground">
                {" · "}
                {translateText(`machines:status.${machine.status}`)}
              </span>
            )}
          </SelectOption>
        ))}
      </Select>
    </div>
  );
}

function machineName(machine: MachineView, primarySuffix: string): string {
  return `${machine.name}${machine.kind === "primary" ? primarySuffix : ""}`;
}

/** Settings → External agents. */
export function AcpSettings() {
  const { t: translateText } = useTranslation([
    "acp",
    "machines",
    "common",
  ] as const);
  const { machines, loaded: machinesLoaded } = useMachines();
  const listed = acpMachines(machines);
  const primary = listed.find((machine) => machine.kind === "primary");
  // The primary until another is chosen; a chosen machine stays chosen whatever its status.
  const [chosen, setChosen] = useState<string>();
  const machineId = chosen ?? primary?.id;
  const machine = listed.find((item) => item.id === machineId);
  const reachable =
    machine !== undefined &&
    (machine.kind === "primary" || machine.status === "online");
  const { agents, loaded, error } = useAcpAgents(machineId, reachable);
  // undefined: no dialog; null: adding; an id: editing that one.
  const [editing, setEditing] = useState<string | null>();
  const edited =
    typeof editing === "string"
      ? agents.find((agent) => agent.id === editing)
      : undefined;
  const choose = (next: string) => {
    setChosen(next);
    setEditing(undefined);
  };
  const add = (
    <Button
      size="sm"
      variant="outline"
      disabled={!loaded || !reachable}
      onClick={() => setEditing(null)}
    >
      <PlusIcon aria-hidden="true" data-icon="inline-start" />
      {translateText("actions.add")}
    </Button>
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        {error ? null : add}
      </div>
      <p className="text-xs text-muted-foreground">
        {translateText("description")}
      </p>
      {machine === undefined ? (
        machinesLoaded && chosen !== undefined ? (
          <p role="status" className="border px-3 py-2 text-sm">
            {translateText("machine.gone")}
          </p>
        ) : (
          <Loading rows={3} />
        )
      ) : (
        <>
          <MachineSelect
            machines={listed}
            value={machine.id}
            onChange={choose}
          />
          {!reachable ? (
            <p
              role="status"
              className="border px-3 py-2 text-sm text-muted-foreground"
            >
              {translateText("machine.offline", {
                name: machine.name,
                status: translateText(`machines:status.${machine.status}`),
              })}
            </p>
          ) : error ? (
            <LoadError what={translateText("title")} error={error} />
          ) : !loaded ? (
            <Loading rows={3} />
          ) : agents.length === 0 ? (
            <Empty
              icon={PlugsConnectedIcon}
              title={translateText("empty.title")}
            >
              {translateText("empty.description")}
            </Empty>
          ) : (
            <ul
              aria-label={translateText("list.label", {
                machine: machineName(
                  machine,
                  translateText("machine.primarySuffix"),
                ),
              })}
              className="divide-y border"
            >
              {agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  machineId={machine.id}
                  agent={agent}
                  onEdit={() => setEditing(agent.id)}
                />
              ))}
            </ul>
          )}
          {reachable && (editing === null || edited !== undefined) ? (
            <AgentDialog
              key={machine.id}
              machine={machine}
              agent={edited}
              // This machine's ids only: another machine may have the same one.
              taken={agents
                .map((agent) => agent.id)
                .filter((id) => id !== edited?.id)}
              onClose={() => setEditing(undefined)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
