import { mount, View } from "nsh";
import { Button } from "../../src/components";
import { PluginSettings } from "../../src/pages/settings/plugins";
import { createHost, Host } from "../../src/services/host";

/** A host that lists the Composio source at once but holds the answer about its key until a button lets it go. */
let release: ((status: { hasKey: boolean }) => void) | undefined;

mount(() => {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: (_section: string, method: string) => {
      if (method === "composioStatus")
        return new Promise<{ hasKey: boolean }>((resolve) => {
          release = resolve;
        });
      return Promise.resolve({
        sources: [
          {
            name: "Composio",
            url: "composio",
            enabled: true,
            kind: "composio" as const,
          },
        ],
        proxy: "",
      });
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row" }}>
          <Button
            label="answer with a key"
            onPress={() => release?.({ hasKey: true })}
          />
          <Button
            label="answer with no key"
            onPress={() => release?.({ hasKey: false })}
          />
        </View>
        <PluginSettings />
      </View>
    </Host.Provider>
  );
});
