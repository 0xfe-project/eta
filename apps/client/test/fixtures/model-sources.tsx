import type {
  LlmAccounts,
  SourceSummariesVisit,
  SourceSummaryUpdate,
} from "@eta/client-contracts";
import type { WireEvent } from "@eta/client-contracts/wire";
import { mount, Text, signal, View, windowSize, UrlScheme } from "nsh";
import { createHost, Host } from "../../src/services/host";
import { Settings } from "../../src/pages/settings/settings";

function Fixture() {
  const host = createHost();
  const calls = signal("");
  const mounted = signal(true);
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
        : ["billing.startSourceSummaries"],
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
  let releaseFirst: (() => void) | undefined;
  let releaseCurrent: (() => void) | undefined;
  let listener: ((event: WireEvent) => void) | undefined;
  host.onEvent = (target, callback) => {
    if (target !== "billing") throw new Error("unexpected event target");
    listener = callback;
    return () => {
      if (listener === callback) listener = undefined;
    };
  };
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    if (action === "startSourceSummaries") {
      const { visitId } = args as SourceSummariesVisit;
      if (target !== "billing" || !visitId)
        throw new Error("unexpected billing call");
      const visit = ++visits;
      calls.set(`visits ${visit}`);
      if (mode === "offline") throw new Error("offline");
      const send = (summary: SourceSummaryUpdate) =>
        listener?.({ name: "sourceSummary", data: { ...summary, visitId } });
      const account = (id: string, usedPercent: number) =>
        send({
          source: "account",
          id,
          quotaRevision: id,
          value: {
            quota: { period: "weekly", usedPercent },
          },
        });
      const balances = () =>
        send({
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
        });
      const done = () =>
        listener?.({ name: "sourceSummariesDone", data: { visitId } });
      const finish = () => {
        balances();
        account("one", 37.5);
        account("two", 0);
        done();
      };
      if (visit === 1 && mode === "race") releaseFirst = finish;
      else if (visit === 2 && mode === "stale") {
        releaseCurrent = () => {
          send({
            source: "provider",
            id: "source",
            balanceRevision: "first",
            value: null,
          });
          account("one", 42);
          done();
          account("two", 99);
        };
      } else finish();
      return {} as T;
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
          onPress={() => releaseFirst?.()}
        >
          <Text>Release first</Text>
        </View>
        <View role="button" onPress={() => releaseCurrent?.()}>
          <Text>Release current</Text>
        </View>
        <View
          role="button"
          onPress={() =>
            host.state.update((prev) => ({
              ...prev,
              status: prev.status === "open" ? "reconnecting" : "open",
            }))
          }
        >
          <Text>Toggle connection</Text>
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

        <View role="button" onPress={() => mounted.update((value) => !value)}>
          <Text>Toggle settings</Text>
        </View>
        <If when={mounted()}>
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
        </If>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
