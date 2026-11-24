import type { MarketSettings } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Button } from "../../src/components";
import { PluginSettings } from "../../src/pages/settings/plugins";
import { createHost, Host } from "../../src/services/host";

/** A host whose first answer about the sources is held until a button lets it go: the page before its data came. */
const full: MarketSettings = {
  sources: [
    {
      name: "Cursor",
      url: "https://cursor.test/marketplace.json",
      enabled: true,
    },
  ],
  proxy: "https://proxy.test/",
};
let release: ((settings: MarketSettings) => void) | undefined;

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: (_section: string, method: string) => {
      if (method !== "marketSettings") return Promise.resolve({});
      return new Promise<MarketSettings>((resolve) => {
        release = resolve;
      });
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row" }}>
          <Button label="answer with sources" onPress={() => release?.(full)} />
          <Button
            label="answer with none"
            onPress={() => release?.({ sources: [], proxy: "" })}
          />
        </View>
        <PluginSettings />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
