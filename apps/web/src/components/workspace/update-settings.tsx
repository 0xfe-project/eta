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
  busyLabels,
  phaseKeys,
  useCancelUpgrade,
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

export function UpdateSettings() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const check = useUpgradeCheck();
  const status = useUpgradeWatch()?.status ?? null;
  const start = useStartUpgrade();
  const cancel = useCancelUpgrade();
  const [confirming, setConfirming] = useState(false);

  if (check.isPending) return <Loading rows={2} />;
  if (check.isError)
    return (
      <LoadError
        what={translateText("sections.update")}
        error={check.error}
        onRetry={() => void check.refetch()}
      />
    );
  const { available, blocked, busy, error, latest, version } = check.data;
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
