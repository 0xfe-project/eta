import type { UpgradeBusy } from "@eta/client-contracts";
import type { ShellUpdateView } from "@eta/client-contracts/desktop";
import type { ReactNode } from "react";
import type { UpdateTone } from "./update-status";
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
import {
  UpdateNotice,
  UpdateProgressBar,
  UpdateStatusBar,
} from "./update-status";

// Settings → Update, the desktop app's own part: its version and its update, apart from the host's.
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

  const target =
    view.state === "available" ||
    view.state === "downloading" ||
    view.state === "ready" ||
    view.state === "applying"
      ? view.version
      : undefined;
  const checkButton = (
    <Button
      variant="ghost"
      size="xs"
      className="h-5 px-1 font-normal text-muted-foreground"
      disabled={asking}
      onClick={() => act("check")}
    >
      {translateText("desktopUpdate.check")}
    </Button>
  );
  const bar: { tone: UpdateTone; state: string; actions?: ReactNode } =
    view.state === "checking"
      ? { tone: "info", state: translateText("desktopUpdate.checking") }
      : view.state === "available"
        ? {
            tone: "info",
            state: translateText("desktopUpdate.state.available"),
            actions: (
              <>
                <Button
                  size="xs"
                  disabled={asking}
                  onClick={() => act("download")}
                >
                  {translateText("desktopUpdate.download", {
                    version: view.version,
                  })}
                </Button>
                {checkButton}
              </>
            ),
          }
        : view.state === "downloading"
          ? {
              tone: "info",
              state:
                view.progress === undefined
                  ? translateText("desktopUpdate.downloading", {
                      version: view.version,
                    })
                  : translateText("desktopUpdate.downloadingPercent", {
                      version: view.version,
                      percent: Math.round(view.progress),
                    }),
            }
          : view.state === "ready"
            ? {
                tone: "info",
                state: translateText("desktopUpdate.state.ready"),
                actions: (
                  <Button
                    size="xs"
                    disabled={asking}
                    onClick={() => setConfirming(true)}
                  >
                    {translateText("desktopUpdate.restart", {
                      version: view.version,
                    })}
                  </Button>
                ),
              }
            : view.state === "applying"
              ? {
                  tone: "info",
                  state: translateText("desktopUpdate.applying", {
                    version: view.version,
                  }),
                }
              : view.state === "failed"
                ? {
                    tone: "error",
                    state: translateText("desktopUpdate.state.failed"),
                    actions: checkButton,
                  }
                : view.state === "current"
                  ? {
                      tone: "success",
                      state: translateText("desktopUpdate.upToDate"),
                      actions: checkButton,
                    }
                  : {
                      tone: "muted",
                      state: translateText("desktopUpdate.state.idle"),
                      actions: checkButton,
                    };

  return (
    <div>
      <UpdateStatusBar
        title={translateText("desktopUpdate.title")}
        version={view.current}
        target={target}
        tone={bar.tone}
        state={bar.state}
        actions={bar.actions}
      />
      {view.state === "downloading" && (
        <UpdateProgressBar value={view.progress} label={bar.state} />
      )}
      {view.state === "failed" && (
        <UpdateNotice tone="error">
          <p>
            {translateText(`desktopUpdate.failed.${view.during}`, {
              error: view.error,
            })}
          </p>
        </UpdateNotice>
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
