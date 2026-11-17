import type {
  UpgradePhase,
  UpgradeTokenView,
  UpgradeUpstreamView,
} from "@eta/client-contracts";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import type { UpdateTone } from "./update-status";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { useEffect, useId, useReducer, useState } from "react";
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
import { hasCapability, host } from "@/lib/native";
import {
  busyLabels,
  phaseKeys,
  useCancelUpgrade,
  useSetPrerelease,
  useSetToken,
  useSetUpstream,
  useStartUpgrade,
  useUpgradeCheck,
  useUpgradeWatch,
} from "@/queries/upgrade";
import { wireErrorMessage } from "@/queries/wire";
import { DesktopUpdate } from "./desktop-update";
import {
  ReleaseNotes,
  UpdateGroup,
  UpdateNotice,
  UpdateRow,
  UpdateStatusBar,
  UpdateSteps,
} from "./update-status";

// Settings → Update: which version this host is, whether there is a newer one, and the button,
// in one bar at the top (`update-status.tsx`); under it, what goes wrong or how far an update has
// got, then which versions to take and where they come from. The work happens in a process of its own (`apps/eta/src/upgrade/worker.ts`); from the moment the
// service stops this page is under `UpgradeScreen`. In a window connected to a remote host all of
// this is that host's, so it says which one: the button does not touch the computer it is on.

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

/**
 * The desktop app's own update over the host's, one bar each, when the app can update itself; the
 * host's alone otherwise, as in a browser.
 */
export function UpdateSettings() {
  if (!hasCapability("shell-update")) return <HostUpdate />;
  return (
    <div className="space-y-3">
      <DesktopUpdate />
      <HostUpdate />
    </div>
  );
}

/** The six steps an update is drawn in; each phase is one of them. */
const STEPS = [
  "starting",
  "downloading",
  "waiting",
  "backingUp",
  "restarting",
  "verifying",
] as const;

const stepOf = {
  starting: 0,
  downloading: 1,
  waiting: 2,
  // The service stops so the database can be copied: the same step for the eye.
  stopping: 3,
  "backing-up": 3,
  restarting: 4,
  verifying: 5,
  "rolling-back": 5,
} as const satisfies Record<UpgradePhase, number>;

/** Renders again now and then, so "checked N minutes ago" keeps up. */
function useTick(ms: number) {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** "Checked just now", "Checked 5 minutes ago". */
function checkedAgo(at: number, translateText: TFunction<"settings">) {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return translateText("update.checked.justNow");
  if (minutes < 60)
    return translateText("update.checked.minutes", { count: minutes });
  return translateText("update.checked.hours", {
    count: Math.floor(minutes / 60),
  });
}

/** Who the bar is about: this server in a browser, this computer in the app, or the remote one. */
function hostTitle(translateText: TFunction<"settings">) {
  const { address, connection, kind } = host();
  if (connection === "remote" && address !== undefined)
    return translateText("update.title.remote", { host: address });
  return translateText(
    kind === "desktop" ? "update.title.computer" : "update.title.server",
  );
}

function HostUpdate() {
  const { t: translateText } = useTranslation(["settings", "common"] as const);
  const check = useUpgradeCheck();
  const status = useUpgradeWatch()?.status ?? null;
  const start = useStartUpgrade();
  const cancel = useCancelUpgrade();
  const setPrerelease = useSetPrerelease();
  const [confirming, setConfirming] = useState(false);
  const [changing, setChanging] = useState(false);
  const [settingToken, setSettingToken] = useState(false);
  // Null until the user folds or unfolds it: until then it follows whether something is off.
  const [advanced, setAdvanced] = useState<boolean | null>(null);
  const channelId = useId();
  useTick(30_000);

  if (check.isPending) return <Loading rows={2} />;
  if (check.isError)
    return (
      <LoadError
        what={translateText("sections.update")}
        error={check.error}
        onRetry={() => void check.refetch()}
      />
    );
  const {
    available,
    blocked,
    busy,
    error,
    heldOnPrerelease,
    latest,
    notes,
    prerelease,
    token,
    upstream,
    version,
  } = check.data;
  const tokenNote = tokenNotes(token, translateText);
  const { address, connection } = host();
  const remote = connection === "remote" ? address : undefined;
  const running = status?.state === "running";
  const failed =
    !running &&
    (status?.state === "failed" ||
      status?.state === "rolled-back" ||
      status?.state === "lost");
  const offer = available && latest !== null;
  const advancedOpen =
    advanced ??
    (upstream.source !== "build" || tokenNote.note !== null || error !== null);

  const go = (force: boolean) => {
    setConfirming(false);
    start.mutate({ force }, { onError: showError });
  };
  const recheck = () => void check.refetch();
  const install = (label: string) => (
    <Button
      size="xs"
      disabled={start.isPending || blocked !== null}
      onClick={() => setConfirming(true)}
    >
      {label}
    </Button>
  );
  const recheckButton = (
    <Button
      variant="ghost"
      size="xs"
      className="h-5 px-1 font-normal text-muted-foreground"
      disabled={check.isFetching}
      onClick={recheck}
    >
      {translateText("update.recheck")}
    </Button>
  );

  // One state, in the order they matter: what is happening, what went wrong, what can be done.
  const bar: {
    tone: UpdateTone;
    state: string;
    target?: string | undefined;
    primary?: ReactNode;
    recheck: boolean;
  } = running
    ? {
        tone: "info",
        state: translateText("update.state.running", {
          phase: translateText(`update.phase.${phaseKeys[status.phase]}`),
        }),
        target: status.to,
        primary: CANCELLABLE.has(status.phase) ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({}, { onError: showError })}
          >
            {translateText("update.cancel")}
          </Button>
        ) : undefined,
        recheck: false,
      }
    : failed
      ? {
          tone: "error",
          state: translateText("update.state.lastFailed"),
          primary:
            offer && blocked === null
              ? install(translateText("update.tryAgain"))
              : undefined,
          recheck: true,
        }
      : blocked !== null
        ? {
            tone: "muted",
            state: translateText("update.state.blocked"),
            primary: offer
              ? install(translateText("update.install", { version: latest }))
              : undefined,
            recheck: true,
          }
        : error !== null
          ? {
              tone: "error",
              state: translateText("update.state.checkFailed"),
              primary: (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={check.isFetching}
                  onClick={recheck}
                >
                  {translateText("update.retry")}
                </Button>
              ),
              recheck: false,
            }
          : offer
            ? {
                tone: "info",
                state: translateText("update.state.available"),
                target: latest,
                primary: install(
                  translateText("update.install", { version: latest }),
                ),
                recheck: true,
              }
            : heldOnPrerelease
              ? {
                  tone: "warning",
                  state: translateText("update.state.held"),
                  recheck: true,
                }
              : {
                  tone: "success",
                  state: translateText("update.upToDate"),
                  recheck: true,
                };

  return (
    <div>
      <UpdateStatusBar
        title={hostTitle(translateText)}
        version={version}
        target={bar.target}
        tone={bar.tone}
        state={bar.state}
        actions={
          <>
            {bar.primary}
            {bar.recheck && recheckButton}
          </>
        }
        meta={
          running ? undefined : checkedAgo(check.dataUpdatedAt, translateText)
        }
      />

      {!running && offer && notes !== null && (
        <ReleaseNotes text={notes.text} url={notes.url} />
      )}

      {running && (
        <UpdateSteps
          steps={STEPS.map((key) => ({
            key,
            label: translateText(`update.steps.${key}`),
          }))}
          current={stepOf[status.phase]}
          failing={status.phase === "rolling-back"}
        >
          {status.busy !== undefined && status.busy.length > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {translateText("update.waitingFor", {
                list: busyLabels(status.busy).join("、"),
              })}
            </p>
          )}
        </UpdateSteps>
      )}

      {failed && status.error !== undefined && (
        <UpdateNotice tone="error">
          <p>{translateText("update.lastFailed", { error: status.error })}</p>
          <p className="text-muted-foreground">
            {translateText("update.screen.help")}
          </p>
        </UpdateNotice>
      )}
      {!running && blocked !== null && (
        <UpdateNotice tone="warning">
          <p>{translateText(`update.blocked.${blockKeys[blocked]}`)}</p>
        </UpdateNotice>
      )}
      {!running && error !== null && (
        <UpdateNotice tone="error">
          <p>{translateText("update.checkFailed", { error })}</p>
          <p className="text-muted-foreground">
            {translateText("update.checkFailedNext")}
          </p>
        </UpdateNotice>
      )}

      <UpdateGroup label={translateText("update.channel")}>
        <UpdateRow
          label={translateText("update.channelLabel")}
          labelId={channelId}
          value={
            // The host's setting: on a remote host, that host's.
            <div
              role="group"
              aria-labelledby={channelId}
              className="inline-flex border border-border"
            >
              {[false, true].map((on) => (
                <button
                  key={String(on)}
                  type="button"
                  aria-pressed={prerelease === on}
                  disabled={running || setPrerelease.isPending}
                  className="px-2 text-xs leading-5 text-muted-foreground hover:text-foreground disabled:opacity-50 aria-pressed:bg-foreground aria-pressed:text-background"
                  onClick={() => {
                    if (prerelease !== on)
                      setPrerelease.mutate(
                        { prerelease: on },
                        { onError: showError },
                      );
                  }}
                >
                  {translateText(
                    on ? "update.channelPrerelease" : "update.channelFull",
                  )}
                </button>
              ))}
            </div>
          }
          hint={translateText("update.channelHint")}
        />
      </UpdateGroup>

      <UpdateGroup
        label={translateText("update.source")}
        toggle={
          <button
            type="button"
            aria-expanded={advancedOpen}
            className="flex items-center gap-1 hover:text-foreground"
            onClick={() => setAdvanced(!advancedOpen)}
          >
            {translateText("update.advanced")}
            {advancedOpen ? (
              <CaretDownIcon aria-hidden="true" className="size-3" />
            ) : (
              <CaretRightIcon aria-hidden="true" className="size-3" />
            )}
          </button>
        }
      >
        {advancedOpen && (
          <>
            <UpdateRow
              label={translateText("update.upstream")}
              value={<span className="break-all">{upstream.label}</span>}
              hint={translateText(`update.upstreamFrom.${upstream.source}`)}
              action={
                // What the environment says wins, so a setting would change nothing.
                upstream.source !== "env" && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={running}
                    onClick={() => setChanging(true)}
                  >
                    {translateText("update.upstreamChange")}
                  </Button>
                )
              }
            />
            {/* Another server has its own token, and GitHub's credentials do not go there. */}
            {token.host !== null && (
              <UpdateRow
                label={translateText("update.token")}
                value={tokenNote.source}
                hint={
                  <>
                    {tokenNote.note !== null && (
                      <span className="block text-state-warning-ink">
                        {tokenNote.note}
                      </span>
                    )}
                    {translateText("update.tokenWhen")}
                  </>
                }
                action={
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setSettingToken(true)}
                  >
                    {translateText(
                      token.saved === null
                        ? "update.tokenSet"
                        : "update.tokenChange",
                    )}
                  </Button>
                }
              />
            )}
          </>
        )}
      </UpdateGroup>

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
              {remote === undefined
                ? translateText("update.confirm")
                : translateText("update.confirmRemote", { host: remote })}
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
