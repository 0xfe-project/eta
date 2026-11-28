import type { ConversationSummary } from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import type { HostAddress } from "../../src/services/host";
import {
  effect,
  mount,
  signal,
  Storage,
  Text,
  untracked,
  View,
  windowSize,
} from "nsh";
import {
  createSavedHosts,
  hostOriginLabel,
  needsLocalHostStart,
  sameHostAddress,
  SavedHosts,
} from "../../src/app/saved-hosts";
import { Workspace } from "../../src/app/workspace";
import {
  canReturnToWorkspace,
  showsWorkspace,
} from "../../src/app/workspace-gate";
import { Screen } from "../../src/components";
import { Connection } from "../../src/pages/connection";
import { createHost, Host } from "../../src/services/host";

function makeGroup(origin: string): ConversationSummary {
  return {
    id: `group-${hostOriginLabel(origin)}`,
    projectId: "project",
    kind: "group",
    name: `Group on ${hostOriginLabel(origin)}`,
    archived: false,
    stewardId: null,
    participants: [],
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    preview: "",
    lastMessageAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function Fixture(props: {
  autoConnect: boolean;
  unconfigured: boolean;
  canStartLocal: boolean;
}) {
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const savedHosts = createSavedHosts({ syncLegacy: true });
  const localLaunches = signal(0);
  const host = createHost({
    openSocket: (address, events) => {
      const groups = props.unconfigured ? [] : [makeGroup(address.origin)];
      setTimeout(() => {
        events.open();
        events.message(
          JSON.stringify({
            type: "hello",
            ops: [],
            mounted: [],
            state: {
              agents: {
                sections: { list: [] },
                revisions: { list: "1" },
              },
              projects: {
                sections: { list: [] },
                revisions: { list: "1" },
              },
              conversations: {
                sections: { list: groups },
                revisions: { list: "1" },
              },
              ...(groups[0]
                ? {
                    [`conversations.${groups[0].id}`]: {
                      sections: {
                        timeline: { messages: [], hasMore: false, held: [] },
                      },
                      revisions: { timeline: "1" },
                    },
                  }
                : {}),
              providers: {
                sections: {
                  config: {
                    revision: "1",
                    providers: [],
                    privateNetwork: { allow: [], loopback: false, invalid: [] },
                  },
                },
                revisions: { config: "1" },
              },
            },
          }),
        );
      }, 10);
      return { send: () => {}, close: () => {} };
    },
  });

  const forcedConnect = signal(false);
  const dismissedPhoneSetup = signal<string | undefined>(undefined);

  void savedHosts.load().then((active) => {
    if (props.autoConnect && active && !host.address() && !forcedConnect()) {
      host.start(active);
    }
  });

  effect(() => {
    const current = host.address();
    const origin = current?.origin ?? "";
    const dismissed = untracked(dismissedPhoneSetup);
    if (dismissed !== undefined && dismissed !== origin) {
      dismissedPhoneSetup.set(undefined);
    }
    if (host.hasConnected() && current) {
      savedHosts.remember(current);
    }
  });

  function connect(address: HostAddress) {
    if (
      sameHostAddress(address, host.address()) &&
      host.hasConnected() &&
      host.state().status === "open"
    ) {
      forcedConnect.set(false);
      savedHosts.remember(address);
      return;
    }
    forcedConnect.set(false);
    host.start(address);
  }

  function switchHost(address: HostAddress) {
    if (
      sameHostAddress(address, host.address()) &&
      host.hasConnected() &&
      host.state().status === "open"
    ) {
      forcedConnect.set(false);
      savedHosts.remember(address);
      return;
    }
    if (
      needsLocalHostStart({
        address,
        activeOrigin: host.address()?.origin,
        activeOpen: host.hasConnected() && host.state().status === "open",
        canStartHost: props.canStartLocal,
      })
    ) {
      localLaunches.update((count) => count + 1);
      forcedConnect.set(false);
      host.start({
        origin: "http://127.0.0.1:54321",
        token: "resumed-local-token",
        local: true,
      });
      return;
    }
    connect(address);
  }

  const gate = () => ({
    connected: host.hasConnected(),
    everConnected: host.everConnected(),
    changingHost: forcedConnect(),
    settled: true,
  });

  const noop = () => {};

  return (
    <Host.Provider value={host}>
      <SavedHosts.Provider value={savedHosts}>
        <Screen.Provider value={layout}>
          <View style={{ flex: 1 }}>
            <Text testID="active-origin">
              {`Active: ${host.address()?.origin ?? "none"}`}
            </Text>
            <Text>{`Local launches: ${localLaunches()}`}</Text>
            <If
              when={showsWorkspace(gate())}
              else={
                <Connection
                  initial={canReturnToWorkspace(gate()) ? null : host.address()}
                  layout={layout()}
                  resuming={false}
                  flatpak
                  choosingHost={forcedConnect()}
                  activeOrigin={host.address()?.origin}
                  activeConnected={
                    host.hasConnected() && host.state().status === "open"
                  }
                  onCancel={
                    canReturnToWorkspace(gate())
                      ? () => forcedConnect.set(false)
                      : undefined
                  }
                  onConnect={connect}
                />
              }
            >
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
                onConnect={() => forcedConnect.set(true)}
                onSwitchHost={switchHost}
                phoneSetupDismissedFor={dismissedPhoneSetup()}
                onDismissPhoneSetup={(origin) =>
                  dismissedPhoneSetup.set(origin)
                }
              />
            </If>
          </View>
        </Screen.Provider>
      </SavedHosts.Provider>
    </Host.Provider>
  );
}

void Promise.all([
  Storage.getItem("autoConnect"),
  Storage.getItem("unconfigured"),
  Storage.getItem("canStartLocal"),
]).then(([autoConnect, unconfigured, canStartLocal]) =>
  mount(() => (
    <Fixture
      autoConnect={autoConnect === "true"}
      unconfigured={unconfigured === "true"}
      canStartLocal={canStartLocal === "true"}
    />
  )),
);
