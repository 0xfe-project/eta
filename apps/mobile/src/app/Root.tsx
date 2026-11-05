import { ErrorBoundary, Text, View } from "nsh";
import { NavStack } from "nsh/base";
import { ConnectScreen, DisconnectedScreen, UninitializedScreen } from "../features/connect";
import { loadLanguage } from "../i18n";
import { nav } from "../nav/stack";
import { Tabs } from "../nav/Tabs";
import { Loading } from "../ui/States";
import { ToastHost } from "../ui/toast";
import { agents } from "./lists";
import { loadScheme } from "./prefs";
import { boot, phase, wire } from "./session";

function Connected() {
  return (
    <View class="flex-1">
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route, index) => (index() === 0 ? <Tabs /> : route.page())}
      </NavStack>
      <ToastHost />
    </View>
  );
}

/** A host with no agents has nothing for a phone to show: 08c says what is missing. */
function Ready() {
  return (
    <If when={wire().lastSeenAt() !== undefined} else={<Loading />}>
      <If when={agents().length > 0} else={<UninitializedScreen />}>
        <Connected />
      </If>
    </If>
  );
}

export function Root() {
  void Promise.all([loadLanguage(), loadScheme()]).then(boot);
  return (
    <ErrorBoundary
      fallback={(error) => (
        <View class="flex-1 justify-center bg-background p-4">
          <Text class="text-base text-foreground">{String(error)}</Text>
        </View>
      )}
    >
      <View class="flex-1 bg-background">
        <If when={phase() === "ready"}>
          <Ready />
        </If>
        <If when={phase() === "disconnected"}>
          <DisconnectedScreen />
        </If>
        <If when={phase() === "form" || phase() === "connecting" || phase() === "failed"}>
          <ConnectScreen />
        </If>
      </View>
    </ErrorBoundary>
  );
}
