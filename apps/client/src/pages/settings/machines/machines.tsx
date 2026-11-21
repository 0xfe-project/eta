import type { MachineView } from "@eta/client-contracts";
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
import { MenuRule } from "../../../components/menu";
import { StatusDot } from "../../../components/status-dot";
import { uiText, useText } from "../../../i18n";
import { relativeTime, useHost } from "../../../services/host";
import { SectionHeader } from "../section";
import { AddMachine } from "./add-machine";
import { MachineDetail, machineSystem } from "./machine-detail";
import {
  MachineRunsLimit,
  RenameMachine,
  RevokeMachine,
} from "./machine-dialogs";
import { PhonePairing } from "./phone-pairing";

export function machineStatus(item: MachineView) {
  if (item.status === "pending") return uiText("machinePending");
  if (item.status === "revoked") return uiText("machineRevoked");
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
  const dialog = signal<"" | "menu" | "rename" | "runs" | "revoke">("");
  const updating = signal(false);
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
        height: props.phone ? 16 : 20,
        width: props.phone ? undefined : 100,
        gap: 6,
      }}
    >
      <StatusDot
        color={
          props.item.status === "offline"
            ? c().strong
            : props.item.status === "pending" ||
                props.item.build === "outdated" ||
                props.item.build === "updating"
              ? c().amber
              : c().green
        }
      />
      <Label variant="small" tone="mutedInk">
        {machineStatus(props.item)}
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
          label: uiText("machineMenuRevoke"),
          run: () => dialog.set("revoke"),
        },
      ] as (SheetAction | false)[]
    ).filter((action): action is SheetAction => !!action);
  async function update() {
    if (updating()) return;
    updating.set(true);
    await host.action(() =>
      host.call("machines", "upgrade", { machineId: props.item.id }),
    );
    updating.set(false);
  }
  return (
    <>
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          paddingHorizontal: 16,
          paddingVertical: 8,
          gap: 10,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View
          role="button"
          accessibilityLabel={props.item.name}
          onPress={props.open}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            alignItems: "flex-start",
            flex: 1,
            minWidth: 0,
            gap: 10,
            cursor: "pointer",
          }}
        >
          <View
            style={{
              width: props.phone ? 28 : 24,
              height: props.phone ? 28 : 24,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="monitor" size={16} tone="muted" />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Label
              weight={500}
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
        <If
          when={props.phone}
          else={
            <ActionMenu
              label={uiText("machineActions", { name: props.item.name })}
              triggerStyle={{
                minWidth: 24,
                width: 24,
                height: props.phone ? 28 : 24,
                paddingHorizontal: 0,
              }}
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
                    marginVertical: 4,
                    backgroundColor: c().border,
                  }}
                />
                <ActionItem
                  label={uiText("machineMenuRevoke")}
                  onSelect={() => dialog.set("revoke")}
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
            size={28}
            style={{ width: 24, paddingHorizontal: 0 }}
            onPress={() => dialog.set("menu")}
          />
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
                    height: 48,
                    paddingHorizontal: 16,
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
      <If when={dialog() === "revoke"}>
        <RevokeMachine
          item={props.item}
          phone={props.phone}
          onClose={() => dialog.set("")}
        />
      </If>
    </>
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
  let pairingAnchor: ViewRef | undefined;
  const machineId = signal("");
  const phone = () => props.layout === "phone";
  const visible = () =>
    props.machines.filter((item) => item.status !== "revoked");
  const machine = () => visible().find((item) => item.id === machineId());
  return (
    <>
      <If when={!adding() || phone()}>
        <If when={phone()}>
          <Header
            title={text("settings")}
            layout="phone"
            onBack={props.onBack}
            backIconSize={16}
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
            style={{ ...row, gap: 8 }}
          >
            <If when={host.can("machines.phoneLink")}>
              <Button
                label={uiText("connectPhone")}
                size={phone() ? 28 : undefined}
                style={phone() ? { paddingHorizontal: 10 } : undefined}
                onPress={() => pairing.set(true)}
              />
            </If>
            <If when={host.can("machines.enroll")}>
              <Button
                label={uiText("addMachine")}
                icon="plus"
                size={phone() ? 28 : undefined}
                style={phone() ? { paddingHorizontal: 10, gap: 6 } : undefined}
                onPress={() => adding.set(true)}
              />
            </If>
          </View>
        </SectionHeader>
        <SmoothScroll style={grow} scrollbar={false}>
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
