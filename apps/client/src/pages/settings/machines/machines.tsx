import type {
  MachineResults,
  MachineView,
  TailscaleServeStatusView,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Layout } from "../../../components";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { ListSkeleton } from "../../../components/loading-skeleton";
import { MenuRule } from "../../../components/menu";
import { StatusDot } from "../../../components/status-dot";
import { ToggleSwitch } from "../../../components/toggle-switch";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText, useText } from "../../../i18n";
import { relativeTime, useHost } from "../../../services/host";
import { useLoadState } from "../../../services/load-status";
import { problemText } from "../../../services/problem-text";
import { CopyButton } from "../../../ui";
import { emptyStyle, SectionHeader } from "../section";
import { AddMachine } from "./add-machine";
import { MachineDetail, machineSystem } from "./machine-detail";
import {
  MachineRunsLimit,
  RemoveMachine,
  RenameMachine,
} from "./machine-dialogs";
import { useMachineUpdate } from "./machine-update";
import { PhonePairing } from "./phone-pairing";
import {
  alternateTailscalePort,
  mergeTailscaleServeResult,
  setTailscaleServeArgs,
  TAILSCALE_SERVE_CALL_TIMEOUT_MS,
  tailscaleDiagnosticText,
  tailscaleHttpsUrl,
} from "./remote-access";

/** A machine's status column: wider while it updates, for the progress. */
const statusWidth = { updating: 160, idle: 100 } as const;

export function machineStatus(item: MachineView) {
  if (item.status === "pending") return uiText("machinePending");
  if (item.status === "offline") return uiText("machineOffline");
  if (item.build === "outdated") return uiText("machineNeedsUpdate");
  if (item.build === "updating") return uiText("updating");
  return uiText("machineOnline");
}

function MachineRow(props: {
  item: MachineView;
  phone: boolean;
  open: () => void;
}) {
  const host = useHost();
  const c = colors();
  const dialog = signal<"" | "menu" | "rename" | "runs" | "remove">("");
  const machineUpdate = useMachineUpdate(() => props.item);
  const updating = machineUpdate.pressed;
  const update = machineUpdate.start;
  const updatable = () =>
    props.item.kind === "daemon" &&
    props.item.install === "service" &&
    props.item.status === "online" &&
    (props.item.build === "outdated" || !!props.item.updateError);
  const metadata = () =>
    [
      props.item.kind === "primary" && uiText("machinePrimary"),
      props.item.status === "offline" &&
        props.item.lastSeenAt &&
        uiText("machineLastSeen", {
          time: relativeTime(props.item.lastSeenAt),
        }),
      machineSystem(props.item.os) ?? props.item.platform,
      props.item.home,
      uiText("machineCapacity", { count: props.item.maxActiveRuns }),
    ]
      .filter(Boolean)
      .join(" · ");
  const status = () => (
    <View
      style={{
        ...row,
        height: props.phone ? space[16] : space[20],
        width: props.phone
          ? undefined
          : machineUpdate.state()
            ? statusWidth.updating
            : statusWidth.idle,
        gap: space[4],
      }}
    >
      <StatusDot
        color={
          machineUpdate.tone()
            ? c()[machineUpdate.tone()!]
            : props.item.status === "offline"
              ? c().strong
              : props.item.status === "pending" ||
                  props.item.build === "outdated" ||
                  props.item.build === "updating"
                ? c().warning
                : c().green
        }
      />
      <Label variant="small" tone="mutedInk">
        {machineUpdate.label() ?? machineStatus(props.item)}
      </Label>
    </View>
  );
  /** The phone's actions sheet: the menu's items, as 48pt rows. */
  interface SheetAction {
    label: string;
    disabled?: boolean;
    run: () => void;
  }
  const sheetActions = (): SheetAction[] =>
    (
      [
        host.can("machines.rename") && {
          label: uiText("machineMenuRename"),
          run: () => dialog.set("rename"),
        },
        { label: uiText("machineMenuRuns"), run: () => dialog.set("runs") },
        updatable() && {
          label: uiText("machineMenuUpdate"),
          disabled: updating(),
          run: () => void update(),
        },
        props.item.kind !== "primary" && {
          label: uiText("machineMenuRemove"),
          run: () => dialog.set("remove"),
        },
      ] as (SheetAction | false)[]
    ).filter((action): action is SheetAction => !!action);
  return (
    <>
      {/* The hover is the whole row's and the button fills it, padding inside, up to the rule;
          the menu sits over the button's right padding, beside it rather than inside it. */}
      <View
        hoverStyle={{ backgroundColor: c().selected }}
        style={{ borderBottomWidth: 1, borderColor: c().border }}
      >
        <View
          role="button"
          accessibilityLabel={props.item.name}
          onPress={props.open}
          style={{
            ...row,
            alignItems: "flex-start",
            gap: space[8],
            paddingLeft: space[16],
            // Room for the menu: its trigger is 24 wide, the phone's button 28 (its minWidth wins).
            paddingRight:
              space[16] + (props.phone ? control.md : control.sm) + space[8],
            paddingVertical: space[8],
            cursor: "pointer",
          }}
        >
          <View
            style={{
              width: props.phone ? control.md : space[24],
              height: props.phone ? control.md : space[24],
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="monitor" size={icon.md} tone="muted" />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label
              weight={weight.regular}
              tone={props.item.status === "offline" ? "muted" : "ink"}
            >
              {props.item.name}
            </Label>
            <If when={props.phone}>{status()}</If>
            <Label variant="small" tone="muted">
              {metadata()}
            </Label>
          </View>
          <If when={!props.phone}>{status()}</If>
        </View>
        <View style={{ position: "absolute", top: 8, right: 16 }}>
          <If
            when={props.phone}
            else={
              <ActionMenu
                label={uiText("machineActions", { name: props.item.name })}
                triggerStyle={{
                  minWidth: space[24],
                  width: space[24],
                  height: props.phone ? control.md : space[24],
                  paddingHorizontal: 0,
                }}
                // The row under it is already highlighted: a step darker, so the menu reads as its own target.
                triggerHoverStyle={{ backgroundColor: c().border }}
              >
                <If when={host.can("machines.rename")}>
                  <ActionItem
                    label={uiText("machineMenuRename")}
                    onSelect={() => dialog.set("rename")}
                  />
                </If>
                <ActionItem
                  label={uiText("machineMenuRuns")}
                  onSelect={() => dialog.set("runs")}
                />
                <If when={updatable()}>
                  <ActionItem
                    label={uiText("machineMenuUpdate")}
                    disabled={updating()}
                    onSelect={() => void update()}
                  />
                </If>
                <If when={props.item.kind !== "primary"}>
                  <MenuRule
                    style={{
                      height: 1,
                      marginVertical: space[4],
                      backgroundColor: c().border,
                    }}
                  />
                  <ActionItem
                    label={uiText("machineMenuRemove")}
                    onSelect={() => dialog.set("remove")}
                  />
                </If>
              </ActionMenu>
            }
          >
            <Button
              label={uiText("machineActions", { name: props.item.name })}
              icon="more"
              iconOnly
              tone="ghost"
              size={control.md}
              style={{ width: space[24], paddingHorizontal: 0 }}
              onPress={() => dialog.set("menu")}
            />
          </If>
        </View>
        <If
          when={
            machineUpdate.state() === "failed"
              ? problemText(props.item.updateError ?? "")
              : undefined
          }
        >
          {(reason) => (
            <View
              testID="machine-update-failure"
              style={{
                // Under the title: the row's inset, the icon's box and the gap after it.
                paddingLeft:
                  space[16] + (props.phone ? control.md : space[24]) + space[8],
                paddingRight: space[16],
                paddingBottom: space[8],
                gap: space[8],
                ...(props.phone ? {} : { ...row, alignItems: "flex-start" }),
              }}
            >
              <Label variant="small" tone="mutedInk" style={{ flex: 1 }}>
                {reason()}
              </Label>
              <If when={updatable() && host.can("machines.upgrade")}>
                <Button
                  label={uiText("updateTryAgain")}
                  size={props.phone ? control.touch : undefined}
                  disabled={updating()}
                  onPress={() => void update()}
                />
              </If>
            </View>
          )}
        </If>
      </View>
      <If when={dialog() === "menu"}>
        <Modal
          title={props.item.name}
          phone
          sheet
          plainSheetHeader
          overPhoneNavigation
          onClose={() => dialog.set("")}
        >
          <View style={{ borderTopWidth: 1, borderColor: c().border }}>
            <Each of={sheetActions()} key={(action) => action.label}>
              {(action) => (
                <View
                  role="button"
                  accessibilityLabel={action().label}
                  accessibilityState={{ disabled: !!action().disabled }}
                  onPress={() => {
                    if (action().disabled) return;
                    dialog.set("");
                    action().run();
                  }}
                  pressedStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...row,
                    height: space[48],
                    paddingHorizontal: space[16],
                    borderBottomWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Label tone={action().disabled ? "muted" : "ink"}>
                    {action().label}
                  </Label>
                </View>
              )}
            </Each>
          </View>
        </Modal>
      </If>
      <If when={dialog() === "rename"}>
        <RenameMachine
          item={props.item}
          phone={props.phone}
          onClose={() => dialog.set("")}
        />
      </If>
      <If when={dialog() === "runs"}>
        <MachineRunsLimit
          item={props.item}
          phone={props.phone}
          onClose={() => dialog.set("")}
        />
      </If>
      <If when={dialog() === "remove"}>
        <RemoveMachine
          item={props.item}
          phone={props.phone}
          onClose={() => dialog.set("")}
        />
      </If>
    </>
  );
}

function TailscaleHttpsRow(props: {
  addresses: MachineResults["addresses"];
  phone: boolean;
  onChange: (next: MachineResults["addresses"]) => void;
}) {
  const host = useHost();
  const c = colors();
  const toggling = signal<"" | "enabling" | "disabling">("");
  const actionError = signal("");
  const status = (): TailscaleServeStatusView => props.addresses.tailscaleServe;
  const diagnostic = () =>
    actionError() ||
    (status().installed && status().running
      ? (tailscaleDiagnosticText(status()) ?? "")
      : "");
  const retryPort = () => alternateTailscalePort(status());
  const canToggle = () =>
    host.can("machines.setTailscaleServe") &&
    !toggling() &&
    (status().enabled ||
      status().holderStatus === "ours" ||
      (status().installed && status().running));
  const retrySamePort = () =>
    status().diagnostic === "probe-failed" && status().port !== 443
      ? status().port
      : undefined;

  async function toggle(enabled: boolean, port?: number) {
    if (toggling()) return;
    toggling.set(enabled ? "enabling" : "disabling");
    actionError.set("");
    try {
      const result = await host.call<MachineResults["setTailscaleServe"]>(
        "machines",
        "setTailscaleServe",
        setTailscaleServeArgs(enabled, port),
        { timeoutMs: TAILSCALE_SERVE_CALL_TIMEOUT_MS },
      );
      props.onChange(mergeTailscaleServeResult(props.addresses, result));
    } catch (err) {
      actionError.set(problemText(err));
    } finally {
      toggling.set("");
    }
  }

  return (
    <View style={{ borderBottomWidth: 1, borderColor: c().border }}>
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          gap: space[8],
          paddingHorizontal: space[16],
          paddingVertical: space[8],
        }}
      >
        <View
          style={{
            width: props.phone ? control.md : space[24],
            height: props.phone ? control.md : space[24],
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="globe" size={icon.md} tone="muted" />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
          <Label weight={weight.regular}>{uiText("tailscaleHttps")}</Label>
          <If
            when={toggling()}
            else={
              <If
                when={status().enabled && status().activeUrl}
                else={
                  <If
                    when={status().installed && status().running}
                    else={
                      <View style={{ ...row, gap: space[4] }}>
                        <StatusDot color={c().strong} />
                        <Label
                          variant="small"
                          tone="muted"
                          lines={1}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          {tailscaleDiagnosticText(status()) ??
                            uiText("tailscaleDiagNotInstalled")}
                        </Label>
                      </View>
                    }
                  >
                    <If
                      when={
                        status().enabled || status().holderStatus === "ours"
                      }
                      else={
                        <Label variant="small" tone="muted" lines={1}>
                          {status().magicDnsName && !diagnostic()
                            ? tailscaleHttpsUrl(
                                status().magicDnsName!,
                                status().port,
                              )
                            : uiText("tailscaleHttpsReady")}
                        </Label>
                      }
                    >
                      <View style={{ ...row, gap: space[4] }}>
                        <StatusDot color={c().warning} />
                        <Label
                          variant="small"
                          tone="muted"
                          lines={1}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          {status().magicDnsName
                            ? tailscaleHttpsUrl(
                                status().magicDnsName!,
                                status().port,
                              )
                            : uiText("tailscaleHttpsReady")}
                        </Label>
                      </View>
                    </If>
                  </If>
                }
              >
                <View style={{ ...row, gap: space[4] }}>
                  <StatusDot color={c().green} />
                  <Label
                    variant="small"
                    mono
                    tone="mutedInk"
                    lines={1}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {status().activeUrl!}
                  </Label>
                </View>
              </If>
            }
          >
            <Label variant="small" tone="muted">
              {toggling() === "enabling"
                ? uiText("tailscaleHttpsEnabling")
                : uiText("tailscaleHttpsDisabling")}
            </Label>
          </If>
        </View>
        <View style={{ ...row, gap: space[8], height: space[24] }}>
          <If when={status().enabled && status().activeUrl}>
            <CopyButton
              value={() => status().activeUrl ?? ""}
              label={uiText("tailscaleHttpsCopyUrl")}
              iconOnly
              tone="ghost"
              size={control.sm}
            />
          </If>
          <ToggleSwitch
            label={uiText("tailscaleHttps")}
            checked={status().enabled}
            disabled={!canToggle()}
            onChange={(checked) =>
              void toggle(
                checked,
                checked
                  ? retrySamePort()
                  : !status().enabled && status().holderStatus === "ours"
                    ? status().port
                    : undefined,
              )
            }
          />
        </View>
      </View>
      <If when={diagnostic()}>
        {(reason) => (
          <View
            testID="tailscale-https-error"
            style={{
              paddingLeft:
                space[16] + (props.phone ? control.md : space[24]) + space[8],
              paddingRight: space[16],
              paddingBottom: space[8],
              gap: space[8],
              ...(props.phone ? {} : { ...row, alignItems: "flex-start" }),
            }}
          >
            <Label variant="small" tone="warningInk" style={{ flex: 1 }}>
              {reason()}
            </Label>
            <If
              when={
                host.can("machines.setTailscaleServe") ? retryPort() : undefined
              }
              else={
                <If
                  when={
                    host.can("machines.setTailscaleServe") &&
                    status().diagnostic === "probe-failed" &&
                    !status().enabled &&
                    status().holderStatus === "ours"
                  }
                  else={
                    <If
                      when={
                        host.can("machines.setTailscaleServe") &&
                        status().diagnostic === "probe-failed" &&
                        status().enabled
                      }
                    >
                      <Button
                        label={uiText("retry")}
                        size={props.phone ? control.touch : control.sm}
                        disabled={!!toggling()}
                        onPress={() => void toggle(true, retrySamePort())}
                      />
                    </If>
                  }
                >
                  <Button
                    label={uiText("tailscaleHttpsTurnOff")}
                    size={props.phone ? control.touch : control.sm}
                    disabled={!!toggling()}
                    onPress={() => void toggle(false, status().port)}
                  />
                </If>
              }
            >
              {(port) => (
                <Button
                  label={uiText("tailscaleHttpsRetryPort", { port: port() })}
                  size={props.phone ? control.touch : control.sm}
                  disabled={!!toggling()}
                  onPress={() => void toggle(true, port())}
                />
              )}
            </If>
          </View>
        )}
      </If>
    </View>
  );
}

export function Machines(props: {
  machines: MachineView[];
  layout: Layout;
  onTask: (id: string) => void;
  onBack: () => void;
}) {
  const host = useHost();
  const text = useText();
  const adding = signal(false);
  const pairing = signal(false);
  const addresses = signal<MachineResults["addresses"] | undefined>(undefined);
  let pairingAnchor: ViewRef | undefined;
  const machineId = signal("");
  const phone = () => props.layout === "phone";
  const visible = () => props.machines;
  const machine = () => visible().find((item) => item.id === machineId());
  const load = useLoadState({ targets: () => ["machines"] });

  if (host.can("machines.addresses")) {
    void host
      .call<MachineResults["addresses"]>("machines", "addresses", {})
      .then((result) => {
        if (result?.tailscaleServe) addresses.set(result);
      })
      .catch(() => {});
  }

  return (
    <>
      <If when={!adding() || phone()}>
        <If when={phone()}>
          <Header
            title={text("settings")}
            layout="phone"
            onBack={props.onBack}
            backIconSize={icon.md}
          />
        </If>
        <SectionHeader
          title={text("machines")}
          count={visible().length}
          phone={phone()}
        >
          <View
            ref={(node: ViewRef) => {
              pairingAnchor = node;
            }}
            style={{ ...row, gap: space[8] }}
          >
            <If when={host.can("machines.phoneLink")}>
              <Button
                label={uiText("connectPhone")}
                size={phone() ? control.md : undefined}
                style={phone() ? { paddingHorizontal: space[12] } : undefined}
                onPress={() => pairing.set(true)}
              />
            </If>
            <If when={host.can("machines.enroll")}>
              <Button
                label={uiText("addMachine")}
                icon="plus"
                size={phone() ? control.md : undefined}
                style={
                  phone()
                    ? { paddingHorizontal: space[12], gap: space[4] }
                    : undefined
                }
                onPress={() => adding.set(true)}
              />
            </If>
          </View>
        </SectionHeader>
        <SmoothScroll style={grow} scrollbar={false}>
          <If when={addresses()}>
            {(info) => (
              <TailscaleHttpsRow
                addresses={info()}
                phone={phone()}
                onChange={addresses.set}
              />
            )}
          </If>
          <If when={!visible().length}>
            <EmptyState
              size="page"
              width="narrow"
              style={emptyStyle}
              status={load.shown()}
              loading={<ListSkeleton label={uiText("loadingMachines")} />}
              error={{
                title: uiText("machinesDidNotLoad"),
                description: load.why(),
                retry: load.retry,
                retrying: load.retrying(),
              }}
              empty={{
                art: "machines",
                title: uiText("noMachinesYet"),
                description: uiText("noMachinesYetHint"),
                actions: host.can("machines.enroll")
                  ? [
                      {
                        label: uiText("addMachine"),
                        icon: "plus",
                        onPress: () => adding.set(true),
                      },
                    ]
                  : undefined,
              }}
            />
          </If>
          <Each of={visible()} key={(item) => item.id}>
            {(item) => (
              <MachineRow
                item={item()}
                phone={phone()}
                open={() => machineId.set(item().id)}
              />
            )}
          </Each>
        </SmoothScroll>
      </If>
      <If when={pairing()}>
        <PhonePairing
          phone={phone()}
          anchor={pairingAnchor}
          initialAddresses={addresses()}
          onAddressesChange={addresses.set}
          onClose={() => pairing.set(false)}
        />
      </If>
      <If when={adding()}>
        <AddMachine phone={phone()} onClose={() => adding.set(false)} />
      </If>
      <If when={machine()}>
        {(item) => (
          <MachineDetail
            item={item()}
            phone={phone()}
            onTask={props.onTask}
            onClose={() => machineId.set("")}
          />
        )}
      </If>
    </>
  );
}
