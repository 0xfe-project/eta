import type { MachineView } from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
} from "../../../components";
import { StatusDot } from "../../../components/status-dot";
import { uiText, useText } from "../../../i18n";
import { relativeTime, useHost } from "../../../services/host";
import { SectionHeader } from "../section";
import { AddMachine } from "./add-machine";
import { MachineDetail, machineSystem } from "./machine-detail";
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
  const renaming = signal(false);
  const name = signal("");
  const saving = signal(false);
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
            ? c().muted
            : props.item.status === "pending" ||
                props.item.build === "outdated" ||
                props.item.build === "updating"
              ? c().amber
              : c().green
        }
      />
      <Label size={12} line={16} tone="muted">
        {machineStatus(props.item)}
      </Label>
    </View>
  );
  async function rename() {
    if (saving() || !name().trim()) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call("machines", "rename", {
        machineId: props.item.id,
        name: name().trim(),
      }),
    );
    saving.set(false);
    if (result) renaming.set(false);
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
            <Label size={14} line={20} weight={500}>
              {props.item.name}
            </Label>
            <If when={props.phone}>{status()}</If>
            <Label size={12} line={16} tone="muted">
              {metadata()}
            </Label>
          </View>
          <If when={!props.phone}>{status()}</If>
        </View>
        <ActionMenu
          label={uiText("machineActions", { name: props.item.name })}
          triggerStyle={{
            minWidth: 24,
            width: 24,
            height: props.phone ? 28 : 24,
            paddingHorizontal: 0,
          }}
        >
          <ActionItem label={uiText("machineDetails")} onSelect={props.open} />
          <If when={host.can("machines.rename")}>
            <ActionItem
              label={uiText("machineRename")}
              onSelect={() => {
                name.set(props.item.name);
                renaming.set(true);
              }}
            />
          </If>
        </ActionMenu>
      </View>
      <If when={renaming()}>
        <Modal
          title={uiText("machineRename")}
          phone={props.phone}
          sheet={props.phone}
          onClose={() => renaming.set(false)}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Field
              label={uiText("machineName")}
              value={name()}
              onChange={name.set}
            />
            <Button
              label={uiText("save")}
              tone="primary"
              disabled={saving() || !name().trim()}
              onPress={() => void rename()}
            />
          </View>
        </Modal>
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
          />
        </If>
        <SectionHeader title={text("machines")} count={visible().length}>
          <If when={host.can("machines.phoneLink")}>
            <Button
              label={uiText("connectPhone")}
              onPress={() => pairing.set(true)}
            />
          </If>
          <If when={host.can("machines.enroll")}>
            <Button
              label={uiText("addMachine")}
              icon="plus"
              onPress={() => adding.set(true)}
            />
          </If>
        </SectionHeader>
        <Scroll style={grow} scrollbar={false}>
          <Each of={visible()} key={(item) => item.id}>
            {(item) => (
              <MachineRow
                item={item()}
                phone={phone()}
                open={() => machineId.set(item().id)}
              />
            )}
          </Each>
        </Scroll>
      </If>
      <If when={pairing()}>
        <PhonePairing phone={phone()} onClose={() => pairing.set(false)} />
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
