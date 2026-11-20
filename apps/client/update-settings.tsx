import type {
  UpgradeArgs,
  UpgradeBusy,
  UpgradeCheckView,
  UpgradePhase,
  UpgradeResults,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { AppUpdate, UpdateProgress } from "nsh/updater";
import type { Layout } from "./ui";
import { appInfo, cleanup, effect, openUrl, Scroll, signal, View } from "nsh";
import { Select } from "nsh/base";
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";
import { useHost } from "./host";
import { canStartHost } from "./local-host";
import { uiText } from "./locale";
import {
  Button,
  colors,
  Field,
  grow,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
} from "./ui";

const phaseName = {
  starting: "updatePreparing",
  downloading: "updateDownloading",
  waiting: "updateWaiting",
  stopping: "updateStopping",
  "backing-up": "updateBackingUp",
  restarting: "updateRestarting",
  verifying: "updateVerifying",
  "rolling-back": "restoringThePreviousVersion",
} as const satisfies Record<UpgradePhase, Parameters<typeof uiText>[0]>;

const blockedExplanation = {
  source: "updateCheckout",
  "no-service": "updateNeedsService",
  "no-windows-service": "updateNeedsWindowsService",
  "other-file": "updateDifferentBinary",
} as const;

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function busyLabels(work: readonly UpgradeBusy[]) {
  return [
    ...new Set(
      work.map(({ name, number, kind }) =>
        kind === "task"
          ? uiText("busyTaskUpdate", {
              number: number === undefined ? "" : ` #${number}`,
              name,
            })
          : uiText(
              kind === "routine" ? "busyRoutineUpdate" : "busyReplyUpdate",
              { name },
            ),
      ),
    ),
  ];
}

function BusyList(props: { work: readonly UpgradeBusy[]; label: string }) {
  return (
    <If when={props.work.length > 0}>
      <View style={{ gap: 1 }}>
        <Label size={12} line={17}>
          {props.label}
        </Label>
        <Each of={busyLabels(props.work)} key={(label) => label}>
          {(label) => (
            <Label
              size={12}
              line={17}
              tone="muted"
              style={{ paddingLeft: 16 }}
            >{`• ${label()}`}</Label>
          )}
        </Each>
      </View>
    </If>
  );
}

function GroupHeading(props: {
  title: string;
  phone?: boolean;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 16,
        minHeight: props.phone ? 45 : 41,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label size={14} line={20} weight={600}>
        {props.title}
      </Label>
      {props.children}
    </View>
  );
}

function SettingBand(props: {
  title: string;
  detail: string;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        justifyContent: "space-between",
        gap: 8,
        minHeight: 55,
        paddingHorizontal: 16,
        paddingVertical: 7,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label size={14} line={20}>
          {props.title}
        </Label>
        <Label size={12} line={16} tone="muted">
          {props.detail}
        </Label>
      </View>
      {props.children}
    </View>
  );
}

function percent(received: number, total?: number) {
  return total && total > 0
    ? Math.max(0, Math.min(100, Math.round((100 * received) / total)))
    : undefined;
}

function ProgressLine(props: { value: number | undefined }) {
  const c = colors();
  return (
    <If when={props.value !== undefined}>
      <View
        role="progressbar"
        accessibilityLabel={uiText("downloadProgress")}
        accessibilityValue={{ min: 0, max: 100, now: props.value }}
        style={{ height: 4, backgroundColor: c().selected }}
      >
        <View
          style={{
            height: 4,
            width: `${props.value ?? 0}%`,
            backgroundColor: c().blue,
          }}
        />
      </View>
    </If>
  );
}

export function UpdateSettings(props: {
  onConnect: () => void;
  layout: Layout;
}) {
  const host = useHost();
  const c = colors();
  const check = host.upgradeCheck;
  const pending = signal("");
  const error = signal("");
  const checkedAt = signal(0);
  const checkClock = signal(Date.now());
  const advanced = signal<boolean>();
  const notes = signal(false);
  const confirm = signal(false);
  const editor = signal<"upstream" | "token">();
  const draft = signal("");
  const status = host.upgrade;
  const phone = () => props.layout === "phone";
  const connected = () => host.state().status === "open";
  const active = () => status()?.state === "running";
  const editable = () => connected() && !pending() && !active();
  const canRead = () => connected() && host.can("upgrade.check");
  const failed = () =>
    ["failed", "rolled-back", "broken", "lost"].includes(status()?.state ?? "");
  const version = () =>
    status()?.state === "done"
      ? (status()?.to ?? check()?.version)
      : check()?.version;
  const offer = () =>
    !!check()?.available && !!check()?.latest && check()?.latest !== version();
  const token = () => check()?.token;
  const source = () => check()?.upstream;
  const advancedOpen = () =>
    advanced() ??
    ((!!source() && source()!.source !== "build") || !!check()?.error);
  const channelName = () =>
    check()?.prerelease
      ? uiText("updatePreReleases")
      : uiText("updateFullReleases");
  const sourceKind = () =>
    source()?.source === "env"
      ? uiText("updateEnvironment")
      : source()?.source === "setting"
        ? uiText("updateSettingsSource")
        : uiText("updateDefaultSource");
  const tokenKind = () =>
    token()?.from === "Settings"
      ? uiText("updateTokenSaved")
      : token()?.from === "gh"
        ? "GitHub CLI"
        : (token()?.from ?? uiText("updateNoToken"));
  const tokenHint = () => {
    const credential = token();
    if (!credential?.saved || credential.from === "Settings")
      return uiText("updatePrivateTokenHint");
    return credential.saved !== credential.host
      ? uiText("updateTokenOtherHost", { host: credential.saved })
      : uiText("updateTokenPriority", {
          source: credential.from ?? uiText("updateTokenEnvironment"),
        });
  };
  const checkedLabel = () => {
    const minutes = Math.floor(
      Math.max(0, checkClock() - checkedAt()) / 60_000,
    );
    if (minutes < 1) return uiText("updateCheckedJustNow");
    if (minutes < 60) return uiText("updateCheckedMinutes", { minutes });
    return uiText("updateCheckedHours", { hours: Math.floor(minutes / 60) });
  };

  async function read() {
    await host.checkUpgrade();
    const now = Date.now();
    checkedAt.set(now);
    checkClock.set(now);
  }

  async function refresh() {
    if (!canRead() || pending()) return;
    error.set("");
    pending.set("check");
    try {
      await read();
    } catch (problem) {
      error.set(describeError(problem));
    } finally {
      pending.set("");
    }
  }

  async function save<A extends "setPrerelease" | "setUpstream" | "setToken">(
    action: A,
    args: UpgradeArgs[A],
  ) {
    if (!editable() || !host.can(`upgrade.${action}`)) return;
    error.set("");
    pending.set(action);
    try {
      await host.call<UpgradeResults[A]>("upgrade", action, args);
      editor.set(undefined);
      draft.set("");
      notes.set(false);
      await read();
    } catch (problem) {
      error.set(describeError(problem));
    } finally {
      pending.set("");
    }
  }

  async function request<A extends "start" | "cancel">(
    action: A,
    args: UpgradeArgs[A],
  ) {
    if (!connected() || pending()) return;
    error.set("");
    pending.set(action);
    try {
      await host.call<UpgradeResults[A]>("upgrade", action, args);
      confirm.set(false);
    } catch (problem) {
      error.set(describeError(problem));
    } finally {
      pending.set("");
      host.refreshUpgrade();
    }
  }

  let checked = false;
  let completed = "";
  effect(() => {
    if (!canRead() || pending()) return;
    const state = status();
    const newCompletion = state?.state === "done" && state.id !== completed;
    if (checked && !newCompletion) return;
    if (state?.state === "done") completed = state.id;
    checked = true;
    void refresh();
  });
  const clock = setInterval(() => checkClock.set(Date.now()), 30_000);
  cleanup(() => clearInterval(clock));

  function edit(mode: "upstream" | "token") {
    error.set("");
    draft.set(mode === "upstream" ? (source()?.saved ?? "") : "");
    editor.set(mode);
  }

  function closeEditor() {
    if (pending()) return;
    editor.set(undefined);
    error.set("");
    draft.set("");
  }

  const desktopTitle = () => {
    const address = host.address();
    if (address?.local) return uiText("updateLocalHost");
    return canStartHost && address
      ? `eta host · ${address.origin}`
      : uiText("updateServerHost");
  };
  const statusTone = () => {
    if (active()) return "blue";
    if (failed() || check()?.error) return "red";
    if (offer()) return "blue";
    if (check()?.blocked || check()?.heldOnPrerelease) return "amber";
    return "green";
  };
  const statusLabel = () => {
    if (active()) return uiText(phaseName[status()!.phase]);
    if (failed()) return uiText("updateLastFailed");
    if (check()?.error) return uiText("updateCheckFailed");
    if (offer()) return uiText("updateAvailable");
    if (check()?.heldOnPrerelease) return uiText("updatePreRelease");
    if (check()?.blocked) return uiText("updateManual");
    return uiText("updateUpToDate");
  };
  const phase = () => status()?.phase;
  const canCancel = () =>
    host.can("upgrade.cancel") &&
    ["starting", "downloading", "waiting"].includes(phase() ?? "");
  const canUpdate = () =>
    host.can("upgrade.start") && editable() && !check()?.blocked && offer();
  const offerLabel = () =>
    uiText("updateToVersion", { version: check()?.latest ?? "" });
  const note = () => check()?.notes;
  const progress = () => status()?.download;
  const updateAction = () => (
    <If
      when={active()}
      else={
        <If when={offer()}>
          <Button
            label={offerLabel()}
            disabled={!canUpdate()}
            onPress={() => {
              error.set("");
              confirm.set(true);
            }}
          />
        </If>
      }
    >
      <If when={canCancel()}>
        <Button
          label={uiText("cancelUpdate")}
          disabled={!connected() || !!pending()}
          onPress={() => void request("cancel", {})}
        />
      </If>
    </If>
  );
  return (
    <View style={grow}>
      <GroupHeading title={uiText("update")} phone={phone()}>
        <View style={{ ...row, gap: 10 }}>
          <If when={checkedAt()}>
            <Label size={12} tone="muted">
              {checkedLabel()}
            </Label>
          </If>
          <Button
            label={
              pending() === "check"
                ? uiText("checking")
                : checkedAt()
                  ? uiText("checkAgain")
                  : uiText("checkForUpdates")
            }
            size={phone() ? 28 : 24}
            disabled={!canRead() || !!pending() || active()}
            onPress={() => void refresh()}
          />
        </View>
      </GroupHeading>
      <Scroll style={grow} scrollbar={false}>
        <If
          when={check()}
          else={
            <View style={{ padding: 16, gap: 8 }}>
              <Label size={12} tone="muted">
                {!connected()
                  ? uiText("reconnectToCheckForUpdates")
                  : !host.can("upgrade.check")
                    ? uiText("updatesAreUnavailableForThisHost")
                    : pending()
                      ? uiText("checkingForUpdates")
                      : uiText("updateInformationUnavailable")}
              </Label>
              <If when={error()}>
                <Label size={12} tone="red">
                  {error()}
                </Label>
              </If>
              <If when={!connected() || !host.can("upgrade.check")}>
                <Button
                  label={uiText("changeHost")}
                  onPress={props.onConnect}
                />
              </If>
            </View>
          }
        >
          <View
            style={{
              ...(phone() ? {} : row),
              alignItems: phone() ? "stretch" : "flex-start",
              gap: phone() ? 4 : 10,
              minHeight: 73,
              paddingVertical: 8,
              paddingHorizontal: 16,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <If when={!phone()}>
              <View style={{ width: 24, alignItems: "center", paddingTop: 5 }}>
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: c().muted,
                    borderRadius: 7,
                    padding: 1,
                  }}
                >
                  <Icon name="arrowUp" tone="muted" size={8} />
                </View>
              </View>
            </If>
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <View testID="host-version">
                <Label size={14} line={20} weight={500}>
                  {version()}
                </Label>
              </View>
              <If when={phone()}>
                <View style={{ ...row, gap: 5 }}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      backgroundColor: c()[statusTone()],
                    }}
                  />
                  <Label size={12} line={16} tone="mutedInk">
                    {statusLabel()}
                  </Label>
                </View>
              </If>
              <Label size={12} line={17} tone="muted">
                {desktopTitle()}
              </Label>
              <If when={offer() && note() && !active()}>
                <View
                  role="button"
                  accessibilityState={{ expanded: notes() }}
                  onPress={() => notes.set(!notes())}
                  style={{
                    ...row,
                    gap: 5,
                    alignSelf: "flex-start",
                    cursor: "pointer",
                  }}
                >
                  <Label size={12} line={17} tone="mutedInk">
                    {uiText("whatsNew")}
                  </Label>
                  <Icon
                    name={notes() ? "down" : "right"}
                    size={8}
                    tone="muted"
                  />
                </View>
              </If>
            </View>
            <If
              when={phone()}
              else={
                <View style={{ width: 146, alignItems: "flex-start", gap: 7 }}>
                  <View style={{ ...row, gap: 6 }}>
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        backgroundColor: c()[statusTone()],
                      }}
                    />
                    <Label size={12} line={18} tone="mutedInk">
                      {statusLabel()}
                    </Label>
                  </View>
                  {updateAction()}
                </View>
              }
            >
              <If when={active() || offer()}>
                <View style={{ alignItems: "flex-start" }}>
                  {updateAction()}
                </View>
              </If>
            </If>
          </View>
          <If when={notes() && offer() && !active() ? note() : undefined}>
            {(release) => (
              <View
                style={{
                  padding: 16,
                  gap: 8,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Markdown value={release().text} compactHeadings />
                <If when={release().url}>
                  {(url) => (
                    <Button
                      label={uiText("readFullReleaseNotes")}
                      onPress={() => void host.action(() => openUrl(url()))}
                    />
                  )}
                </If>
              </View>
            )}
          </If>
          <If when={active() && (progress() || status()?.busy?.length)}>
            <View
              style={{
                padding: 16,
                gap: 8,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <If when={progress()}>
                {(download) => (
                  <ProgressLine
                    value={percent(download().received, download().total)}
                  />
                )}
              </If>
              <BusyList
                work={status()?.busy ?? []}
                label={uiText("waitingFor")}
              />
            </View>
          </If>
          <If
            when={
              (error() && !editor() && !confirm()) ||
              (failed() && status()?.error) ||
              check()?.error ||
              check()?.blocked
            }
          >
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                gap: 3,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <If
                when={
                  (error() && !editor() && !confirm()) ||
                  (failed() && status()?.error) ||
                  check()?.error
                }
              >
                <Label size={12} tone="red">
                  {(error() && !editor() && !confirm() ? error() : "") ||
                    (failed() ? status()?.error : "") ||
                    check()?.error}
                </Label>
              </If>
              <If when={check()?.blocked}>
                {(blocked) => (
                  <Label size={12} tone="muted">
                    {uiText(blockedExplanation[blocked()])}
                  </Label>
                )}
              </If>
            </View>
          </If>
          <GroupHeading title={uiText("whichVersions")} phone={phone()} />
          <View
            style={{
              ...(phone() ? {} : row),
              minHeight: 71,
              gap: phone() ? 4 : 14,
              paddingHorizontal: 16,
              paddingVertical: 7,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              style={{ flex: phone() ? undefined : 1, minWidth: 0, gap: 2 }}
            >
              <Label size={14} line={19}>
                {uiText("channel")}
              </Label>
              <If when={!phone()}>
                <Label size={12} line={16} tone="muted">
                  {uiText("preReleasesRcBetaGetNew")}
                </Label>
              </If>
            </View>
            <View style={{ width: phone() ? "100%" : 160, flexShrink: 0 }}>
              <Select
                accessibilityLabel={uiText("channel")}
                items={[
                  { value: "full", title: uiText("updateFullReleases") },
                  { value: "pre", title: uiText("updatePreReleases") },
                ]}
                value={check()?.prerelease ? "pre" : "full"}
                cover={false}
                offset={2}
                disabled={!editable() || !host.can("upgrade.setPrerelease")}
                popupStyle={{
                  borderWidth: 1,
                  borderColor: c().strong,
                  backgroundColor: c().canvas,
                }}
                itemStyle={{
                  color: c().ink,
                  fontSize: 12,
                  minHeight: 29,
                  paddingHorizontal: 10,
                }}
                trigger={
                  <View
                    style={{
                      ...row,
                      height: phone() ? 32 : 24,
                      gap: 6,
                      paddingHorizontal: 10,
                      borderWidth: 1,
                      borderColor: c().strong,
                      backgroundColor: c().canvas,
                    }}
                  >
                    <Label size={12} lines={1} style={{ flex: 1 }}>
                      {channelName()}
                    </Label>
                    <Icon name="down" size={9} tone="muted" />
                  </View>
                }
                onChange={({ value }) => {
                  if (value && (value === "pre") !== check()?.prerelease)
                    void save("setPrerelease", { prerelease: value === "pre" });
                }}
              />
            </View>
            <If when={phone()}>
              <Label size={12} line={17} tone="muted">
                {uiText("preReleasesRcBetaGetNew")}
              </Label>
            </If>
          </View>
          <GroupHeading title={uiText("whereUpdatesComeFrom")} phone={phone()}>
            <View
              role="button"
              accessibilityLabel={uiText("advanced")}
              accessibilityState={{ expanded: advancedOpen() }}
              onPress={() => advanced.set(!advancedOpen())}
              hoverStyle={{ backgroundColor: c().selected }}
              focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
              style={{
                ...row,
                height: phone() ? 28 : 24,
                width: 98,
                paddingHorizontal: 10,
                justifyContent: "space-between",
                borderWidth: 1,
                borderColor: c().strong,
                cursor: "pointer",
              }}
            >
              <Label size={12}>{uiText("advanced")}</Label>
              <View
                style={{
                  transform: advancedOpen()
                    ? [{ rotate: "180deg" }]
                    : undefined,
                }}
              >
                <Icon name="down" size={9} tone="muted" />
              </View>
            </View>
          </GroupHeading>
          <If when={advancedOpen() ? source() : undefined}>
            {(upstream) => (
              <SettingBand
                title={uiText("updatesFrom")}
                detail={`${upstream().label} · ${sourceKind()}`}
              >
                <If
                  when={
                    upstream().source !== "env" &&
                    host.can("upgrade.setUpstream")
                  }
                >
                  <Button
                    label={uiText("change")}
                    disabled={!editable()}
                    onPress={() => edit("upstream")}
                  />
                </If>
              </SettingBand>
            )}
          </If>
          <If when={advancedOpen() && token()?.host}>
            <SettingBand
              title={uiText("accessToken")}
              detail={`${tokenKind()} · ${tokenHint()}`}
            >
              <If when={host.can("upgrade.setToken")}>
                <Button
                  label={token()?.saved ? uiText("change") : uiText("set")}
                  disabled={!editable()}
                  onPress={() => edit("token")}
                />
              </If>
            </SettingBand>
          </If>
        </If>
        <If when={canStartHost}>
          <DesktopAppUpdate work={check()?.busy ?? []} />
        </If>
      </Scroll>
      <If when={editor()}>
        {(mode) => (
          <Modal
            title={
              mode() === "upstream"
                ? uiText("changeWhereUpdatesComeFrom")
                : uiText("setAccessToken")
            }
            phone={phone()}
            width={448}
            blurBackdrop={false}
            overPhoneNavigation
            dismissible={!pending()}
            onClose={closeEditor}
          >
            <View style={{ padding: 16, gap: 12 }}>
              <Label size={12} tone={mode() === "upstream" ? "amber" : "muted"}>
                {mode() === "upstream"
                  ? uiText("theHostInstallsAndRunsCode")
                  : uiText("theTokenIsStoredOnThe", { host: token()?.host })}
              </Label>
              <Field
                label={
                  mode() === "upstream"
                    ? uiText("repositoryOrReleaseServer")
                    : uiText("accessToken")
                }
                placeholder={
                  mode() === "upstream" ? source()?.fallback : undefined
                }
                masked={mode() === "token"}
                value={draft()}
                onChange={draft.set}
              />
              <If when={error()}>
                <Label size={12} tone="red">
                  {error()}
                </Label>
              </If>
              <View
                style={{
                  ...row,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  gap: 8,
                }}
              >
                <If
                  when={
                    mode() === "upstream" ? source()?.saved : token()?.saved
                  }
                >
                  <Button
                    label={
                      mode() === "upstream"
                        ? uiText("useDefault")
                        : uiText("removeToken")
                    }
                    disabled={!editable()}
                    onPress={() =>
                      mode() === "upstream"
                        ? void save("setUpstream", {})
                        : void save("setToken", {})
                    }
                  />
                  <View style={{ flex: 1 }} />
                </If>
                <Button
                  label={uiText("cancel")}
                  disabled={!!pending()}
                  onPress={closeEditor}
                />
                <Button
                  label={uiText("save")}
                  tone="primary"
                  disabled={!editable() || !draft().trim()}
                  onPress={() =>
                    mode() === "upstream"
                      ? void save("setUpstream", { upstream: draft().trim() })
                      : void save("setToken", { token: draft().trim() })
                  }
                />
              </View>
            </View>
          </Modal>
        )}
      </If>
      <If when={confirm()}>
        <Modal
          title={uiText("updateTheHostTo", { value1: check()?.latest ?? "" })}
          phone={phone()}
          width={448}
          blurBackdrop={false}
          overPhoneNavigation
          dismissible={!pending()}
          onClose={() => {
            confirm.set(false);
            error.set("");
          }}
        >
          <View style={{ padding: 16, gap: 10 }}>
            <Label size={12} tone="mutedInk">
              {uiText("etaDownloadsTheReleaseBacksUp")}
            </Label>
            <BusyList
              work={check()?.busy ?? []}
              label={uiText("theRestartWouldStop")}
            />
            <If when={error()}>
              <Label size={12} tone="red">
                {error()}
              </Label>
            </If>
            <View
              style={{
                ...row,
                flexWrap: "wrap",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <Button
                label={uiText("cancel")}
                disabled={!!pending()}
                onPress={() => {
                  confirm.set(false);
                  error.set("");
                }}
              />
              <Button
                label={
                  check()?.busy.length
                    ? uiText("waitForWork")
                    : uiText("update")
                }
                tone="primary"
                disabled={!canUpdate()}
                onPress={() => void request("start", { force: false })}
              />
              <If when={check()?.busy.length}>
                <Button
                  label={uiText("updateNow")}
                  tone="danger"
                  disabled={!canUpdate()}
                  onPress={() => void request("start", { force: true })}
                />
              </If>
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}

function DesktopAppUpdate(props: { work: UpgradeCheckView["busy"] }) {
  const c = colors();
  const host = useHost();
  const update = signal<AppUpdate | undefined>(undefined);
  const checked = signal(false);
  const checking = signal(false);
  const progress = signal<UpdateProgress | undefined>(undefined);
  const ready = signal(false);
  const busy = signal(false);
  const confirm = signal(false);
  const failure = signal("");
  async function check() {
    if (checking() || busy()) return;
    checking.set(true);
    checked.set(false);
    failure.set("");
    ready.set(false);
    update.set(undefined);
    try {
      update.set((await checkForUpdate()) ?? undefined);
      checked.set(true);
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      checking.set(false);
    }
  }
  async function download() {
    const next = update();
    if (!next || busy()) return;
    if (!next.canInstall) {
      await host.action(() => openUrl(next.url));
      return;
    }
    busy.set(true);
    failure.set("");
    try {
      await downloadUpdate(progress.set);
      ready.set(true);
      confirm.set(true);
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      progress.set(undefined);
      busy.set(false);
    }
  }
  async function restart() {
    if (busy()) return;
    busy.set(true);
    try {
      await installAndRestart();
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
      confirm.set(false);
    } finally {
      busy.set(false);
    }
  }
  const percentage = () => {
    const current = progress();
    return current?.total
      ? Math.round((100 * current.received) / current.total)
      : undefined;
  };
  return (
    <View
      style={{
        padding: 16,
        gap: 9,
        borderTopWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ ...row, gap: 8 }}>
        <Label weight={600} style={{ flex: 1 }}>
          {uiText("desktopApp")}
        </Label>
        <Label size={12} tone="muted">
          {appInfo().version ?? "dev"}
        </Label>
        <Button
          label={
            checking()
              ? uiText("checking")
              : checked()
                ? uiText("checkAgain")
                : uiText("checkDesktopApp")
          }
          disabled={checking() || busy()}
          onPress={() => void check()}
        />
      </View>
      <If when={checked() && !update()}>
        <Label size={12} tone="muted">
          {uiText("noDesktopAppUpdateAvailable")}
        </Label>
      </If>
      <If when={update()}>
        {(next) => (
          <View style={{ ...row, gap: 8 }}>
            <Label size={12} style={{ flex: 1 }}>
              {uiText("versionAvailable", { version: next().version })}
            </Label>
            <Button
              disabled={busy()}
              label={
                busy()
                  ? percentage() === undefined
                    ? uiText("downloading")
                    : uiText("downloadingWithCount", {
                        percentage: percentage(),
                      })
                  : ready()
                    ? uiText("restartToUpdate")
                    : next().canInstall
                      ? uiText("downloadUpdate")
                      : uiText("openDownload")
              }
              onPress={() => (ready() ? confirm.set(true) : void download())}
            />
          </View>
        )}
      </If>
      <If when={failure()}>
        <Label size={12} tone="red">
          {failure()}
        </Label>
      </If>
      <If when={confirm() && update()}>
        <Modal
          title={uiText("updateTheDesktopAppTo", {
            version: update()!.version,
          })}
          width={448}
          height={250}
          hideHeader
          modalFocus
          blurBackdrop={false}
          dismissible={!busy()}
          onClose={() => confirm.set(false)}
        >
          <View style={{ ...grow, padding: 20, gap: 10 }}>
            <Label size={14} line={20} weight={500}>
              {uiText("updateTheDesktopAppTo", { version: update()!.version })}
            </Label>
            <Scroll style={grow}>
              <View style={{ gap: 10 }}>
                <Label size={12} line={18} tone="mutedInk">
                  {host.address()?.local
                    ? uiText("etaQuitsSwapsInTheNew")
                    : uiText("etaQuitsSwapsInTheNewVersion")}
                </Label>
                <If when={host.address()?.local}>
                  <BusyList
                    work={props.work}
                    label={uiText("theRestartWouldStop")}
                  />
                </If>
              </View>
            </Scroll>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                disabled={busy()}
                onPress={() => confirm.set(false)}
              />
              <Button
                label={busy() ? uiText("restarting") : uiText("restartNow")}
                tone="primary"
                disabled={busy()}
                onPress={() => void restart()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}
