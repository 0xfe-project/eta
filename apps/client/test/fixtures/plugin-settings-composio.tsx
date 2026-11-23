import { mount, View } from "nsh";
import { PluginSettings } from "../../src/pages/settings/plugins";
import { createHost, Host } from "../../src/services/host";

/** A host that keeps a Composio key the way the real one does: it says only that one is set. */
let hasKey = false;
/** The Composio source is on only with a key, as the real host lists it (unless switched off by hand). */
const sources = () => [
  {
    name: "Composio",
    url: "composio",
    enabled: hasKey,
    kind: "composio" as const,
  },
  { name: "", url: "https://plain.test/marketplace.json", enabled: true },
];

mount(() => {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: async (_section: string, method: string, args: { key?: string }) => {
      if (method === "composioSetKey") hasKey = (args.key ?? "") !== "";
      if (method === "composioClearKey") hasKey = false;
      if (method.startsWith("composio")) return { hasKey };
      return { sources: sources(), proxy: "" };
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <PluginSettings />
      </View>
    </Host.Provider>
  );
});
