import type { LlmAccounts, LlmQuota } from "@eta/client-contracts";
import { mount, Text, signal, View, windowSize, UrlScheme } from "nsh";
import { createHost, Host } from "../../src/services/host";
import { Settings } from "../../src/pages/settings/settings";

function Fixture() {
  const host = createHost();
  const calls = signal("");
  const multi = UrlScheme.url()?.endsWith("multi");
  const connections: LlmAccounts["connections"] = (
    multi ? ["one", "two", "three", "four"] : ["one"]
  ).map((id) => ({
    id,
    label: id === "four" ? "Other" : "Lab",
    connector: "codex",
    state: "active",
    createdAt: "2026-01-01",
  }));
  const quota: LlmQuota[] = connections
    .map<LlmQuota>(({ id }, index) => ({
      connectionId: id,
      observedAt: new Date().toISOString(),
      windows:
        index === 2
          ? []
          : [
              { kind: "5h", used: 88 },
              { kind: "weekly", used: 79 },
              ...(index === 3
                ? []
                : [{ kind: "monthly" as const, used: index ? 0 : 37.5 }]),
              ...(multi && index === 0
                ? [{ kind: "monthly" as const, used: 99.99 }]
                : []),
            ],
      ...(index === 2
        ? { error: { code: "login_expired" as const, message: "sign in" } }
        : {}),
    }))
    .reverse();
  const configured = {
    id: "source",
    kind: "deepseek",
    name: "Source",
    baseUrl: "https://api.deepseek.com",
    hasApiKey: true,
    models: [{ id: "model" }],
  };
  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops: ["providers.readBalance", "llm.refresh"],
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
          quota,
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
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    calls.set(target + "." + action);
    const refresh = (args as { refresh?: boolean })?.refresh;
    if (action === "readBalance")
      return (
        refresh
          ? {
              state: "available",
              observedAt: new Date().toISOString(),
              lines: [{ currency: "USD", available: "0" }],
              partial: true,
            }
          : { state: "query" }
      ) as T;
    if (action === "check")
      return {
        checks: { source: { state: "ok", checkedAt: "2026-01-01" } },
      } as T;
    return {} as T;
  };
  const width = windowSize().width;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{calls()}</Text>
        <Settings
          initial="Model services"
          layout={width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop"}
          theme="light"
          chatWidth="standard"
          chatRail
          onTheme={noop}
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
