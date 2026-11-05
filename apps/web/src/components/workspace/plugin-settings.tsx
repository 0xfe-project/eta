import type {
  FieldIssue,
  PluginAgentLevel,
  PluginFieldView,
  PluginView,
} from "@eta/client-contracts";
import type { FieldDraft, PluginDraft } from "./plugin-form";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { PuzzlePieceIcon } from "@phosphor-icons/react/PuzzlePiece";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatLocale } from "@/lib/i18n";
import {
  useAddPlugin,
  useConfigurePlugin,
  usePluginAudit,
  usePlugins,
  useRecheckPlugins,
  useRemovePlugin,
  useSetPluginLevel,
  useUpdatePlugin,
} from "@/queries/plugins";
import { wireErrorMessage } from "@/queries/wire";
import { changes, draftOf, formState } from "./plugin-form";
import { PluginServers } from "./plugin-servers";
import { Select, SelectOption } from "./select-field";

// Settings → 插件: what plugins there are and where each came from, whether it can be enabled, what
// it needs from each machine, and a form generated from what it declares. A secret is typed here
// once and is never shown again.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

const stateKeys = {
  needs_config: "needsConfig",
  ready: "ready",
} as const;

function FieldControl({
  field,
  value,
  id,
  labelId,
  issue,
  onChange,
}: {
  field: PluginFieldView;
  value: FieldDraft;
  id: string;
  labelId: string;
  issue: boolean;
  onChange: (value: FieldDraft) => void;
}) {
  const { t: translateText } = useTranslation(["plugins"] as const);
  if (field.type === "boolean")
    return (
      <Switch
        id={id}
        aria-labelledby={labelId}
        checked={value === true}
        onCheckedChange={onChange}
      />
    );
  if (field.type === "select" && field.multiple) {
    const chosen = value as string[];
    return (
      <ul aria-labelledby={labelId} className="space-y-1">
        {field.options.map((option) => (
          <li key={option.value}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={chosen.includes(option.value)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...chosen, option.value]
                      : chosen.filter((item) => item !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          </li>
        ))}
      </ul>
    );
  }
  if (field.type === "select")
    return (
      <Select
        id={id}
        aria-labelledby={labelId}
        aria-invalid={issue}
        className="w-full"
        value={value as string}
        onValueChange={onChange}
      >
        {field.options.map((option) => (
          <SelectOption key={option.value} value={option.value}>
            {option.label}
          </SelectOption>
        ))}
      </Select>
    );
  return (
    <Input
      id={id}
      aria-labelledby={labelId}
      aria-invalid={issue}
      type={field.secret ? "password" : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      value={value as string}
      autoComplete="off"
      spellCheck={false}
      placeholder={
        field.secret && field.set
          ? translateText("configure.secretKept")
          : undefined
      }
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function LevelField({
  plugin,
  field,
}: {
  plugin: string;
  field: PluginFieldView;
}) {
  const { t: translateText } = useTranslation(["plugins"] as const);
  const setLevel = useSetPluginLevel();
  const id = useId();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span id={id} className="shrink-0">
        {translateText("level.label")}
      </span>
      {field.levels.length > 1 ? (
        <Select
          aria-labelledby={id}
          size="sm"
          className="min-w-0"
          value={field.level}
          disabled={setLevel.isPending}
          onValueChange={(level) =>
            setLevel.mutate(
              {
                name: plugin,
                field: field.name,
                level: level as PluginAgentLevel,
              },
              { onError: showError },
            )
          }
        >
          {field.levels.map((level) => (
            <SelectOption key={level} value={level}>
              {translateText(`level.${level}`)}
            </SelectOption>
          ))}
        </Select>
      ) : (
        <span>{translateText(`level.${field.level}`)}</span>
      )}
    </div>
  );
}

/** One plugin's values as a form generated from its fields, and what it will run. */
function ConfigureDialog({
  plugin,
  onClose,
}: {
  plugin: PluginView;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["plugins", "common"] as const);
  const configure = useConfigurePlugin();
  const id = useId();
  const [draft, setDraft] = useState<PluginDraft>(() => draftOf(plugin.fields));
  const { issues, invalid, complete } = formState(plugin.fields, draft);
  const issueText = (issue: FieldIssue): string =>
    translateText(`issue.${issue.code}`, { limit: issue.limit });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translateText("configure.title", { name: plugin.name })}
          </DialogTitle>
          <DialogDescription>
            {translateText("configure.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) return;
            configure.mutate(
              { name: plugin.name, values: changes(plugin.fields, draft) },
              {
                onSuccess: ({ state }) => {
                  toast.success(
                    state === "ready"
                      ? translateText("configure.savedReady")
                      : translateText("configure.savedIncomplete"),
                  );
                  onClose();
                },
                onError: showError,
              },
            );
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {plugin.fields.map((field) => {
              const issue = issues[field.name];
              const input = `${id}-${field.name}`;
              return (
                <div key={field.name} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <label
                      id={`${input}-label`}
                      htmlFor={input}
                      className="text-xs font-medium"
                    >
                      {field.title}
                      {field.required ? null : (
                        <span className="font-normal text-muted-foreground">
                          {translateText("common:labels.optionalSuffix")}
                        </span>
                      )}
                    </label>
                    {field.secret && field.set ? (
                      <Badge variant="outline">
                        {translateText("configure.secretSet")}
                      </Badge>
                    ) : null}
                  </div>
                  <FieldControl
                    field={field}
                    value={draft[field.name] ?? ""}
                    id={input}
                    labelId={`${input}-label`}
                    issue={issue !== undefined}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        [field.name]: value,
                      }))
                    }
                  />
                  {issue === undefined ? null : (
                    <p className="text-xs text-destructive">
                      {issueText(issue)}
                    </p>
                  )}
                  {field.description ? (
                    <Markdown className="text-xs text-muted-foreground">
                      {field.description}
                    </Markdown>
                  ) : null}
                  {field.secret ? (
                    <LevelField plugin={plugin.name} field={field} />
                  ) : null}
                </div>
              );
            })}
            {plugin.servers.length > 0 ? (
              <section className="space-y-1">
                <h3 className="text-xs font-semibold">
                  {translateText("servers.title")}
                </h3>
                <PluginServers
                  servers={plugin.servers}
                  label={translateText("servers.title")}
                />
                <p className="text-xs text-muted-foreground">
                  {translateText("servers.etaNote")}
                </p>
              </section>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {translateText("configure.encryptionHelp")}
          </p>
          <DialogFooter className="gap-2 sm:justify-end">
            {complete ? null : (
              <p className="text-xs text-muted-foreground sm:mr-auto">
                {translateText("configure.incomplete")}
              </p>
            )}
            <Button type="submit" disabled={invalid || configure.isPending}>
              {translateText("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const { t: translateText } = useTranslation(["plugins", "common"] as const);
  const add = useAddPlugin();
  const [repo, setRepo] = useState("");
  const [rev, setRev] = useState("");
  const [path, setPath] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{translateText("add.title")}</DialogTitle>
          <DialogDescription>
            {translateText("add.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (repo.trim() === "" || add.isPending) return;
            add.mutate(
              { repo: repo.trim(), rev: rev.trim(), path: path.trim() },
              {
                onSuccess: ({ name }) => {
                  toast.success(translateText("add.done", { name }));
                  onClose();
                },
                onError: showError,
              },
            );
          }}
        >
          <Input
            aria-label={translateText("add.repo")}
            placeholder={translateText("add.repo")}
            autoComplete="off"
            spellCheck={false}
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          />
          <Input
            aria-label={translateText("add.rev")}
            placeholder={translateText("add.rev")}
            autoComplete="off"
            spellCheck={false}
            value={rev}
            onChange={(event) => setRev(event.target.value)}
          />
          <Input
            aria-label={translateText("add.path")}
            placeholder={translateText("add.path")}
            autoComplete="off"
            spellCheck={false}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <DialogFooter>
            <Button
              type="submit"
              disabled={repo.trim() === "" || add.isPending}
            >
              {translateText("add.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function sourceText(
  plugin: PluginView,
  translateText: (key: "source.local") => string,
): string {
  return plugin.source.kind === "local"
    ? translateText("source.local")
    : `${plugin.source.repo} @ ${plugin.source.sha.slice(0, 12)}`;
}

function PluginRow({ plugin }: { plugin: PluginView }) {
  const { t: translateText } = useTranslation(["plugins", "common"] as const);
  const update = useUpdatePlugin();
  const remove = useRemovePlugin();
  const [configuring, setConfiguring] = useState(false);
  const [removing, setRemoving] = useState(false);
  const ready = plugin.state === "ready";
  const lacking = plugin.machines.filter(
    (machine) => machine.missing.length > 0,
  );
  const skippedBy =
    ready || plugin.agents.length === 0
      ? undefined
      : plugin.agents.map((agent) => agent.name).join(", ");
  const hasForm = plugin.fields.length > 0 && plugin.problem === null;
  return (
    <li className="space-y-1 px-3 py-2 text-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            {plugin.name}
            {plugin.version === null ? null : (
              <span className="text-xs font-normal text-muted-foreground">
                {plugin.version}
              </span>
            )}
            <Badge variant={ready ? "default" : "outline"}>
              {translateText(`state.${stateKeys[plugin.state]}`)}
            </Badge>
          </p>
          {plugin.description === "" ? null : (
            <p className="text-xs text-muted-foreground">
              {plugin.description}
            </p>
          )}
          <p className="text-xs break-all text-muted-foreground">
            {sourceText(plugin, translateText)}
            {" · "}
            {translateText("summary.parts", {
              skills: plugin.skills.length,
              servers: plugin.servers.length,
            })}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {plugin.source.kind === "git" ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${translateText("actions.update")} ${plugin.name}`}
                disabled={update.isPending}
                onClick={() =>
                  update.mutate(
                    { name: plugin.name },
                    {
                      onSuccess: () =>
                        toast.success(translateText("actions.updated")),
                      onError: showError,
                    },
                  )
                }
              >
                {translateText("actions.update")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${translateText("actions.remove")} ${plugin.name}`}
                onClick={() => setRemoving(true)}
              >
                {translateText("actions.remove")}
              </Button>
            </>
          ) : null}
          {hasForm ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={`${translateText("actions.configure")} ${plugin.name}`}
              onClick={() => setConfiguring(true)}
            >
              {translateText("actions.configure")}
            </Button>
          ) : null}
        </div>
      </div>
      {plugin.problem === null ? null : (
        <p className="text-xs break-words text-destructive">{plugin.problem}</p>
      )}
      {skippedBy === undefined ? null : (
        <p className="text-xs text-destructive">
          {translateText("skipped", { agents: skippedBy })}
        </p>
      )}
      {lacking.map((machine) => (
        <p key={machine.machineId} className="text-xs text-muted-foreground">
          {translateText("requires.missing", {
            machine: machine.name,
            commands: machine.missing.join(", "),
          })}
        </p>
      ))}
      {plugin.reports.map((report) => (
        <p key={report} className="text-xs break-words text-muted-foreground">
          {report}
        </p>
      ))}
      {configuring ? (
        <ConfigureDialog
          plugin={plugin}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("remove.confirmTitle", { name: plugin.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("remove.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate({ name: plugin.name }, { onError: showError })
              }
            >
              {translateText("actions.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Who read which secret, and when. */
function PluginAudit() {
  const { t: translateText } = useTranslation(["plugins"] as const);
  const audit = usePluginAudit();
  if (audit.length === 0) return null;
  const time = new Intl.DateTimeFormat(formatLocale(), {
    dateStyle: "short",
    timeStyle: "medium",
  });
  return (
    <section aria-label={translateText("audit.title")} className="space-y-1">
      <h3 className="text-xs font-semibold">{translateText("audit.title")}</h3>
      <ul aria-label={translateText("audit.title")} className="divide-y border">
        {audit.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap gap-x-3 px-3 py-1.5 text-xs text-muted-foreground"
          >
            <span>{time.format(row.at)}</span>
            <span className="text-foreground">
              {row.agentName ?? translateText("audit.deletedAgent")}
            </span>
            <span className="font-mono">
              {row.plugin}.{row.field}
            </span>
            <span>{translateText(`level.${row.level}`)}</span>
            <span className="font-mono">{row.sessionId}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Settings → 插件. */
export function PluginSettings() {
  const { t: translateText } = useTranslation(["plugins", "common"] as const);
  const { plugins, loaded, error } = usePlugins();
  const recheck = useRecheckPlugins();
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold">{translateText("title")}</h2>
          <p className="text-xs text-muted-foreground">
            {translateText("description")}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={translateText("actions.recheck")}
            title={translateText("actions.recheck")}
            disabled={recheck.isPending}
            onClick={() => recheck.mutate({}, { onError: showError })}
          >
            <ArrowsClockwiseIcon aria-hidden="true" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("actions.add")}
          </Button>
        </div>
      </header>
      {error !== undefined ? (
        <LoadError what={translateText("title")} error={error} />
      ) : !loaded ? (
        <Loading rows={3} />
      ) : plugins.length === 0 ? (
        <Empty icon={PuzzlePieceIcon} title={translateText("empty.title")}>
          {translateText("empty.description")}
        </Empty>
      ) : (
        <ul aria-label={translateText("title")} className="divide-y border">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.name} plugin={plugin} />
          ))}
        </ul>
      )}
      <PluginAudit />
      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
