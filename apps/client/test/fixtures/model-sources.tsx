import type { LlmAccounts, SourceSummaries } from "@eta/client-contracts";
import { mount, Text, signal, View, windowSize, UrlScheme } from "nsh";
import { createHost, Host } from "../../src/services/host";
import { Settings } from "../../src/pages/settings/settings";

function Fixture() {
  const host = createHost();
  const calls = signal("");
  const mode = UrlScheme.url()?.split("/").pop();
  const connections: LlmAccounts["connections"] = ["one", "two"].map((id) => ({
    id,
    label: id === "one" ? "Lab" : "Other",
    connector: "codex",
    state: "active",
    quotaRevision: id,
    plan: "Team",
    createdAt: "2026-01-01",
  }));
  const configured = {
    id: "source",
    balanceRevision: "first",
    kind: "deepseek",
    name: "Source",
    baseUrl: "https://api.deepseek.com",
    hasApiKey: true,
    models: [{ id: "model" }],
  };
  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops:
      mode === "legacy"
        ? ["providers.readBalance"]
        : ["billing.readSourceSummaries"],
    targets: {
      llm: {
        version: 1,
        revisions: {},
        sections: {
          accounts: {
            ready: true,
            connections,
            connectors: [{ id: "codex", name: "Codex", flow: "oauth_device" }],
          },
          quota: [],
          models: [],
        },
      },
      providers: {
        version: 1,
        revisions: {},
        sections: { config: { revision: "r1", providers: [configured] } },
      },
    },
  }));
  let visits = 0;
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    if (action === "readSourceSummaries") {
      if (target !== "billing" || JSON.stringify(args) !== "{}")
        throw new Error("unexpected billing call");
      const visit = ++visits;
      calls.set(`visits ${visit}`);
      if (visit === 1 && mode === "race") await delayed;
      if (mode === "offline") throw new Error("offline");
      const result: SourceSummaries = {
        items: [
          {
            source: "account",
            id: "one",
            quotaRevision: "one",
            value: { monthly: { usedPercent: 37.5 } },
          },
          {
            source: "account",
            id: "two",
            quotaRevision: "two",
            value: { monthly: { usedPercent: 0 } },
          },
          {
            source: "provider",
            id: "source",
            balanceRevision: "first",
            value: {
              balance: {
                lines: [
                  { currency: "USD", available: String(visit) },
                  { currency: "CNY", available: "0" },
                ],
              },
            },
          },
        ],
      };
      return result as T;
    }
    calls.set(target + "." + action);
    if (action === "check")
      return {
        checks: { source: { state: "ok", checkedAt: "2026-01-01" } },
      } as T;
    return {} as T;
  };
  function setProvider(revision?: string) {
    host.state.update((prev) => ({
      ...prev,
      targets: {
        ...prev.targets,
        providers: {
          version: 2,
          revisions: {},
          sections: {
            config: {
              revision: "r2",
              providers: revision
                ? [{ ...configured, balanceRevision: revision }]
                : [],
            },
          },
        },
      },
    }));
  }
  const width = windowSize().width;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{calls()}</Text>
        <View
          role="button"
          accessibilityLabel="Release first"
          onPress={() => release?.()}
        >
          <Text>Release first</Text>
        </View>
        <View
          role="button"
          accessibilityLabel="Switch Host"
          onPress={() => host.address.set({ origin: "http://second.test" })}
        >
          <Text>Switch Host</Text>
        </View>
        <View
          role="button"
          accessibilityLabel="Rotate"
          onPress={() => setProvider("second")}
        >
          <Text>Rotate</Text>
        </View>
        <View role="button" onPress={() => setProvider()}>
          <Text>Remove row</Text>
        </View>
        <View role="button" onPress={() => setProvider("first")}>
          <Text>Restore row</Text>
        </View>

        <Settings
          initial="Model services"
          layout={width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop"}
          theme="light"
          chatWidth="standard"
          chatRail
          paletteId="default"
          flavor="mocha"
          onTheme={noop}
          onPalette={noop}
          onFlavor={noop}
          onChatWidth={noop}
          onChatRail={noop}
          onFonts={noop}
          onConnect={noop}
          onTask={noop}
          onClose={noop}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
