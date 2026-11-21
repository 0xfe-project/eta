import type { LlmLogin } from "@eta/client-contracts";
import { WireError } from "@eta/client-contracts/wire";
import { mount, signal, Text, UrlScheme, View, windowSize } from "nsh";
import { Settings } from "../../src/pages/settings/settings";
import { createHost, Host } from "../../src/services/host";

// Settings › Model services with no source yet, over a scripted host. What the host answers:
// - `providers.discover`: the key `sk-good` lists three models (one deprecated) and one the client
//   cannot speak; any other key is refused (401). The address `http://down/v1` cannot be reached.
// - `providers.save` and `providers.check`: recorded.
// - `llm.loginStart` for a device-code connector: a pending code. `loginPoll` keeps it pending,
//   unless the fixture's address ends in `/approve` (succeeded) or `/deny` (failed).
// - `llm.loginSubmit` (Google AI Studio): `good-key` succeeds, any other key is refused.
// Every call is listed under the page as `target.action args`, newest last.

function Fixture() {
  const host = createHost();
  const calls = signal<string[]>([]);
  const ending = UrlScheme.url()?.split("/").at(-1);
  let polls = 0;
  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops: ["llm.refresh"],
    targets: {
      llm: {
        version: 1,
        revisions: {},
        sections: {
          accounts: {
            ready: true,
            connections: [],
            connectors: [
              { id: "codex", name: "Codex", flow: "oauth_device" },
              { id: "xai", name: "Grok", flow: "oauth_device" },
              { id: "gemini", name: "Google AI Studio", flow: "api_key" },
            ],
          },
          quota: [],
          models: [
            {
              id: "gpt-5.5",
              connector: "codex",
              name: "GPT-5.5",
              contextWindow: 400000,
              status: "available",
              available: true,
            },
            {
              id: "gpt-5.4-mini",
              connector: "codex",
              name: "GPT-5.4 mini",
              contextWindow: 400000,
              status: "available",
              available: true,
            },
          ],
        },
      },
      providers: {
        version: 1,
        revisions: {},
        sections: { config: { revision: "r1", providers: [] } },
      },
    },
  }));
  const login = (connector: string, status: LlmLogin["status"]): LlmLogin => ({
    id: `login-${connector}`,
    connector,
    flow: connector === "gemini" ? "api_key" : "oauth_device",
    status,
    ...(connector === "gemini"
      ? {}
      : { url: "https://example.com/device", userCode: "ABCD-1234" }),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...(status === "failed"
      ? { error: { code: "login_failed", message: "denied" } }
      : {}),
  });
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    calls.update((list) => [
      ...list,
      `${target}.${action} ${JSON.stringify(args ?? {})}`,
    ]);
    const input = (args ?? {}) as Record<string, string>;
    if (target === "providers" && action === "discover") {
      if (input.baseUrl === "http://down/v1")
        throw new WireError("server", "discovery_network");
      if (!input.kind!.startsWith("openai-") && input.apiKey !== "sk-good")
        throw new WireError("server", "discovery_http_401");
      return {
        models: [
          {
            id: "alpha-large",
            name: "Alpha Large",
            contextWindow: 200000,
            reasoning: true,
          },
          { id: "alpha-small", name: "Alpha Small", contextWindow: 128000 },
          { id: "alpha-old", name: "Alpha Old", deprecated: true },
        ],
        unsupported: [
          {
            id: "beta-msg",
            name: "Beta Messages",
            protocol: "@ai-sdk/anthropic",
            reason: "protocol",
          },
        ],
      } as T;
    }
    if (target === "llm" && action === "loginStart")
      return { login: login(input.connector!, "pending") } as T;
    if (target === "llm" && action === "loginPoll") {
      polls++;
      const status =
        ending === "approve" && polls >= 1
          ? "succeeded"
          : ending === "deny"
            ? "failed"
            : "pending";
      return { login: login(input.id!.replace("login-", ""), status) } as T;
    }
    if (target === "llm" && action === "loginSubmit") {
      if (input.apiKey !== "good-key")
        throw new WireError("server", "The API key is invalid.", {
          code: "invalid_api_key",
        });
      return { login: login("gemini", "succeeded") } as T;
    }
    return {} as T;
  };
  const width = windowSize().width;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Settings
          initial="Model services"
          layout={width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop"}
          theme="light"
          paletteId="default"
          flavor="mocha"
          chatWidth="standard"
          chatRail
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
        <View accessibilityLabel="Calls">
          <Each of={calls()}>{(call) => <Text>{call()}</Text>}</Each>
        </View>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
