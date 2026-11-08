import type { ReactNode } from "react";
import type { ActionName } from "../../config/types";
import type { VersionWarning } from "../../connection/types";
import type { Session } from "./session";
import { Box, Text } from "ink";
import { useStore } from "zustand";
import { InputScope } from "../../extensions/input-scope";
import { useAction, useConfig, useRegistry } from "../../extensions/react";
import { Home } from "./home";
import { StatusBar } from "./status-bar";
import { TabBar } from "./tab-bar";

const GO_TO_ACTIONS: ActionName[] = [
  "tabs.goTo1",
  "tabs.goTo2",
  "tabs.goTo3",
  "tabs.goTo4",
  "tabs.goTo5",
  "tabs.goTo6",
  "tabs.goTo7",
  "tabs.goTo8",
  "tabs.goTo9",
];

function GoToTabKey({
  action,
  index,
  session,
}: {
  action: ActionName;
  index: number;
  session: Session;
}) {
  useAction(action, () => session.goToTab(index));
  return null;
}

function TabKeys({ session }: { session: Session }) {
  useAction("tabs.next", () => session.stepTab(1));
  useAction("tabs.previous", () => session.stepTab(-1));
  useAction("tabs.close", () => session.closeActiveTab());
  return (
    <>
      {GO_TO_ACTIONS.map((action, index) => (
        <GoToTabKey
          key={action}
          action={action}
          index={index}
          session={session}
        />
      ))}
    </>
  );
}

function MainArea({
  session,
  url,
  temporary,
  version,
}: {
  session: Session;
  url: string;
  temporary: boolean;
  version: string;
}) {
  const registry = useRegistry();
  const tabs = useStore(session.store, (s) => s.tabs);
  const activeTab = useStore(session.store, (s) => s.activeTab);
  const layers = useStore(session.store, (s) => s.layers);
  const tab = activeTab === undefined ? undefined : tabs[activeTab];
  const view = tab ? registry.view(tab.kind) : undefined;
  const covered = layers.length > 0;
  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      <Box
        flexGrow={1}
        flexDirection="column"
        display={covered ? "none" : "flex"}
      >
        <InputScope active={!covered}>
          <TabKeys session={session} />
          <Backgrounds />
          {tab === undefined ? (
            <Home url={url} temporary={temporary} version={version} />
          ) : (
            view && (
              <view.Component key={`${tab.kind}:${tab.id}`} tab={tab} active />
            )
          )}
        </InputScope>
      </Box>
      <Layers session={session} />
    </Box>
  );
}

/**
 * Every extension's `Background`, mounted while the shell is, inside the main area's input scope,
 * and drawn nowhere.
 */
function Backgrounds() {
  const registry = useRegistry();
  return (
    <Box display="none">
      {registry.extensions.map(({ id, Background }) =>
        Background === undefined ? null : <Background key={id} />,
      )}
    </Box>
  );
}

// Ink draws text only inside <Text>; a layer may hand back a plain string.
function asNode(content: ReactNode): ReactNode {
  return typeof content === "string" || typeof content === "number" ? (
    <Text>{content}</Text>
  ) : (
    content
  );
}

/** The open layers; only the top one shows and receives keys, the ones under it keep their state. */
function Layers({ session }: { session: Session }) {
  const layers = useStore(session.store, (s) => s.layers);
  return (
    <>
      {layers.map((layer, index) => {
        const top = index === layers.length - 1;
        return (
          <Box
            key={layer.id}
            flexGrow={1}
            flexDirection="column"
            display={top ? "flex" : "none"}
          >
            <InputScope active={top}>
              {asNode(layer.render(layer.handle))}
            </InputScope>
          </Box>
        );
      })}
    </>
  );
}

/**
 * The connected interface: the main area (the tab in front, the home screen, or the top layer),
 * the status line, and the tab bar under it or, with `layout.tabBar` top, above everything.
 */
export function Shell({
  session,
  url,
  temporary,
  versionWarning,
  quitHint,
  version,
}: {
  session: Session;
  url: string;
  temporary: boolean;
  versionWarning: VersionWarning | undefined;
  quitHint: string | undefined;
  version: string;
}) {
  const config = useConfig();
  const tabs = useStore(session.store, (s) => s.tabs);
  const activeTab = useStore(session.store, (s) => s.activeTab);
  const notice = useStore(session.store, (s) => s.notice);
  const top = config.layout.tabBar === "top";
  const tabBar = <TabBar tabs={tabs} activeTab={activeTab} />;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {top && tabBar}
      <MainArea
        session={session}
        url={url}
        temporary={temporary}
        version={version}
      />
      <StatusBar
        url={url}
        temporary={temporary}
        versionWarning={versionWarning}
        notice={notice}
        quitHint={quitHint}
      />
      {!top && tabBar}
    </Box>
  );
}
