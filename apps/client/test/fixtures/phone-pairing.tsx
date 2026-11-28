import type { MachineResults, MachineView } from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View, windowSize } from "nsh";
import { Machines } from "../../src/pages/settings/machines/machines";
import { createHost, Host } from "../../src/services/host";

const now = Date.now();

const primaryMachine: MachineView = {
  id: "m-primary",
  name: "studio",
  kind: "primary",
  status: "online",
  fingerprint: null,
  home: "/Users/ada",
  os: "darwin",
  maxActiveRuns: 2,
  createdAt: now,
  lastSeenAt: now,
  version: "1.0.0",
  platform: "darwin-arm64",
  install: null,
  protocol: 1,
  updateError: null,
  tailnetNode: null,
  build: null,
};

function initialAddressesFor(scenario: string): MachineResults["addresses"] {
  if (scenario === "multi-route") {
    return {
      tailnet: "https://mac.tail.ts.net",
      routes: [
        {
          kind: "tailscale_https",
          url: "https://mac.tail.ts.net",
          label: "Tailscale HTTPS",
          reachable: true,
        },
        {
          kind: "lan",
          url: "http://192.168.1.10:8787",
          label: "LAN",
          reachable: true,
        },
        {
          kind: "loopback",
          url: "http://127.0.0.1:8787",
          label: "Local",
          reachable: false,
        },
      ],
      preferredUrl: "https://mac.tail.ts.net",
      listeningHost: "0.0.0.0",
      port: 8787,
      tailscaleServe: {
        installed: true,
        running: true,
        magicDnsName: "mac.tail.ts.net",
        httpsCapable: true,
        enabled: true,
        activeUrl: "https://mac.tail.ts.net",
        port: 443,
        holderStatus: "ours",
      },
    };
  }
  return {
    tailnet: null,
    routes: [
      {
        kind: "loopback",
        url: "http://127.0.0.1:8787",
        label: "Local",
        reachable: false,
      },
    ],
    preferredUrl: null,
    listeningHost: "127.0.0.1",
    port: 8787,
    tailscaleServe: {
      installed: true,
      running: true,
      magicDnsName: "mac.tail.ts.net",
      httpsCapable: true,
      enabled: false,
      activeUrl: null,
      port: 443,
      holderStatus: "none",
    },
  };
}

function Fixture() {
  const host = createHost();
  const scenario = UrlScheme.url()?.split("/").at(-1) ?? "loopback";
  let currentAddresses = initialAddressesFor(scenario);
  const calls = signal<string[]>([]);
  const lastTailscaleTimeout = signal("");
  const log: string[] = [];
  let probeFailureCount = 0;

  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops: [
      "machines.addresses",
      "machines.phoneLink",
      "machines.setTailscaleServe",
      "machines.enroll",
    ],
    targets: {
      machines: {
        version: 1,
        revisions: {},
        sections: { list: [primaryMachine] },
      },
    },
  }));

  host.call = async <T,>(
    target: string,
    action: string,
    args?: unknown,
    options?: { timeoutMs?: number },
  ) => {
    log.push(`${target}.${action} ${JSON.stringify(args ?? {})}`);
    calls.set([...log]);
    if (action === "setTailscaleServe" && options?.timeoutMs !== undefined) {
      lastTailscaleTimeout.set(`timeoutMs=${options.timeoutMs}`);
    }
    if (action === "addresses") return currentAddresses as T;
    if (action === "phoneLink") {
      const given = (args ?? {}) as { url?: string };
      const url =
        given.url ?? currentAddresses.preferredUrl ?? "http://127.0.0.1:8787";
      return {
        url,
        link: `eta://connect?address=${encodeURIComponent(url)}&token=test-tok`,
      } as T;
    }
    if (action === "setTailscaleServe") {
      const given = (args ?? {}) as { enabled: boolean; port?: number };
      const port = given.port ?? 443;
      if (
        given.enabled &&
        scenario === "probe-failed" &&
        probeFailureCount === 0
      ) {
        probeFailureCount += 1;
        const result: MachineResults["setTailscaleServe"] = {
          ok: false,
          tailscaleServe: {
            ...currentAddresses.tailscaleServe,
            enabled: false,
            activeUrl: null,
            port,
            holderStatus: "none",
            diagnostic: "probe-failed",
            error: `Tailscale HTTPS verification failed on port ${port} (/.well-known/eta/host could not be reached), so Tailscale Serve was rolled back. Ensure HTTPS certificates are enabled on your tailnet and try again.`,
          },
          routes: currentAddresses.routes,
          preferredUrl: currentAddresses.preferredUrl,
        };
        currentAddresses = {
          ...currentAddresses,
          tailscaleServe: result.tailscaleServe,
        };
        return result as T;
      }
      if (given.enabled && scenario === "probe-failed-ours") {
        const result: MachineResults["setTailscaleServe"] = {
          ok: false,
          tailscaleServe: {
            ...currentAddresses.tailscaleServe,
            enabled: false,
            activeUrl: null,
            port,
            holderStatus: "ours",
            diagnostic: "probe-failed",
            error: `Tailscale Serve is still active on HTTPS port ${port} (rollback failed), and /.well-known/eta/host could not be verified. Check Tailscale permissions, then retry or turn Tailscale HTTPS off.`,
          },
          routes: currentAddresses.routes,
          preferredUrl: currentAddresses.preferredUrl,
        };
        currentAddresses = {
          ...currentAddresses,
          tailscaleServe: result.tailscaleServe,
        };
        return result as T;
      }
      if (given.enabled && scenario === "port-busy" && port === 443) {
        const result: MachineResults["setTailscaleServe"] = {
          ok: false,
          tailscaleServe: {
            ...currentAddresses.tailscaleServe,
            enabled: false,
            activeUrl: null,
            port: 443,
            holderStatus: "other",
            diagnostic: "port-occupied",
            error: "Port 443 is occupied.",
          },
          routes: currentAddresses.routes,
          preferredUrl: currentAddresses.preferredUrl,
        };
        currentAddresses = {
          ...currentAddresses,
          tailscaleServe: result.tailscaleServe,
        };
        return result as T;
      }
      if (given.enabled) {
        const activeUrl =
          port === 443
            ? "https://mac.tail.ts.net"
            : `https://mac.tail.ts.net:${port}`;
        const routes: MachineResults["addresses"]["routes"] = [
          {
            kind: "tailscale_https",
            url: activeUrl,
            label: "Tailscale HTTPS",
            reachable: true,
          },
          ...currentAddresses.routes.filter(
            (route) => route.kind !== "tailscale_https",
          ),
        ];
        const result: MachineResults["setTailscaleServe"] = {
          ok: true,
          tailscaleServe: {
            ...currentAddresses.tailscaleServe,
            enabled: true,
            activeUrl,
            port,
            holderStatus: "ours",
            diagnostic: undefined,
            error: undefined,
          },
          routes,
          preferredUrl: activeUrl,
        };
        currentAddresses = {
          ...currentAddresses,
          tailnet: activeUrl,
          routes,
          preferredUrl: activeUrl,
          tailscaleServe: result.tailscaleServe,
        };
        return result as T;
      }
      const routes = currentAddresses.routes.filter(
        (route) => route.kind !== "tailscale_https",
      );
      const preferredUrl = routes.find((route) => route.reachable)?.url ?? null;
      const result: MachineResults["setTailscaleServe"] = {
        ok: true,
        tailscaleServe: {
          ...currentAddresses.tailscaleServe,
          enabled: false,
          activeUrl: null,
          port: 443,
          holderStatus: "none",
          diagnostic: undefined,
          error: undefined,
        },
        routes,
        preferredUrl,
      };
      currentAddresses = {
        ...currentAddresses,
        tailnet: null,
        routes,
        preferredUrl,
        tailscaleServe: result.tailscaleServe,
      };
      return result as T;
    }
    return {} as T;
  };

  const width = windowSize().width;
  const layout = width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop";
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{calls().join("\n")}</Text>
        <Machines
          machines={[primaryMachine]}
          layout={layout}
          onTask={() => {}}
          onBack={() => {}}
        />
        <If when={lastTailscaleTimeout()}>
          <Text>{lastTailscaleTimeout()}</Text>
        </If>
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
