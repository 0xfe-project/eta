import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpTestResult,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useAcpAgents,
  useDeleteAcpAgent,
  useSaveAcpAgent,
  useTestAcpAgent,
} from "@/queries/acp";
import { wireErrorMessage } from "@/queries/wire";
import { acpDraftOf, acpSlug, checkAcpDraft, emptyAcpDraft } from "./acp-form";

// Settings → External agents: the ACP agents in ~/.eta/acp.json, each a runtime an agent can run
// on as `acp.<id>`. The host keeps the file and checks every change; this page lists what it says,
// and sends a whole config to save, an id to delete, or a config (saved or not) to try.

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
  agent,
  taken,
  onClose,
}: {
  agent: AcpAgentView | undefined;
  /** Ids in use by the other agents. */
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
        agent: config,
        // An edit names the agent it changes; without it the host takes it as a new one.
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
      { agent: config },
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
            {translateText("form.description")}
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
          <div className="space-y-1.5">
            <Label htmlFor={`${baseId}-cwd`}>{translateText("form.cwd")}</Label>
            <Input
              id={`${baseId}-cwd`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={translateText("form.cwdPlaceholder")}
              value={draft.cwd}
              onChange={(event) => change("cwd", event.target.value)}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor={`${baseId}-auto`}>
                {translateText("form.autoAllow")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translateText("form.autoAllowHint")}
              </p>
            </div>
            <Switch
              id={`${baseId}-auto`}
              checked={draft.autoAllow}
              onCheckedChange={(next) => change("autoAllow", next)}
            />
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
  agent,
  onEdit,
}: {
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
          {agent.autoAllow ? (
            <Badge variant="outline">{translateText("list.autoAllow")}</Badge>
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
              { agent: configOf(agent) },
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
                void remove.mutateAsync({ id: agent.id }).then(
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

/** Settings → External agents. */
export function AcpSettings() {
  const { t: translateText } = useTranslation(["acp", "common"] as const);
  const { agents, loaded, error } = useAcpAgents();
  // undefined: no dialog; null: adding; an id: editing that one.
  const [editing, setEditing] = useState<string | null>();
  const edited =
    typeof editing === "string"
      ? agents.find((agent) => agent.id === editing)
      : undefined;
  const add = (
    <Button
      size="sm"
      variant="outline"
      disabled={!loaded}
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
      {error ? (
        <LoadError what={translateText("title")} error={error} />
      ) : !loaded ? (
        <Loading rows={3} />
      ) : agents.length === 0 ? (
        <Empty icon={PlugsConnectedIcon} title={translateText("empty.title")}>
          {translateText("empty.description")}
        </Empty>
      ) : (
        <ul aria-label={translateText("title")} className="divide-y border">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onEdit={() => setEditing(agent.id)}
            />
          ))}
        </ul>
      )}
      {editing === null || edited !== undefined ? (
        <AgentDialog
          agent={edited}
          taken={agents
            .map((agent) => agent.id)
            .filter((id) => id !== edited?.id)}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}
