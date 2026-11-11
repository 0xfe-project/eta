import type { UpgradeBusy } from "@eta/client-contracts";
import type { ShellUpdateView } from "@eta/client-contracts/desktop";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { host, shellUpdate, shellUpdateAction } from "@/lib/native";
import { busyLabels, useUpgradeCheck } from "@/queries/upgrade";

// Settings → 更新, the desktop app's own part: its version and its update, apart from the host's.
// Every step is a press here; the app neither checks nor installs by itself
// (`apps/desktop/src/bun/update.ts`). Applying quits the app and starts the new one, and in local
// mode the host goes with it, so the dialog says what a restart would stop.

/** How often to ask while the app is busy with a step. */
const POLL_MS = 500;

const WORKING = new Set<ShellUpdateView["state"]>([
  "checking",
  "downloading",
  "applying",
]);

export function DesktopUpdate() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const [view, setView] = useState<ShellUpdateView | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // What a restart of the local host would stop: the host's own answer.
  const busy: UpgradeBusy[] = useUpgradeCheck().data?.busy ?? [];
  const local = host().connection !== "remote";

  const refresh = useCallback(async () => {
    setView(await shellUpdate());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Only while something is under way; nothing asks in the background otherwise.
  const working = asking || (view !== null && WORKING.has(view.state));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [working, refresh]);

  if (view === null) return null;
  // The answer comes when the step is done; until then the poll shows it moving.
  const act = (action: "check" | "download" | "apply") => {
    setAsking(true);
    void shellUpdateAction(action).then((next) => {
      setAsking(false);
      if (next !== null) setView(next);
    });
  };

  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          {translateText("desktopUpdate.version")}
        </dt>
        <dd className="break-all">{view.current}</dd>
      </dl>
      {view.state === "checking" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {translateText("desktopUpdate.checking")}
        </p>
      ) : view.state === "available" ? (
        <Button disabled={asking} onClick={() => act("download")}>
          {translateText("desktopUpdate.download", { version: view.version })}
        </Button>
      ) : view.state === "downloading" ? (
        <p role="status" className="text-sm">
          {view.progress === undefined
            ? translateText("desktopUpdate.downloading", {
                version: view.version,
              })
            : translateText("desktopUpdate.downloadingPercent", {
                version: view.version,
                percent: Math.round(view.progress),
              })}
        </p>
      ) : view.state === "ready" ? (
        <Button disabled={asking} onClick={() => setConfirming(true)}>
          {translateText("desktopUpdate.restart", { version: view.version })}
        </Button>
      ) : view.state === "applying" ? (
        <p role="status" className="text-sm">
          {translateText("desktopUpdate.applying", { version: view.version })}
        </p>
      ) : (
        <div className="space-y-1">
          {view.state === "current" && (
            <p className="text-sm text-muted-foreground">
              {translateText("desktopUpdate.upToDate")}
            </p>
          )}
          {view.state === "failed" && (
            <p className="text-sm break-words text-destructive">
              {translateText(`desktopUpdate.failed.${view.during}`, {
                error: view.error,
              })}
            </p>
          )}
          <Button
            variant="outline"
            disabled={asking}
            onClick={() => act("check")}
          >
            {translateText("desktopUpdate.check")}
          </Button>
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("desktopUpdate.confirmTitle", {
                version: view.state === "ready" ? view.version : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText(
                local ? "desktopUpdate.confirm" : "desktopUpdate.confirmRemote",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {local && busy.length > 0 && (
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
            <AlertDialogAction
              variant={local && busy.length > 0 ? "destructive" : "default"}
              onClick={() => {
                setConfirming(false);
                act("apply");
              }}
            >
              {translateText("desktopUpdate.restartNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
