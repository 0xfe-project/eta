import type {
  UpgradeTokenView,
  UpgradeUpstreamView,
} from "@eta/client-contracts";
import type { TFunction } from "i18next";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
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
import { Input } from "@/components/ui/input";
import {
  busyLabels,
  phaseKeys,
  useCancelUpgrade,
  useSetToken,
  useSetUpstream,
  useStartUpgrade,
  useUpgradeCheck,
  useUpgradeWatch,
} from "@/queries/upgrade";
import { wireErrorMessage } from "@/queries/wire";

// Settings → 更新: which version this host is, whether there is a newer one, and the button. The
// work happens in a process of its own (`apps/eta/src/upgrade/worker.ts`); from the moment the
// service stops this page is under `UpgradeScreen`.

const blockKeys = {
  source: "source",
  "no-service": "noService",
  "no-windows-service": "noWindowsService",
  "other-file": "otherFile",
} as const;

const CANCELLABLE = new Set(["starting", "downloading", "waiting"]);

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** Where updates come from, with the warning that goes with it. A failed save stays open to fix. */
function UpstreamDialog({
  upstream,
  onClose,
}: {
  upstream: UpgradeUpstreamView;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const save = useSetUpstream();
  const [value, setValue] = useState(upstream.saved ?? "");
  const valid = value.trim() !== "";

  const submit = () => {
    if (!valid || save.isPending) return;
    save.mutate(
      { upstream: value.trim() },
      { onSuccess: onClose, onError: showError },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{translateText("update.upstreamTitle")}</DialogTitle>
          <DialogDescription className="text-destructive">
            {translateText("update.upstreamWarning")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label={translateText("update.upstreamInput")}
            placeholder={translateText("update.upstreamPlaceholder")}
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </form>
        <p className="text-xs break-words text-muted-foreground">
          {translateText("update.upstreamHint")}
        </p>
        <DialogFooter>
          {upstream.saved !== null && (
            <Button
              variant="outline"
              className="sm:mr-auto"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({}, { onSuccess: onClose, onError: showError })
              }
            >
              {translateText("update.upstreamReset", {
                fallback: upstream.fallback,
              })}
            </Button>
          )}
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

/** Empty every time: a saved token does not come back, so there is nothing to edit. */
function TokenDialog({
  host,
  saved,
  onClose,
}: {
  host: string;
  saved: boolean;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const save = useSetToken();
  const [value, setValue] = useState("");
  const valid = value.trim() !== "";

  const submit = () => {
    if (!valid || save.isPending) return;
    save.mutate({ token: value }, { onSuccess: onClose, onError: showError });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{translateText("update.tokenTitle")}</DialogTitle>
          <DialogDescription>
            {translateText("update.tokenDescription", { host })}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label={translateText("update.tokenInput")}
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </form>
        <p className="text-xs break-words text-muted-foreground">
          {translateText("update.tokenHint")}
        </p>
        <DialogFooter>
          {saved && (
            <Button
              variant="outline"
              className="sm:mr-auto"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({}, { onSuccess: onClose, onError: showError })
              }
            >
              {translateText("update.tokenRemove")}
            </Button>
          )}
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

/** Which token reads the upstream, and why a saved one might not be it. */
function tokenNotes(
  token: UpgradeTokenView,
  translateText: TFunction<"settings">,
) {
  const { from, host, saved } = token;
  const name = from ?? "";
  const source =
    from === null
      ? translateText("update.tokenFrom.none")
      : from === "gh"
        ? translateText("update.tokenFrom.gh")
        : from === "Settings"
          ? translateText("update.tokenFrom.saved")
          : translateText("update.tokenFrom.env", { name });
  const note =
    saved === null || from === "Settings"
      ? null
      : saved !== host
        ? translateText("update.tokenOtherHost", { host: saved })
        : from !== null && from !== "gh"
          ? translateText("update.tokenOutranked", { name })
          : null;
  return { source, note };
}

export function UpdateSettings() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const check = useUpgradeCheck();
  const status = useUpgradeWatch()?.status ?? null;
  const start = useStartUpgrade();
  const cancel = useCancelUpgrade();
  const [confirming, setConfirming] = useState(false);
  const [changing, setChanging] = useState(false);
  const [settingToken, setSettingToken] = useState(false);

  if (check.isPending) return <Loading rows={2} />;
  if (check.isError)
    return (
      <LoadError
        what={translateText("sections.update")}
        error={check.error}
        onRetry={() => void check.refetch()}
      />
    );
  const { available, blocked, busy, error, latest, token, upstream, version } =
    check.data;
  const notes = tokenNotes(token, translateText);
  const running = status?.state === "running";
  const failed =
    status?.state === "failed" ||
    status?.state === "rolled-back" ||
    status?.state === "lost";

  const go = (force: boolean) => {
    setConfirming(false);
    start.mutate({ force }, { onError: showError });
  };

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          {translateText("update.version")}
        </dt>
        <dd className="break-all">{version}</dd>
        <dt className="text-muted-foreground">
          {translateText("update.latest")}
        </dt>
        <dd className="flex items-center gap-1">
          {latest ?? translateText("update.unknown")}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translateText("update.recheck")}
            title={translateText("update.recheck")}
            disabled={check.isFetching}
            onClick={() => void check.refetch()}
          >
            <ArrowsClockwiseIcon aria-hidden="true" />
          </Button>
        </dd>
        <dt className="text-muted-foreground">
          {translateText("update.upstream")}
        </dt>
        <dd className="flex flex-wrap items-center gap-x-2">
          <span className="break-all">{upstream.label}</span>
          <span className="text-muted-foreground">
            {translateText(`update.upstreamFrom.${upstream.source}`)}
          </span>
          {/* What the environment says wins, so a setting would change nothing. */}
          {upstream.source !== "env" && (
            <Button
              variant="ghost"
              size="xs"
              disabled={running}
              onClick={() => setChanging(true)}
            >
              {translateText("update.upstreamChange")}
            </Button>
          )}
        </dd>
        {/* Another server has its own token, and GitHub's credentials do not go there. */}
        {token.host !== null && (
          <>
            <dt className="text-muted-foreground">
              {translateText("update.token")}
            </dt>
            <dd className="flex flex-wrap items-center gap-x-2">
              <span>{notes.source}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setSettingToken(true)}
              >
                {translateText(
                  token.saved === null
                    ? "update.tokenSet"
                    : "update.tokenChange",
                )}
              </Button>
              {notes.note !== null && (
                <span className="w-full text-muted-foreground">
                  {notes.note}
                </span>
              )}
            </dd>
          </>
        )}
      </dl>

      {error !== null && (
        <p className="text-sm text-destructive">
          {translateText("update.checkFailed", { error })}
        </p>
      )}

      {running ? (
        <div className="space-y-2 text-sm">
          <p role="status">
            {translateText(`update.phase.${phaseKeys[status.phase]}`)}
          </p>
          {status.busy !== undefined && (
            <p className="text-muted-foreground">
              {translateText("update.waitingFor", {
                list: busyLabels(status.busy).join("、"),
              })}
            </p>
          )}
          {CANCELLABLE.has(status.phase) && (
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({}, { onError: showError })}
            >
              {translateText("update.cancel")}
            </Button>
          )}
        </div>
      ) : blocked !== null ? (
        <p className="text-sm text-muted-foreground">
          {translateText(`update.blocked.${blockKeys[blocked]}`)}
        </p>
      ) : available && latest !== null ? (
        <Button disabled={start.isPending} onClick={() => setConfirming(true)}>
          {translateText("update.install", { version: latest })}
        </Button>
      ) : (
        error === null && (
          <p className="text-sm text-muted-foreground">
            {translateText("update.upToDate")}
          </p>
        )
      )}

      {failed && !running && status.error !== undefined && (
        <p className="text-sm break-words text-destructive">
          {translateText("update.lastFailed", { error: status.error })}
        </p>
      )}

      {changing && (
        <UpstreamDialog
          upstream={upstream}
          onClose={() => setChanging(false)}
        />
      )}

      {settingToken && token.host !== null && (
        <TokenDialog
          host={token.host}
          saved={token.saved !== null}
          onClose={() => setSettingToken(false)}
        />
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("update.confirmTitle", { version: latest })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("update.confirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {busy.length > 0 && (
            <div className="text-sm">
              <p>{translateText("update.busy")}</p>
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {busyLabels(busy).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            {busy.length > 0 ? (
              <>
                <AlertDialogAction variant="outline" onClick={() => go(false)}>
                  {translateText("update.waitForAgents")}
                </AlertDialogAction>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => go(true)}
                >
                  {translateText("update.force")}
                </AlertDialogAction>
              </>
            ) : (
              <AlertDialogAction onClick={() => go(false)}>
                {translateText("update.start")}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
