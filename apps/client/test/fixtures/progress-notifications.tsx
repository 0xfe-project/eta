import type {
  MachineInstallView,
  UpgradeStatusView,
} from "@eta/client-contracts";
import { mount, signal, Storage, View } from "nsh";
import { Button, colors, Label, row } from "../../src/components";
import { Chip } from "../../src/components/eta-editor/chip";
import { NotificationHost } from "../../src/components/notifications";
import {
  formatRemaining,
  startProgress,
} from "../../src/components/progress-notification";
import { space } from "../../src/components/tokens";
import { uiText } from "../../src/i18n";
import { HostRestartScreen } from "../../src/pages/connection/host-restart";
import { AddMachine } from "../../src/pages/settings/machines/add-machine";
import { createHost, Host } from "../../src/services/host";

function Fixture(props: { mode: string }) {
  const c = colors();
  const host = createHost();
  const page = signal<"page-a" | "page-b">("page-a");
  const cancelled = signal(0);
  const opened = signal(0);
  const chipProgress = signal<number | undefined>(undefined);
  const installs = signal<MachineInstallView[]>([]);
  const sent = signal<string[]>([]);

  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: ["upgrade.cancel", "machines.install"],
  }));
  host.list = ((target: string, section?: string) => {
    if (target === "machines" && section === "installs") return installs();
    return [];
  }) as typeof host.list;
  host.call = (async (target: string, action: string) => {
    sent.update((all) => [...all, `${target}.${action}`]);
    if (target === "machines" && action === "install") {
      installs.set([
        {
          id: "inst-1",
          host: "dev@gpu-box",
          step: "connect",
          error: null,
          machineId: null,
          startedAt: Date.now(),
        },
      ]);
      return { installId: "inst-1" };
    }
    return {};
  }) as typeof host.call;

  let handle: ReturnType<typeof startProgress> | undefined;

  return (
    <Host.Provider value={host}>
      <View
        style={{
          flex: 1,
          backgroundColor: c().canvas,
          padding: space[16],
          gap: space[12],
        }}
      >
        <If when={props.mode === "cross-page"}>
          <View style={{ ...row, gap: space[8] }}>
            <Button
              label="Switch page"
              onPress={() =>
                page.set(page() === "page-a" ? "page-b" : "page-a")
              }
            />
            <Button
              label="Start export"
              onPress={() => {
                handle = startProgress({
                  id: "export-pdf",
                  icon: "file",
                  title: "Export PDF",
                  detail: "Quarterly report",
                  progress: 0.25,
                  onCancel: () => cancelled.update((n) => n + 1),
                });
              }}
            />
            <Button
              label="Advance export"
              onPress={() => handle?.update({ progress: 0.5 })}
            />
            <Button
              label="Finish export"
              onPress={() =>
                handle?.complete({
                  title: "Export PDF",
                  detail: "Saved quarterly.pdf",
                  onOpen: () => opened.update((n) => n + 1),
                })
              }
            />
            <Button
              label="Start host download"
              onPress={() => {
                const status: UpgradeStatusView = {
                  id: "u-host",
                  state: "running",
                  phase: "downloading",
                  from: "0.9.0",
                  to: "0.9.1",
                  startedAt: Date.now(),
                  download: { received: 100_000_000, total: 200_000_000 },
                  log: [],
                };
                host.upgrade.set(status);
              }}
            />
            <Button
              label="Host restarting"
              onPress={() => {
                const status: UpgradeStatusView = {
                  id: "u-host",
                  state: "running",
                  phase: "restarting",
                  from: "0.9.0",
                  to: "0.9.1",
                  startedAt: Date.now(),
                  log: [],
                };
                host.upgrade.set(status);
              }}
            />
          </View>
          <Label>{`Active page: ${page()}`}</Label>
          <Label>{`Cancelled: ${cancelled()}`}</Label>
          <Label>{`Opened: ${opened()}`}</Label>
          <Label>{`Sent: ${sent().join(",")}`}</Label>
          <Label>{`ETA sample: ${formatRemaining(90_000)}`}</Label>
          <HostRestartScreen onConnect={() => {}} />
        </If>

        <If when={props.mode === "chip"}>
          <View style={{ ...row, gap: space[8] }}>
            <Button label="Upload 40%" onPress={() => chipProgress.set(0.4)} />
            <Button label="Upload 85%" onPress={() => chipProgress.set(0.85)} />
            <Button
              label="Upload done"
              onPress={() => chipProgress.set(undefined)}
            />
          </View>
          <View testID="chip-wrap" style={{ alignSelf: "flex-start" }}>
            <Chip
              label="design-spec.pdf"
              icon="file"
              status={
                chipProgress() !== undefined ? uiText("uploading") : undefined
              }
              progress={chipProgress()}
              accessibilityLabel="design-spec.pdf"
            />
          </View>
        </If>

        <If when={props.mode === "ssh"}>
          <View style={{ ...row, gap: space[8] }}>
            <Button
              label="Finish install"
              onPress={() =>
                installs.set([
                  {
                    id: "inst-1",
                    host: "dev@gpu-box",
                    step: "done",
                    error: null,
                    machineId: "m-1",
                    startedAt: Date.now(),
                  },
                ])
              }
            />
          </View>
          <View style={{ flex: 1 }}>
            <AddMachine phone={false} onClose={() => {}} />
          </View>
        </If>

        <NotificationHost />
      </View>
    </Host.Provider>
  );
}

void Storage.getItem("mode").then((mode) =>
  mount(() => <Fixture mode={mode ?? "cross-page"} />),
);
