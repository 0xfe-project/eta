import type { Layout } from "../../components";
import type { HostAddress } from "../../services/host";
import type { ConnectionFailure } from "./diagnostics";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { cleanup, effect, platform, signal, View } from "nsh";
import {
  needsLocalHostStart,
  normalizeHostOrigin,
  useSavedHosts,
} from "../../app/saved-hosts";
import { Button, colors, grow, Header, Label, row } from "../../components";
import { CloseButton } from "../../components/navigation-buttons";
import { control, icon, opacity, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { isFlatpak } from "../../services/flatpak";
import { addressFrom, useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { ConnectionError, LostPhoneConnection } from "./connection-errors";
import { diagnose } from "./diagnostics";
import { DownloadStatus } from "./download-progress";
import { HostFields } from "./host-fields";
import {
  canStartHost,
  isDesktopPlatform,
  LocalHostError,
  localProgress,
  startLocalHost,
} from "./local-host";
import { PhoneConnectionForm } from "./phone-form";
import { SavedHostsList } from "./saved-hosts-list";
import { Scanner } from "./scanner";
import { cardWidth, ConnectionMessage, LocationOption } from "./visuals";
import { WorkspaceSkeleton } from "./workspace-skeleton";
export { WorkspaceSkeleton } from "./workspace-skeleton";

const failureText = {
  address: ["connectCannotReach", "connectCheckAddress"],
  "not-eta": ["connectWrongHost", "connectCheckPort"],
  local: ["connectStartFailed", "connectFixOrSwitch"],
  offline: ["connectDownloadOffline", "connectRetryNetwork"],
  checksum: ["connectChecksumFailure", "connectChecksumDetails"],
  lost: ["connectLostTitle", "connectAgentsContinue"],
} as const;

function shownAddress(origin?: string) {
  if (!origin) return "";
  try {
    const url = new URL(origin);
    return url.protocol === "http:" ? url.host : origin;
  } catch {
    return origin;
  }
}

export function Connection(props: {
  initial: HostAddress | null;
  layout: Layout;
  resuming: boolean;
  openingWeb?: boolean;
  flatpak?: boolean;
  choosingHost?: boolean;
  activeOrigin?: string;
  activeConnected?: boolean;
  onCancel?: () => void;
  onConnect: (address: HostAddress) => void;
}) {
  const c = colors();
  const host = useHost();
  const savedHosts = useSavedHosts();
  const inFlatpak = props.flatpak ?? isFlatpak;
  const allowLocalHost = canStartHost && !inFlatpak;
  const draft = signal(shownAddress(props.initial?.origin));
  const token = signal(props.initial?.token ?? "");
  const remote = signal(
    Boolean(props.initial?.origin) ||
      Boolean(props.choosingHost) ||
      !allowLocalHost,
  );
  const scanned = signal(false);
  const scanFailure = signal<"unavailable" | "invalid" | undefined>(undefined);
  const unavailable = () => uiText("connectScannerUnavailable");
  const starting = signal(false);
  const error = signal("");
  const problem = signal<ConnectionFailure | undefined>(
    host.paused() && !props.choosingHost ? "lost" : undefined,
  );
  const attempt = signal<HostAddress | undefined>(
    host.paused() && !props.choosingHost
      ? (host.address() ?? undefined)
      : undefined,
  );
  const phone = () => props.layout === "phone" && !isDesktopPlatform;
  const desktop = () => props.layout === "desktop" || isDesktopPlatform;
  const tablet = () => !phone() && !desktop();
  const remoteFailure = () =>
    !desktop() && ["token", "address", "not-eta"].includes(problem() ?? "");
  const remoteReason = () =>
    problem() === "token"
      ? "The token is wrong."
      : problem() === "not-eta"
        ? "That address does not belong to an Eta host."
        : "The network connection failed.";
  const scanNotice = () =>
    scanFailure() === "invalid"
      ? "That isn't an Eta connect code."
      : unavailable();
  const connecting = () =>
    props.openingWeb ||
    (!props.choosingHost &&
      !!host.address() &&
      !host.hasConnected() &&
      host.failures() === 0);
  const localBusy = () => starting() || props.resuming;
  const busy = () => connecting() || localBusy();
  const failure = () => {
    const next = problem();
    return next && next !== "token"
      ? failureText[next].map((key) => uiText(key))
      : undefined;
  };
  let generation = 0;

  effect(() => {
    if (props.initial) {
      draft.set(shownAddress(props.initial.origin));
      token.set(props.initial.token ?? "");
      remote.set(true);
    }
  });
  effect(() => {
    const next = host.address();
    if (host.failures() !== 1 || !next || host.hasConnected()) return;
    const revision = ++generation;
    void diagnose(next).then((reason) => {
      if (
        revision !== generation ||
        host.address() !== next ||
        host.hasConnected()
      )
        return;
      attempt.set(next);
      problem.set(reason);
      if (reason === "token") host.start(null);
    });
  });

  effect(() => {
    const address = attempt();
    if (problem() !== "lost" || !address) return;
    let waiting = false;
    const timer = setInterval(() => {
      if (waiting) return;
      waiting = true;
      void diagnose(address)
        .then((reason) => {
          if (reason !== "address" && problem() === "lost") begin(address);
        })
        .finally(() => {
          waiting = false;
        });
    }, 5000);
    cleanup(() => clearInterval(timer));
  });

  function begin(address: HostAddress) {
    generation++;
    error.set("");
    scanFailure.set(undefined);
    problem.set(undefined);
    attempt.set(address);
    props.onConnect(address);
  }

  function connect() {
    if (busy() || !draft().trim()) return;
    try {
      const link = parseConnectLink(draft());
      begin({
        origin: addressFrom(link?.address ?? draft()),
        token: (link ? link.token : token().trim()) || undefined,
      });
    } catch (cause) {
      error.set(problemText(cause));
    }
  }

  async function launch() {
    if (busy() || !allowLocalHost) return;
    generation++;
    host.start(null);
    error.set("");
    problem.set(undefined);
    starting.set(true);
    try {
      begin({ ...(await startLocalHost()), local: true });
    } catch (cause) {
      error.set(problemText(cause));
      const kind = cause instanceof LocalHostError ? cause.kind : "start";
      problem.set(
        kind === "checksum"
          ? "checksum"
          : kind === "offline" || kind === "interrupted"
            ? "offline"
            : "local",
      );
    } finally {
      starting.set(false);
    }
  }

  function change() {
    generation++;
    host.start(null);
    problem.set(undefined);
    error.set("");
  }

  function code(text: string) {
    scanned.set(false);
    try {
      const link = parseConnectLink(text);
      if (!link) throw new Error("Not a connect code");
      const origin = addressFrom(link.address);
      draft.set(origin);
      token.set(link.token);
      begin({ origin, token: link.token || undefined });
    } catch {
      scanFailure.set("invalid");
    }
  }

  function edit(set: (value: string) => void, value: string) {
    set(value);
    if (error()) error.set("");
    if (scanFailure()) scanFailure.set(undefined);
    if (problem() === "token") problem.set(undefined);
  }

  function retryConnection() {
    if (
      ["local", "offline", "checksum"].includes(problem() ?? "") ||
      attempt()?.local
    )
      void launch();
    else if (attempt()) begin(attempt()!);
  }

  function useAnotherHost() {
    change();
    draft.set("");
    token.set("");
  }

  const activeOrigin = () =>
    props.activeOrigin
      ? (normalizeHostOrigin(props.activeOrigin) ?? props.activeOrigin)
      : undefined;

  function connectSaved(address: HostAddress) {
    if (busy()) return;
    draft.set(shownAddress(address.origin));
    token.set(address.token ?? "");
    remote.set(true);
    if (
      needsLocalHostStart({
        address,
        activeOrigin: activeOrigin(),
        activeOpen: Boolean(props.activeConnected),
        canStartHost: allowLocalHost,
      })
    ) {
      void launch();
      return;
    }
    begin(address);
  }

  const savedSection = (boxed: boolean) => (
    <If when={savedHosts.hosts().length}>
      <If
        when={boxed}
        else={
          <View style={{ paddingBottom: space[16] }}>
            <Label
              variant="caption"
              tone="muted"
              tracking="caps"
              style={{
                paddingHorizontal: space[16],
                paddingTop: space[12],
                paddingBottom: space[8],
              }}
            >
              {uiText("savedHosts")}
            </Label>
            <SavedHostsList
              hosts={savedHosts.hosts()}
              activeOrigin={props.activeOrigin}
              activeConnected={props.activeConnected}
              phone
              busy={Boolean(busy())}
              onConnect={connectSaved}
              onRename={(origin, name) => savedHosts.rename(origin, name)}
              onRemove={(origin) => savedHosts.remove(origin)}
            />
          </View>
        }
      >
        <SavedHostsList
          hosts={savedHosts.hosts()}
          activeOrigin={props.activeOrigin}
          activeConnected={props.activeConnected}
          phone={false}
          boxed
          busy={Boolean(busy())}
          onConnect={connectSaved}
          onRename={(origin, name) => savedHosts.rename(origin, name)}
          onRemove={(origin) => savedHosts.remove(origin)}
        />
      </If>
    </If>
  );

  const scanLabel = "Scan the code on your computer";
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If when={!phone()}>
        <WorkspaceSkeleton layout={props.layout} backdrop />
      </If>
      <View
        style={{
          ...grow,
          justifyContent: phone() ? "flex-start" : "center",
          alignItems: "center",
          padding: phone() ? 0 : space[24],
        }}
      >
        <If when={failure() && !phone() && !remoteFailure()}>
          <ConnectionError
            layout={props.layout}
            tablet={tablet()}
            message={failure()!}
            problem={problem()}
            address={attempt()}
            error={error()}
            lastOnline={host.lastOnline()}
            onRetry={retryConnection}
            onChange={
              tablet() && problem() === "lost" ? useAnotherHost : change
            }
          />
        </If>
        <If when={phone() && problem() === "lost"}>
          <LostPhoneConnection
            address={attempt()}
            lastOnline={host.lastOnline()}
            onRetry={retryConnection}
            onChange={useAnotherHost}
          />
        </If>
        <If when={localProgress()}>
          <DownloadStatus layout={props.layout} />
        </If>
        <If
          when={
            !localProgress() &&
            (!failure() || remoteFailure() || (phone() && problem() !== "lost"))
          }
        >
          <View
            style={{
              width: "100%",
              ...(phone()
                ? grow
                : {
                    maxWidth: cardWidth,
                    borderWidth: 1,
                    borderColor: c().strong,
                  }),
              backgroundColor: c().canvas,
            }}
          >
            <If when={desktop()}>
              <Header
                title={
                  props.onCancel
                    ? uiText("switchHost")
                    : uiText("whereShouldEtaRun")
                }
                layout={props.layout}
                inset={space[16]}
                end={space[12]}
                dialog
              >
                <If when={props.onCancel}>
                  <View style={grow} />
                  <CloseButton
                    size={control.sm}
                    iconSize={icon.md}
                    style={{ paddingHorizontal: 0 }}
                    onPress={props.onCancel!}
                  />
                </If>
              </Header>
            </If>
            <If when={tablet()}>
              <Header
                title={
                  remoteFailure()
                    ? uiText("cantReachThisHost")
                    : props.onCancel
                      ? uiText("switchHost")
                      : uiText("connectToOneHostReachEvery")
                }
                layout={props.layout}
                inset={space[16]}
                end={space[12]}
                dialog
              >
                <If when={props.onCancel}>
                  <View style={grow} />
                  <CloseButton
                    size={control.sm}
                    iconSize={icon.md}
                    style={{ paddingHorizontal: 0 }}
                    onPress={props.onCancel!}
                  />
                </If>
              </Header>
            </If>
            <If when={phone()}>
              <PhoneConnectionForm
                saved={savedSection(false)}
                address={draft()}
                remoteFailure={remoteFailure()}
                remoteReason={remoteReason()}
                connecting={Boolean(connecting())}
                busy={Boolean(busy())}
                scanFailure={Boolean(scanFailure())}
                scanNotice={scanNotice()}
                scanLabel={scanLabel}
                error={error()}
                onCancel={props.onCancel}
                onConnect={connect}
                onDismissScan={() => scanFailure.set(undefined)}
                onScan={scan}
              >
                <HostFields
                  plain
                  address={draft()}
                  token={token()}
                  onAddress={(value) => edit(draft.set, value)}
                  onToken={(value) => edit(token.set, value)}
                  onSubmit={connect}
                />
              </PhoneConnectionForm>
            </If>
            <If when={!phone()}>
              <View
                style={{
                  padding: space[16],
                  gap: tablet() ? space[16] : space[12],
                }}
              >
                {savedSection(true)}
                <If
                  when={desktop()}
                  else={
                    <Label tone="mutedInk">
                      {remoteFailure()
                        ? remoteReason()
                        : uiText("thePhoneIsOnlyAScreen")}
                    </Label>
                  }
                >
                  <View style={{ gap: space[8] }}>
                    <LocationOption
                      title={
                        localBusy()
                          ? uiText("starting")
                          : uiText("runOnThisComputer")
                      }
                      description={
                        inFlatpak
                          ? uiText("flatpakLocalHostUnavailable")
                          : uiText("theHostAndItsDataStay")
                      }
                      selected={false}
                      disabled={!allowLocalHost || busy()}
                      onPress={() => void launch()}
                    />
                    <LocationOption
                      title={uiText("connectToAnExistingHost")}
                      description={uiText("thisComputerIsOnlyAScreen")}
                      selected={remote() && !localBusy()}
                      disabled={busy()}
                      onPress={() => remote.set(true)}
                    />
                  </View>
                </If>
                <If when={remote() || !desktop()}>
                  <HostFields
                    address={draft()}
                    token={token()}
                    tablet={tablet()}
                    tokenWrong={tablet() && problem() === "token"}
                    onAddress={(value) => edit(draft.set, value)}
                    onToken={(value) => edit(token.set, value)}
                    onSubmit={connect}
                  />
                  <ConnectionMessage
                    error={
                      error() ||
                      (desktop() && problem() === "token"
                        ? "The token is wrong"
                        : "")
                    }
                    detail={
                      desktop() && problem() === "token"
                        ? uiText("getANewLinkFromThe")
                        : undefined
                    }
                  />
                </If>
              </View>
              <View
                style={{
                  ...row,
                  justifyContent: "space-between",
                  borderTopWidth: 1,
                  borderColor: c().border,
                  gap: tablet() ? space[8] : space[12],
                  padding: space[12],
                  paddingHorizontal: space[16],
                }}
              >
                <If when={tablet() && !remoteFailure()}>
                  <Button
                    label={scanLabel}
                    size={control.touch}
                    labelVariant="body"
                    style={{ flex: 1, paddingHorizontal: space[12] }}
                    onPress={scan}
                    disabled={busy()}
                    dimDisabled={false}
                  />
                </If>
                <If when={desktop()}>
                  <Label variant="small" tone="muted" style={{ flex: 1 }}>
                    {inFlatpak
                      ? uiText("flatpakLocalHostFooter")
                      : uiText("theTwoKeepSeparateDataSwitching")}
                  </Label>
                </If>
                <If when={tablet() && remoteFailure()}>
                  <View style={{ flex: 1 }} />
                </If>
                <View style={{ ...row, gap: space[8] }}>
                  <If when={props.onCancel}>
                    <Button
                      label={uiText("cancel")}
                      size={tablet() ? control.touch : undefined}
                      style={{ paddingHorizontal: space[12] }}
                      onPress={props.onCancel!}
                    />
                  </If>
                  <If when={remote() || !desktop()}>
                    <Button
                      label={
                        remoteFailure() ? uiText("retry") : uiText("connect")
                      }
                      tone="primary"
                      size={tablet() ? control.touch : undefined}
                      style={
                        tablet()
                          ? {
                              paddingHorizontal: space[24],
                              opacity:
                                !draft().trim() || localBusy()
                                  ? opacity.disabled
                                  : 1,
                            }
                          : { paddingHorizontal: space[12] }
                      }
                      disabled={!draft().trim() || localBusy()}
                      busy={connecting()}
                      onPress={connect}
                    />
                  </If>
                </View>
              </View>
            </If>
          </View>
        </If>
      </View>
      <If when={scanned()}>
        <Scanner
          onCode={code}
          onClose={() => scanned.set(false)}
          onUnavailable={() => {
            scanned.set(false);
            reportUnavailable();
          }}
        />
      </If>
    </View>
  );

  function scan() {
    error.set("");
    scanFailure.set(undefined);
    if (platform.os === "web") {
      reportUnavailable();
      return;
    }
    scanned.set(true);
  }

  function reportUnavailable() {
    if (phone()) scanFailure.set("unavailable");
    else error.set(unavailable());
  }
}
