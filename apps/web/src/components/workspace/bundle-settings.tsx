import type { BundleField, BundleView } from "@eta/client-contracts";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { PlusIcon } from "@phosphor-icons/react/Plus";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  useAddBundle,
  useBundles,
  useConfigureBundle,
  useRecheckBundles,
  useRefreshBundles,
  useRemoveBundle,
} from "@/queries/bundles";
import { wireErrorMessage } from "@/queries/wire";

// Settings → 环境包: what bundles there are and where each came from, whether it is set up, what
// it needs from each machine, and the form for its values. A secret is typed here once and is
// never shown again.

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** One bundle's values as a form: a field each, secrets blank (the saved one stays). */
function ConfigureDialog({
  bundle,
  onClose,
}: {
  bundle: BundleView;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  const configure = useConfigureBundle();
  const id = useId();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      bundle.fields.map((field) => [field.name, field.value ?? ""]),
    ),
  );
  const [clearing, setClearing] = useState(false);

  /** What changed: a typed secret, an edited value; a value emptied is cleared. */
  const changes = (): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    for (const field of bundle.fields) {
      const value = (draft[field.name] ?? "").trim();
      if (field.secret) {
        if (value !== "") out[field.name] = value;
      } else if (value !== (field.value ?? "")) {
        out[field.name] = value === "" ? null : value;
      }
    }
    return out;
  };
  const requiredMissing = bundle.fields.some(
    (field) =>
      field.required && !field.set && (draft[field.name] ?? "").trim() === "",
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[calc(100%-2rem)] sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {translateText("configure.title", { name: bundle.name })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            configure.mutate(
              { name: bundle.name, values: changes() },
              {
                onSuccess: () => {
                  toast.success(
                    requiredMissing
                      ? translateText("configure.savedIncomplete")
                      : translateText("configure.savedReady"),
                  );
                  onClose();
                },
                onError: showError,
              },
            );
          }}
        >
          {bundle.fields.map((field: BundleField) => (
            <div key={field.name} className="space-y-1">
              <label
                htmlFor={`${id}-${field.name}`}
                className="text-xs font-medium"
              >
                {field.title}
                {field.required ? null : (
                  <span className="font-normal text-muted-foreground">
                    {translateText("common:labels.optionalSuffix")}
                  </span>
                )}
              </label>
              <Input
                id={`${id}-${field.name}`}
                type={field.secret ? "password" : "text"}
                value={draft[field.name] ?? ""}
                maxLength={field.maxLength}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  field.secret && field.set
                    ? translateText("configure.secretPlaceholder")
                    : undefined
                }
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
              />
              {field.description ? (
                <Markdown className="text-xs text-muted-foreground">
                  {field.description}
                </Markdown>
              ) : null}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {translateText("configure.encryptionHelp", { name: bundle.name })}
          </p>
          <DialogFooter className="gap-2 sm:justify-end">
            {bundle.fields.some((field) => field.set) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground sm:mr-auto"
                onClick={() => setClearing(true)}
              >
                {translateText("configure.clear")}
              </Button>
            ) : null}
            <Button type="submit" disabled={configure.isPending}>
              {translateText("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
        <AlertDialog open={clearing} onOpenChange={setClearing}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {translateText("configure.clearConfirmTitle", {
                  name: bundle.name,
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {translateText("configure.clearConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {translateText("common:actions.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  configure.mutate(
                    {
                      name: bundle.name,
                      values: Object.fromEntries(
                        bundle.fields.map((field) => [field.name, null]),
                      ),
                    },
                    {
                      onSuccess: () => {
                        toast.success(translateText("configure.cleared"));
                        onClose();
                      },
                      onError: showError,
                    },
                  )
                }
              >
                {translateText("common:actions.clear")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

/** A bundle from git: where, which branch, tag or commit, and which directory of it. */
function AddDialog({ onClose }: { onClose: () => void }) {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  const add = useAddBundle();
  const [repo, setRepo] = useState("");
  const [rev, setRev] = useState("");
  const [path, setPath] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{translateText("add.title")}</DialogTitle>
          <DialogDescription>{translateText("add.hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (repo.trim() === "" || add.isPending) return;
            add.mutate(
              {
                repo: repo.trim(),
                ...(rev.trim() === "" ? {} : { rev: rev.trim() }),
                ...(path.trim() === "" ? {} : { path: path.trim() }),
              },
              {
                onSuccess: ({ name }) => {
                  toast.success(translateText("add.added", { name }));
                  onClose();
                },
                onError: showError,
              },
            );
          }}
        >
          <Input
            aria-label={translateText("add.repo")}
            placeholder={translateText("add.repoPlaceholder")}
            autoFocus
            spellCheck={false}
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              aria-label={translateText("add.rev")}
              placeholder={translateText("add.revPlaceholder")}
              spellCheck={false}
              value={rev}
              onChange={(event) => setRev(event.target.value)}
            />
            <Input
              aria-label={translateText("add.path")}
              placeholder={translateText("add.pathPlaceholder")}
              spellCheck={false}
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {translateText("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={repo.trim() === "" || add.isPending}
            >
              {translateText("add.title")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What the user has to know about a bundle: what it needs from machines, how its service is. */
function Notes({ bundle }: { bundle: BundleView }) {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  // Only where a command is known to be missing. A machine that could not be asked has nothing
  // to say about the bundle: whether it is reachable is the machines section's to show.
  const machines = bundle.machines.filter(
    (machine) => machine.missing.length > 0,
  );
  const lines = [
    bundle.requires.length > 0
      ? translateText("summary.requires", {
          commands: bundle.requires.join(", "),
        })
      : null,
    ...machines.map((machine) =>
      translateText("summary.missing", {
        machine: machine.name,
        commands: machine.missing.join(", "),
      }),
    ),
    bundle.service === null
      ? null
      : [
          translateText(`service.${bundle.service.state}`),
          bundle.service.message,
        ]
          .filter(Boolean)
          .join(": "),
  ].filter((line): line is string => line !== null);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {translateText("summary.contents", {
          skills: bundle.skills.length,
          servers: bundle.mcpServers.length,
          hooks: bundle.hooks ? translateText("summary.hooks") : "",
        })}
      </p>
      {lines.map((line) => (
        <p key={line} className="text-xs text-muted-foreground">
          {line}
        </p>
      ))}
    </>
  );
}

function BundleCard({ bundle }: { bundle: BundleView }) {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  const refresh = useRefreshBundles();
  const remove = useRemoveBundle();
  const [configuring, setConfiguring] = useState(false);
  const [removing, setRemoving] = useState(false);
  const git = bundle.source.kind === "git";
  const source = git
    ? `git · ${bundle.sha?.slice(0, 7) ?? ""}`
    : translateText(`sources.${bundle.source.kind}`);
  return (
    <li className="flex items-start gap-3 p-3 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          {bundle.name}
          <span className="text-xs font-normal text-muted-foreground">
            {source}
          </span>
          {bundle.problem !== null ? (
            <Badge variant="destructive">
              {translateText("status.problem")}
            </Badge>
          ) : bundle.fields.length > 0 ? (
            <Badge variant="outline">
              {bundle.configured
                ? translateText("status.configured")
                : translateText("status.notConfigured")}
            </Badge>
          ) : null}
        </p>
        {bundle.problem !== null ? (
          <p className="text-xs text-destructive">{bundle.problem}</p>
        ) : (
          <>
            {bundle.description ? (
              <p className="text-muted-foreground">{bundle.description}</p>
            ) : null}
            <Notes bundle={bundle} />
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-1">
        {bundle.fields.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${translateText("actions.configure")} ${bundle.name}`}
            onClick={() => setConfiguring(true)}
          >
            {translateText("actions.configure")}
          </Button>
        ) : null}
        {git ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${translateText("actions.refresh")} ${bundle.name}`}
              disabled={refresh.isPending}
              onClick={() =>
                refresh.mutate(
                  { name: bundle.name },
                  {
                    onSuccess: ({ names }) =>
                      toast(
                        translateText("refresh.done", {
                          names: names.join(", "),
                        }),
                      ),
                    onError: showError,
                  },
                )
              }
            >
              {translateText("actions.refresh")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${translateText("actions.remove")} ${bundle.name}`}
              onClick={() => setRemoving(true)}
            >
              {translateText("actions.remove")}
            </Button>
          </>
        ) : null}
      </div>
      {configuring ? (
        <ConfigureDialog
          bundle={bundle}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("remove.confirmTitle", { name: bundle.name })}
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
                remove.mutate(
                  { name: bundle.name },
                  {
                    onSuccess: () =>
                      toast(
                        translateText("remove.done", { name: bundle.name }),
                      ),
                    onError: showError,
                  },
                )
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

/** Settings → 环境包. */
export function BundleSettings() {
  const { t: translateText } = useTranslation(["bundles", "common"] as const);
  const { bundles, loaded, error } = useBundles();
  const recheck = useRecheckBundles();
  const refreshAll = useRefreshBundles();
  const [adding, setAdding] = useState(false);
  const hasGit = bundles.some((bundle) => bundle.source.kind === "git");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        <div className="flex gap-1">
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
          {hasGit ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={refreshAll.isPending}
              onClick={() =>
                refreshAll.mutate(
                  {},
                  {
                    onSuccess: ({ names }) =>
                      toast(
                        translateText("refresh.done", {
                          names: names.join(", "),
                        }),
                      ),
                    onError: showError,
                  },
                )
              }
            >
              {translateText("actions.refreshAll")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("actions.add")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {translateText("description")}
      </p>
      {error ? (
        <LoadError what={translateText("title")} error={error} />
      ) : !loaded ? (
        <Loading rows={3} />
      ) : bundles.length === 0 ? (
        <Empty icon={PackageIcon} title={translateText("empty.title")}>
          {translateText("empty.description")}
        </Empty>
      ) : (
        <ul aria-label={translateText("title")} className="divide-y border">
          {bundles.map((bundle) => (
            <BundleCard key={bundle.name} bundle={bundle} />
          ))}
        </ul>
      )}
      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
