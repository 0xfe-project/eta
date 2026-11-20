import type { HostAddress } from "./host";
import type { Layout } from "./ui";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { effect, Image, platform, Scroll, signal, View } from "nsh";
import photo from "./assets/onboard.jpg";
import { addressFrom, useHost } from "./host";
import {
  canStartHost,
  LocalHostError,
  localProgress,
  startLocalHost,
} from "./local-host";
import { uiText } from "./locale";
import { Scanner } from "./scanner";
import {
  Button,
  colors,
  Field,
  fill,
  grow,
  Header,
  Icon,
  Label,
  row,
  sizes,
} from "./ui";

type Failure =
  | "token"
  | "address"
  | "not-eta"
  | "local"
  | "offline"
  | "checksum"
  | "lost";

async function diagnose(address: HostAddress): Promise<Failure> {
  const timeout = AbortSignal.timeout(3500);
  try {
    const up = await fetch(`${address.origin}/up`, {
      signal: timeout,
      redirect: "error",
    });
    if (!up.ok || (await up.text()).trim() !== "ok") return "not-eta";
    const reply = await fetch(`${address.origin}/ws`, {
      headers: address.token
        ? { Authorization: `Bearer ${address.token}` }
        : {},
      signal: timeout,
      redirect: "error",
    });
    return reply.status === 401 ? "token" : "not-eta";
  } catch {
    return "address";
  }
}

const failureText = {
  address: ["connectCannotReach", "connectCheckAddress"],
  "not-eta": ["connectWrongHost", "connectCheckPort"],
  local: ["connectStartFailed", "connectFixOrSwitch"],
  offline: ["connectDownloadOffline", "connectRetryNetwork"],
  checksum: ["connectChecksumFailure", "connectChecksumDetails"],
  lost: ["connectLostTitle", "connectAgentsContinue"],
} as const;

export function Connection(props: {
  initial: HostAddress | null;
  layout: Layout;
  resuming: boolean;
  openingWeb?: boolean;
  onConnect: (address: HostAddress) => void;
}) {
  const c = colors();
  const host = useHost();
  const draft = signal(props.initial?.origin ?? "");
  const token = signal(props.initial?.token ?? "");
  const remote = signal(Boolean(props.initial?.origin) || !canStartHost);
  const scanned = signal(false);
  const scanFailure = signal<"unavailable" | "invalid" | undefined>(undefined);
  const unavailable = () => uiText("connectScannerUnavailable");
  const starting = signal(false);
  const error = signal("");
  const problem = signal<Failure | undefined>(
    host.paused() ? "lost" : undefined,
  );
  const attempt = signal<HostAddress | undefined>(
    host.paused() ? (host.address() ?? undefined) : undefined,
  );
  const phone = () => props.layout === "phone" && !canStartHost;
  const desktop = () => props.layout === "desktop" || canStartHost;
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
    props.openingWeb || (!!host.address() && host.failures() === 0);
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
      draft.set(props.initial.origin);
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
      error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function launch() {
    if (busy() || !canStartHost) return;
    generation++;
    host.start(null);
    error.set("");
    problem.set(undefined);
    starting.set(true);
    try {
      begin({ ...(await startLocalHost()), local: true });
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
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
          padding: phone() ? 0 : 24,
        }}
      >
        <If when={failure() && !phone() && !remoteFailure()}>
          <View
            style={{
              width: "100%",
              maxWidth: 480,
              borderWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
            }}
          >
            <Header
              title={failure()![0]}
              layout={props.layout}
              inset={16}
              dialog
            />
            <View style={{ padding: 16, gap: 12 }}>
              <If
                when={
                  (problem() === "address" ||
                    problem() === "not-eta" ||
                    problem() === "lost") &&
                  attempt()
                }
              >
                <Label>{attempt()?.origin}</Label>
              </If>
              <Label size={14} line={20} tone="mutedInk">
                {failure()![1]}
              </Label>
              <If when={problem() === "local" && error()}>
                <Label size={12} line={16} tone="red">
                  {error()}
                </Label>
              </If>
            </View>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                borderTopWidth: 1,
                borderColor: c().border,
                gap: 8,
                padding: 12,
                paddingHorizontal: 16,
              }}
            >
              <Button
                label={uiText("retry")}
                tone="primary"
                size={24}
                style={{ paddingHorizontal: 12 }}
                onPress={() => {
                  if (
                    ["local", "offline", "checksum"].includes(problem() ?? "")
                  )
                    void launch();
                  else if (attempt()?.local) void launch();
                  else if (attempt()) begin(attempt()!);
                }}
              />
              <Button
                label={uiText("changeConnection")}
                size={24}
                style={{ paddingHorizontal: 12 }}
                onPress={change}
              />
            </View>
          </View>
        </If>
        <If when={phone() && problem() === "lost"}>
          <View style={{ ...grow, width: "100%" }}>
            <View
              style={{
                ...grow,
                justifyContent: "flex-end",
                gap: 8,
                paddingHorizontal: 16,
                paddingBottom: 32,
              }}
            >
              <Label size={64} line={64} style={{ letterSpacing: -1.28 }}>
                ETA
              </Label>
              <Label size={24} line={32}>
                {uiText("lostTheConnectionToTheHost")}
              </Label>
              <Label tone="muted">
                {attempt()?.origin ? new URL(attempt()!.origin).host : ""}
                {host.lastOnline()
                  ? uiText("lastOnline", {
                      toLocaleTimeString: new Date(
                        host.lastOnline()!,
                      ).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    })
                  : ""}
              </Label>
              <Label tone="muted">{uiText("agentsKeepRunningOnTheHost")}</Label>
            </View>
            <View
              style={{
                paddingHorizontal: 16,
                paddingTop: 8,
                paddingBottom: 34,
                gap: 8,
              }}
            >
              <Button
                label={uiText("retry")}
                tone="primary"
                size={52}
                labelSize={14}
                onPress={() => {
                  if (attempt()?.local) void launch();
                  else if (attempt()) begin(attempt()!);
                }}
              />
              <Button
                label={uiText("useAnotherHost")}
                size={52}
                labelSize={14}
                onPress={() => {
                  change();
                  draft.set("");
                  token.set("");
                }}
              />
            </View>
          </View>
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
                : { maxWidth: 480, borderWidth: 1, borderColor: c().strong }),
              backgroundColor: c().canvas,
            }}
          >
            <If when={desktop()}>
              <Header
                title={uiText("whereShouldEtaRun")}
                layout={props.layout}
                inset={16}
                dialog
              />
            </If>
            <If when={tablet()}>
              <Header
                title={
                  remoteFailure()
                    ? uiText("cantReachThisHost")
                    : uiText("connectToOneHostReachEvery")
                }
                layout={props.layout}
                inset={16}
                dialog
              />
            </If>
            <If when={phone()}>
              <Scroll style={grow} contentStyle={{ flexGrow: 1 }}>
                <PhoneHero />
                <View
                  style={{
                    flexGrow: 1,
                    minHeight: 190,
                    justifyContent: "flex-end",
                    paddingHorizontal: 16,
                    paddingBottom: 24,
                    paddingTop: 16,
                    gap: 12,
                  }}
                >
                  <If
                    when={remoteFailure()}
                    else={
                      <>
                        <Label
                          size={64}
                          line={64}
                          style={{ letterSpacing: -1.28 }}
                        >
                          ETA
                        </Label>
                        <ConnectionIntro phone />
                      </>
                    }
                  >
                    <Label size={24} line={31}>
                      {uiText("cantReachThisHost")}
                    </Label>
                    <Label size={14} tone="mutedInk">
                      {remoteReason()}
                    </Label>
                  </If>
                </View>
                <View>
                  {fields(true)}
                  <ConnectionMessage error={error()} />
                  <View
                    style={{
                      paddingHorizontal: 16,
                      paddingTop: 16,
                      paddingBottom: 34,
                      gap: 8,
                    }}
                  >
                    <View style={{ position: "relative" }}>
                      <Button
                        label={
                          connecting()
                            ? uiText("connecting")
                            : remoteFailure()
                              ? uiText("retry")
                              : uiText("connect")
                        }
                        tone="primary"
                        size={52}
                        labelSize={14}
                        dimDisabled={connecting()}
                        disabled={busy() || !draft().trim()}
                        onPress={connect}
                      />
                      <If when={scanFailure() && !remoteFailure()}>
                        <View
                          role="alert"
                          onPress={() => scanFailure.set(undefined)}
                          style={{
                            ...fill,
                            ...row,
                            paddingHorizontal: 12,
                            backgroundColor: c().button,
                          }}
                        >
                          <Label
                            size={14}
                            tone="buttonInk"
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            {scanNotice()}
                          </Label>
                        </View>
                      </If>
                    </View>
                    <If when={!remoteFailure()}>
                      <Button
                        label={scanLabel}
                        size={52}
                        labelSize={14}
                        disabled={busy()}
                        onPress={scan}
                      />
                    </If>
                  </View>
                </View>
              </Scroll>
            </If>
            <If when={!phone()}>
              <View style={{ padding: 16, gap: 12 }}>
                <If
                  when={desktop()}
                  else={
                    <Label size={14} line={20} tone="mutedInk">
                      {remoteFailure()
                        ? remoteReason()
                        : uiText("thePhoneIsOnlyAScreen")}
                    </Label>
                  }
                >
                  <View style={{ gap: 8 }}>
                    <LocationOption
                      title={
                        localBusy()
                          ? uiText("starting")
                          : uiText("runOnThisComputer")
                      }
                      description={uiText("theHostAndItsDataStay")}
                      selected={localBusy()}
                      disabled={!canStartHost || busy()}
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
                  {fields(false)}
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
                  gap: 12,
                  padding: 12,
                  paddingHorizontal: 16,
                }}
              >
                <If when={tablet() && !remoteFailure()}>
                  <Button
                    label={scanLabel}
                    size={44}
                    style={{ flex: 1 }}
                    onPress={scan}
                    disabled={busy()}
                  />
                </If>
                <If when={desktop()}>
                  <Label size={12} line={16} tone="muted" style={{ flex: 1 }}>
                    {uiText("theTwoKeepSeparateDataSwitching")}
                  </Label>
                </If>
                <If when={tablet() && remoteFailure()}>
                  <View style={{ flex: 1 }} />
                </If>
                <If when={remote() || !desktop()}>
                  <Button
                    label={
                      connecting()
                        ? uiText("connecting")
                        : remoteFailure() || problem() === "token"
                          ? uiText("retry")
                          : uiText("connect")
                    }
                    tone="primary"
                    size={tablet() ? 44 : undefined}
                    style={tablet() ? { paddingHorizontal: 24 } : undefined}
                    disabled={!draft().trim() || busy()}
                    onPress={connect}
                  />
                </If>
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

  function fields(plain: boolean) {
    const fieldStyle = () =>
      plain
        ? {
            flex: 1,
            height: 54,
            borderWidth: 0,
            paddingHorizontal: 0,
            fontSize: 16,
          }
        : { flex: 1, height: tablet() ? 44 : 32, fontSize: tablet() ? 16 : 14 };
    const line = () =>
      plain
        ? {
            ...row,
            height: 56,
            paddingHorizontal: 16,
            gap: 16,
            borderBottomWidth: 1,
            borderColor: c().border,
          }
        : { ...row, gap: 8 };
    return (
      <View
        style={{
          gap: plain ? 0 : 8,
          borderTopWidth: plain ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <View style={line()}>
          <Label
            size={plain ? 11 : 14}
            tone="muted"
            style={{ width: plain ? 44 : 64 }}
          >
            {uiText("address")}
          </Label>
          <Field
            label={uiText("hostAddress")}
            placeholder={uiText("hostAddressOrEtaLink")}
            value={draft()}
            onChange={(value) => edit(draft.set, value)}
            onSubmit={connect}
            style={fieldStyle()}
          />
        </View>
        <View style={line()}>
          <Label
            size={plain ? 11 : 14}
            tone="muted"
            style={{ width: plain ? 44 : 64 }}
          >
            {uiText("token")}
          </Label>
          <Field
            label={uiText("hostToken")}
            placeholder={uiText("accessToken")}
            value={token()}
            masked
            onChange={(value) => edit(token.set, value)}
            onSubmit={connect}
            style={fieldStyle()}
          />
        </View>
      </View>
    );
  }
}

function DownloadStatus(props: { layout: Layout }) {
  const c = colors();
  const stats = () => localProgress();
  const mb = (size: number) => Math.round(size / (1024 * 1024));
  const percent = () =>
    stats()?.total
      ? Math.max(
          0,
          Math.min(100, ((stats()!.received ?? 0) / stats()!.total!) * 100),
        )
      : 0;
  return (
    <View
      style={{
        width: "100%",
        maxWidth: 480,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
    >
      <Header
        title={uiText("downloadingTheHost")}
        layout={props.layout}
        inset={16}
        dialog
      />
      <View style={{ padding: 16, gap: 12 }}>
        <Label size={14} line={20} tone="mutedInk">
          {stats()?.version
            ? `eta-host ${stats()!.version}`
            : uiText("findingARelease")}
        </Label>
        <View
          style={{ height: 4, backgroundColor: c().border }}
          accessibilityLabel={uiText("downloadProgress")}
        >
          <View
            style={{
              width: `${percent()}%`,
              height: 4,
              backgroundColor: c().ink,
            }}
          />
        </View>
        <If when={stats()?.total}>
          <Label size={12} line={16} tone="muted">
            {`${mb(stats()!.received ?? 0)} / ${mb(stats()!.total!)} MB`}
          </Label>
        </If>
        <Label size={12} line={16} tone="muted">
          {uiText("onlyTheFirstTimeAfterThis")}
        </Label>
      </View>
    </View>
  );
}

function ConnectionIntro(props: { phone: boolean }) {
  return (
    <View style={{ gap: props.phone ? 12 : 6 }}>
      <Label size={18} line={26}>
        {uiText("connectToOneHostReachEvery")}
      </Label>
      <Label size={12} line={18} tone="muted">
        {uiText("thePhoneIsOnlyAScreen")}
      </Label>
    </View>
  );
}

function ConnectionMessage(props: { error: string; detail?: string }) {
  const c = colors();
  return (
    <If when={props.error}>
      <View
        style={{
          gap: 3,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderLeftWidth: 2,
          borderColor: c().red,
          backgroundColor: c().redFill,
        }}
      >
        <Label size={12} line={16} tone="red">
          {props.error}
        </Label>
        <If when={props.detail}>
          <Label size={12} line={16} tone="mutedInk">
            {props.detail}
          </Label>
        </If>
      </View>
    </If>
  );
}

function LocationOption(props: {
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      accessibilityState={{
        disabled: props.disabled,
        selected: props.selected,
      }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      hoverStyle={props.disabled ? undefined : { backgroundColor: c().surface }}
      style={{
        borderColor: props.selected && !props.disabled ? c().ink : c().strong,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2,
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      <Label>{props.title}</Label>
      <Label size={12} line={16} tone="muted">
        {props.description}
      </Label>
    </View>
  );
}

function PhoneHero() {
  return (
    <View
      style={{
        height: 295,
        flexShrink: 0,
        justifyContent: "flex-end",
        padding: 16,
        gap: 8,
      }}
    >
      <Image
        src={photo}
        fadeDuration={0}
        style={{
          ...fill,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "50% 30%",
        }}
      />
      <View
        style={{
          ...fill,
          backgroundImage:
            "linear-gradient(0deg, #000000c7 0%, #00000080 40%, #00000000 70%)",
        }}
      />
      <View
        style={{
          ...fill,
          backgroundImage:
            "linear-gradient(180deg, #00000099 0%, #00000040 14%, #00000000 28%)",
        }}
      />
      <Label
        size={30}
        line={34}
        weight={600}
        style={{ color: "#ffffff", maxWidth: 320, letterSpacing: -0.9 }}
      >
        {uiText("yourMachinesInYourPocket")}
      </Label>
      <Label size={10} line={12} style={{ color: "#ffffffbf" }}>
        Photo: Barnabas Davoti / Unsplash
      </Label>
    </View>
  );
}

function SkeletonBlock(props: {
  width: number | `${number}%`;
  height: number;
}) {
  const c = colors();
  return (
    <View
      style={{
        width: props.width,
        height: props.height,
        flexShrink: 0,
        backgroundColor: c().border,
      }}
    />
  );
}

function SkeletonRows(props: {
  widths: number[];
  height: number;
  compact?: boolean;
}) {
  return (
    <Each of={props.widths}>
      {(width) => (
        <View
          style={{
            ...row,
            height: props.height,
            paddingHorizontal: props.compact ? 24 : 8,
            gap: 12,
          }}
        >
          <SkeletonBlock width={14} height={14} />
          <If when={!props.compact}>
            <SkeletonBlock width={width()} height={12} />
          </If>
        </View>
      )}
    </Each>
  );
}

export function WorkspaceSkeleton(props: {
  layout: Layout;
  backdrop?: boolean;
}) {
  const c = colors();
  const desktop = () => props.layout === "desktop";
  const phone = () => props.layout === "phone";
  const bar = () => ({
    ...row,
    borderBottomWidth: 1,
    borderColor: c().border,
    flexShrink: 0,
  });
  return (
    <View
      role={props.backdrop ? undefined : "progressbar"}
      accessibilityLabel={props.backdrop ? undefined : uiText("loadingEta")}
      style={{
        ...fill,
        flexDirection: "row",
        filter: props.backdrop ? "blur(3px)" : undefined,
      }}
    >
      <If when={!phone()}>
        <View
          style={{
            width: desktop() ? sizes.sidebar : sizes.rail,
            backgroundColor: c().surface,
            borderRightWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...bar(), height: 40 }} />
          <If
            when={desktop()}
            else={
              <View style={{ gap: 4, paddingTop: 12 }}>
                <SkeletonRows
                  widths={[14, 14, 14, 14, 14]}
                  height={44}
                  compact
                />
              </View>
            }
          >
            <View
              style={{
                paddingHorizontal: 8,
                paddingTop: 8,
                paddingBottom: 4,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <SkeletonRows widths={[107, 71, 89, 119]} height={32} />
            </View>
            <View style={{ ...grow, paddingHorizontal: 8, paddingTop: 8 }}>
              <View style={{ ...bar(), height: 24, paddingHorizontal: 8 }}>
                <SkeletonBlock width={48} height={10} />
              </View>
              <SkeletonRows widths={[107, 71, 89, 119]} height={50} />
            </View>
            <View
              style={{
                paddingHorizontal: 8,
                paddingTop: 8,
                paddingBottom: 6,
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <View style={{ ...bar(), height: 24, paddingHorizontal: 8 }}>
                <SkeletonBlock width={48} height={10} />
              </View>
              <SkeletonRows widths={[107, 71]} height={36} />
            </View>
            <View
              style={{ padding: 4, borderTopWidth: 1, borderColor: c().border }}
            >
              <SkeletonRows widths={[89]} height={32} />
            </View>
          </If>
        </View>
      </If>
      <If when={!desktop() && !phone()}>
        <View
          style={{
            width: 320,
            borderRightWidth: 1,
            borderColor: c().border,
            padding: 12,
          }}
        >
          <SkeletonRows widths={[108, 84, 118, 102, 129]} height={46} />
        </View>
      </If>
      <View style={grow}>
        <View style={{ ...bar(), height: 40, paddingHorizontal: 16 }}>
          <SkeletonBlock width={96} height={12} />
        </View>
        <View style={{ paddingTop: 24, paddingHorizontal: 24 }}>
          <Each of={phone() ? [0, 1, 2] : [0, 1]}>
            {(width) => (
              <>
                <View style={{ gap: 10, marginBottom: 28 }}>
                  <View style={{ ...row, gap: 8 }}>
                    <SkeletonBlock width={18} height={18} />
                    <SkeletonBlock width={96} height={12} />
                  </View>
                  <View style={{ gap: 8, paddingHorizontal: 2 }}>
                    <SkeletonBlock width="97%" height={12} />
                    <SkeletonBlock
                      width={
                        phone()
                          ? (["60%", "66%", "46%"] as const)[width()]!
                          : [408, 272][width()]!
                      }
                      height={12}
                    />
                  </View>
                </View>
                <View style={{ alignItems: "flex-end", marginBottom: 28 }}>
                  <SkeletonBlock width={phone() ? "40%" : 288} height={36} />
                </View>
              </>
            )}
          </Each>
        </View>
        <If
          when={!phone()}
          else={
            <View
              style={{
                ...row,
                marginTop: "auto",
                height: sizes.phoneNav,
                borderTopWidth: 1,
                borderColor: c().border,
                justifyContent: "space-around",
              }}
            >
              <Each of={["chat", "bell", "context", "tasks", "more"] as const}>
                {(icon) => <Icon name={icon()} size={20} tone="muted" />}
              </Each>
            </View>
          }
        >
          <View
            style={{
              marginTop: "auto",
              marginBottom: 14,
              marginHorizontal: 16,
              height: 83,
              borderWidth: 1,
              borderColor: c().border,
            }}
          />
        </If>
      </View>
      <If when={desktop()}>
        <View
          style={{
            width: sizes.panel,
            backgroundColor: c().surface,
            borderLeftWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...bar(), height: 40 }} />
        </View>
      </If>
      <If when={props.backdrop}>
        <View style={{ ...fill, backgroundColor: c().shade }} />
      </If>
    </View>
  );
}
