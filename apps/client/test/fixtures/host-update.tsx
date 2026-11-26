import type {
  MachineView,
  UpgradeCheckView,
  UpgradeStatusView,
} from "@eta/client-contracts";
import { mount, signal, Storage, Text, View } from "nsh";
import { NotificationHost } from "../../src/components/notifications";
import { HostRestartScreen } from "../../src/pages/connection/host-restart";
import { Machines } from "../../src/pages/settings/machines/machines";
import { UpdateSettings } from "../../src/pages/settings/updates/update";
import { createHost, Host } from "../../src/services/host";

// Settings › Update (or Machines, storage `page`) with the full-window screen over it, on a Host
// whose upgrade the test moves along with the buttons at the top: each sets what
// `/upgrade/status` says, "Gone" and "Back" take the Host away and bring it back, "Machine …"
// sets gpu-box's row. "Sent: …" lists the calls the page made. Storage `script` presses them on
// the clock instead ("Restarting@0,Done@1000"), for what happens under the covering screen.

const start = Date.now();
const base: UpgradeStatusView = {
  id: "u1",
  state: "running",
  phase: "starting",
  from: "0.9.0",
  to: "0.9.1",
  startedAt: start,
  log: [],
};

const statuses: Record<string, Partial<UpgradeStatusView>> = {
  Downloading: {
    phase: "downloading",
    download: { received: 243_500_000, total: 391_600_000 },
  },
  Waiting: {
    phase: "waiting",
    busy: [{ kind: "task", number: 1, name: "Write the release notes" }],
  },
  Restarting: { phase: "restarting" },
  "Rolling back": { id: "u2", to: "0.9.3", phase: "rolling-back" },
  Done: { state: "done", phase: "verifying", finishedAt: start },
  Failed: {
    id: "u3",
    to: "0.9.5",
    state: "failed",
    phase: "downloading",
    finishedAt: start,
    error: "the checksum of eta-host-linux-x64 does not match SHA256SUMS",
  },
  "Rolled back": {
    id: "u2",
    to: "0.9.3",
    state: "rolled-back",
    phase: "rolling-back",
    finishedAt: start,
    error: "0.9.3 did not hold (it exited after coming up)",
  },
  Broken: {
    id: "u2",
    to: "0.9.3",
    state: "broken",
    phase: "rolling-back",
    finishedAt: start,
    error: "restoring the database failed",
  },
  Cancelled: {
    id: "u4",
    state: "cancelled",
    phase: "waiting",
    finishedAt: start,
  },
  Lost: { id: "u5", state: "lost", phase: "backing-up" },
};

const check: UpgradeCheckView = {
  version: "0.9.0",
  latest: "0.9.1",
  available: true,
  prerelease: false,
  heldOnPrerelease: false,
  blocked: null,
  busy: [],
  upstream: {
    label: "0xfe-project/eta",
    source: "build",
    saved: null,
    fallback: "0xfe-project/eta",
  },
  token: { host: null, from: null, saved: null },
  notes: null,
  error: null,
};

const gpu: MachineView = {
  id: "m-gpu",
  name: "gpu-box",
  kind: "daemon",
  status: "online",
  fingerprint: "sha256:gpu",
  home: "/home/dev",
  os: "linux",
  maxActiveRuns: 2,
  createdAt: start,
  lastSeenAt: start,
  version: "0.8.9",
  platform: "linux-x64",
  install: "service",
  protocol: 1,
  updateError: null,
  tailnetNode: null,
  build: "outdated",
};

function Fixture(props: { page: string; script: string }) {
  const host = createHost();
  const sent = signal<string[]>([]);
  const machine = signal<MachineView>(gpu);
  const open = (status: "open" | "reconnecting") =>
    host.state.update((state) => ({
      ...state,
      status,
      ops: ["upgrade.start", "upgrade.cancel", "machines.upgrade"],
    }));
  open("open");
  host.upgradeCheck.set(check);
  host.call = (async (target: string, action: string) => {
    sent.set([...sent(), `${target}.${action}`]);
    if (target === "upgrade" && action === "start") return { id: "u1" };
    return {};
  }) as typeof host.call;
  const set = (name: string) =>
    host.upgrade.set({ ...base, ...statuses[name] } as UpgradeStatusView);
  const button = (label: string, press: () => void) => (
    <View role="button" accessibilityLabel={label} onPress={press}>
      <Text>{label}</Text>
    </View>
  );
  const actions: Record<string, () => void> = {
    Gone: () => {
      host.upgradeUnreachable.set(true);
      open("reconnecting");
    },
    Back: () => {
      host.upgradeUnreachable.set(false);
      open("open");
    },
  };
  for (const step of props.script.split(",").filter(Boolean)) {
    const [name, at] = step.split("@");
    setTimeout(() => (actions[name!] ?? (() => set(name!)))(), Number(at));
  }
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Each of={Object.keys(statuses)} key={(name) => name}>
            {(name) => button(name(), () => set(name()))}
          </Each>
          {button("Gone", actions.Gone!)}
          {button("Back", actions.Back!)}
          {button("Machine updating", () =>
            machine.set({ ...machine(), build: "updating" }),
          )}
          {button("Machine updated", () =>
            machine.set({ ...machine(), build: "current", version: "0.9.0" }),
          )}
          {button("Machine failed", () =>
            machine.set({
              ...machine(),
              build: "outdated",
              updateError:
                "it is not run by a service, so it cannot restart itself",
            }),
          )}
          <Text>{`Sent: ${sent().join(", ")}`}</Text>
        </View>
        <If
          when={props.page === "machines"}
          else={<UpdateSettings layout="desktop" onConnect={noop} />}
        >
          <Machines
            machines={[machine()]}
            layout="desktop"
            onTask={noop}
            onBack={noop}
          />
        </If>
        <NotificationHost />
        <HostRestartScreen onConnect={noop} />
      </View>
    </Host.Provider>
  );
}

void Promise.all([Storage.getItem("page"), Storage.getItem("script")]).then(
  ([page, script]) =>
    mount(() => <Fixture page={page ?? "update"} script={script ?? ""} />),
);
