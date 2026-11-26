import type { MarketCatalog } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Label } from "../../src/components";
import { Market } from "../../src/pages/plugins/market";
import { createHost, Host } from "../../src/services/host";

const empty: MarketCatalog = { proxy: "", sources: [] };
function Fixture() {
  const host = createHost();
  const catalog = empty;
  host.state.update((state) => ({ ...state, status: "open" }));
  const stub = Object.assign(host, {
    call: async () => catalog,
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Market
          onSettings={() => {}}
          layout="desktop"
          tabs={() => <Label>tabs</Label>}
        />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
