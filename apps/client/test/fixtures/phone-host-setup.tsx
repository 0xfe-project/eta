import type { Layout } from "../../src/components";
import { mount, signal, Storage, Text, View, windowSize } from "nsh";
import { createSavedHosts, SavedHosts } from "../../src/app/saved-hosts";
import { Workspace } from "../../src/app/workspace";
import { Screen } from "../../src/components";
import { ReconnectingBanner } from "../../src/pages/connection/reconnecting-banner";
import { createHost, Host } from "../../src/services/host";

function Fixture(props: { mode: string }) {
  const host = createHost();
  const savedHosts = createSavedHosts({ syncLegacy: false });
  const connectClicks = signal(0);
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";

  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });

  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: list([]),
      projects: list([]),
      conversations: list([]),
      providers: {
        sections: {
          config: {
            revision: "1",
            providers: [],
            privateNetwork: { allow: [], loopback: false, invalid: [] },
          },
        },
        revisions: {},
        version: 0,
      },
    },
  }));
  host.address.set({ origin: "https://vps-a.example.com" });
  const noop = () => {};

  return (
    <Host.Provider value={host}>
      <SavedHosts.Provider value={savedHosts}>
        <Screen.Provider value={layout}>
          <View style={{ flex: 1 }}>
            <View
              style={{
                flexDirection: "row",
                gap: 8,
                paddingHorizontal: 8,
                paddingVertical: 4,
              }}
            >
              <Text>{`Connect clicks: ${connectClicks()}`}</Text>
              <View
                role="button"
                accessibilityLabel="Switch to Host B"
                onPress={() =>
                  host.address.set({ origin: "https://vps-b.example.com" })
                }
              >
                <Text>Switch to Host B</Text>
              </View>
            </View>
            <If
              when={props.mode === "banner"}
              else={
                <Workspace
                  layout={layout()}
                  theme="light"
                  onTheme={noop}
                  paletteId="default"
                  onPalette={noop}
                  flavor="mocha"
                  onFlavor={noop}
                  chatWidth="wide"
                  onChatWidth={noop}
                  chatRail={false}
                  onChatRail={noop}
                  onFonts={noop}
                  onConnect={() => connectClicks.update((n) => n + 1)}
                />
              }
            >
              <View style={{ flex: 1 }}>
                <ReconnectingBanner
                  phone={layout() === "phone"}
                  onConnect={() => connectClicks.update((n) => n + 1)}
                />
              </View>
            </If>
          </View>
        </Screen.Provider>
      </SavedHosts.Provider>
    </Host.Provider>
  );
}

void Storage.getItem("mode").then((mode) =>
  mount(() => <Fixture mode={mode ?? "setup"} />),
);
