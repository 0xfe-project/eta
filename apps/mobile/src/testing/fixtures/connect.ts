// Design 08 and 10b. Scenarios: `uninitialized` (08c; with `eta.fake.live` in storage its steps
// finish on their own), `blip` (the connection drops and comes back: 08b), `drop` (it stays down:
// 08b′), `real-version` (`GET /version` goes to the network, for a test to stub).

import type { MachineView, ProvidersView } from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { Storage } from "nsh";
import { useVersionReader } from "../../features/settings/version";
import { AGENTS, CONVERSATIONS, MACHINES, minutesAgo } from "./base";

export const LIVE_KEY = "eta.fake.live";

const PROVIDERS: ProvidersView = {
  revision: "r1",
  providers: [{ id: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com", hasApiKey: true, models: [{ id: "deepseek-chat" }] }],
};

function designMachines(): MachineView[] {
  const base = (id: string) => MACHINES.find((machine) => machine.id === id) as MachineView;
  const primary = { ...base("mac-studio"), os: "darwin" };
  const daemon = { ...base("mb-air"), os: "darwin" };
  return [
    primary,
    { ...daemon, maxActiveRuns: 2, version: "0.8.0", build: "outdated" },
    { ...daemon, id: "gpu-box", name: "gpu-box", os: "linux", version: "0.8.2" },
    { ...daemon, id: "nas", name: "nas", status: "offline", lastSeenAt: minutesAgo(6 * 60), version: "0.8.2" },
    {
      ...daemon,
      id: "workstation",
      name: "workstation",
      status: "pending",
      version: null,
      build: null,
      lastSeenAt: null,
    },
  ];
}

/** The connection drops `after` ms into the first hello, and comes back `upAfter` ms later, if ever. */
function flaky(host: FakeHost, after: number, upAfter?: number): void {
  const open = host.socket.bind(host);
  let down = false;
  let armed = false;
  host.socket = (refused) => {
    const socket = open(down ? "network" : refused);
    const onClose = socket.onClose;
    let drop: () => void = () => undefined;
    socket.onClose = (listener) => {
      onClose(listener);
      drop = listener;
    };
    if (!armed) {
      armed = true;
      setTimeout(() => {
        down = true;
        socket.close();
        drop();
        if (upAfter !== undefined) setTimeout(() => (down = false), upAfter);
      }, after);
    }
    return socket;
  };
}

function finishSetup(host: FakeHost): void {
  setTimeout(() => host.patch("providers", "config", PROVIDERS), 2000);
  setTimeout(() => {
    host.patch("conversations", "list", CONVERSATIONS);
    host.patch("agents", "list", AGENTS);
  }, 4000);
}

export function installConnect(host: FakeHost): void {
  host.patch("machines", "list", designMachines());
  const bare = host.scenario === "uninitialized";
  host.set("providers", { config: bare ? { revision: "r0", providers: [] } : PROVIDERS });
  if (host.scenario !== "real-version") useVersionReader(async () => "0.8.2");
  if (host.scenario === "blip") flaky(host, 300, 2000);
  if (host.scenario === "drop") flaky(host, 300);
  if (bare) {
    void Storage.getItem(LIVE_KEY).then((live) => {
      if (live !== null && live !== undefined) finishSetup(host);
    });
  }
}
