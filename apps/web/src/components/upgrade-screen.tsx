import type { UpgradePhase } from "@eta/client-contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/components/workspace/workspace-store";
import { phaseKeys, useUpgradeWatch } from "@/queries/upgrade";

// What covers the window while the host is replaced. Downloading and waiting for agents leave the
// page alone, since the user may have to answer one of them; from the moment the service stops
// nothing behind this works. The page keeps asking `/upgrade/status`, and when the upgrade this
// tab watched has ended, says so: a new version reloads the page, anything else stays to be read.

const SERVICE_DOWN = new Set<UpgradePhase>([
  "stopping",
  "backing-up",
  "restarting",
  "verifying",
  "rolling-back",
]);

/** How long the host may stay away before the screen says that is not normal. */
const SLOW_MS = 5 * 60_000;
const RELOAD_MS = 1200;

const reload = () => location.reload();

function Card({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string | undefined;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-background p-6"
    >
      <div className="w-full max-w-md space-y-3">
        <h1 className="font-medium">{title}</h1>
        {detail !== undefined && (
          <p className="text-sm text-muted-foreground">{detail}</p>
        )}
        {children}
      </div>
    </div>
  );
}

export function UpgradeScreen() {
  const { t: translateText } = useTranslation(["settings"] as const);
  const watch = useUpgradeWatch();
  const status = watch?.status ?? null;
  const reachable = watch?.reachable ?? true;
  const running = status?.state === "running";
  const down = running && (!reachable || SERVICE_DOWN.has(status.phase));

  // The upgrade this tab saw running: an old result on disk is not news.
  const [watched, setWatched] = useState<string>();
  const [dismissed, setDismissed] = useState<string>();
  if (running && status.id !== watched) setWatched(status.id);

  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (reachable || !running) return;
    const timer = setTimeout(setSlow, SLOW_MS, true);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [reachable, running]);

  // A modal dialog holds the pointer and the focus, and nothing under this screen is any use.
  useEffect(() => {
    if (!down) return;
    const { setSettings, settings } = useWorkspaceStore.getState();
    if (settings.open) setSettings({ ...settings, open: false });
  }, [down]);

  const ended =
    status !== null && !running && status.id === watched ? status : undefined;
  const updated = ended?.state === "done";
  useEffect(() => {
    if (!updated) return;
    const timer = setTimeout(reload, RELOAD_MS);
    return () => clearTimeout(timer);
  }, [updated]);

  if (down) {
    const detail = !reachable
      ? translateText("update.screen.offline")
      : translateText(`update.phase.${phaseKeys[status.phase]}`);
    return (
      <Card
        title={
          status.to === undefined
            ? translateText("update.screen.updatingUnknown")
            : translateText("update.screen.updating", { version: status.to })
        }
        detail={slow ? translateText("update.screen.slow") : detail}
      >
        <Skeleton className="h-1 w-full" />
        {slow && (
          <p className="text-xs text-muted-foreground">
            {translateText("update.screen.help")}
          </p>
        )}
      </Card>
    );
  }
  if (updated)
    return (
      <Card
        title={translateText("update.screen.done", {
          version: ended.to ?? "",
        })}
        detail={translateText("update.screen.reloading")}
      />
    );
  // Failed or cancelled before the service was touched: the settings page says so, in place.
  if (
    ended === undefined ||
    ended.id === dismissed ||
    ended.state === "failed" ||
    ended.state === "cancelled"
  )
    return null;
  const rolledBack = ended.state === "rolled-back";
  return (
    <Card
      title={translateText(
        rolledBack ? "update.screen.rolledBack" : "update.screen.broken",
      )}
      detail={
        rolledBack
          ? translateText("update.screen.rolledBackDetail", {
              version: ended.from,
            })
          : translateText("update.screen.help")
      }
    >
      {ended.error !== undefined && (
        <p className="text-xs break-words text-muted-foreground">
          {ended.error}
        </p>
      )}
      {rolledBack && (
        <Button onClick={() => setDismissed(ended.id)}>
          {translateText("update.screen.dismiss")}
        </Button>
      )}
    </Card>
  );
}
