import { mount, signal, Storage, View, windowSize } from "nsh";
import { ClientUpdateNotice } from "../../src/app/client-update-notice";
import { Screen } from "../../src/components/theme";
import { Connection } from "../../src/pages/connection";
import { ClientAppUpdate } from "../../src/pages/settings/updates/client-app";
import { createClientUpdate } from "../../src/services/client-update";
import { createHost, Host } from "../../src/services/host";

function Fixture(props: { page: string }) {
  const host = createHost();
  const layout = () => (windowSize().width < 600 ? "phone" : "desktop");
  const update = createClientUpdate({ flatpak: true });
  const connected = signal("");

  if (props.page !== "connection") void update.check();

  return (
    <Host.Provider value={host}>
      <Screen.Provider value={layout}>
        <View style={{ flex: 1 }}>
          <If when={props.page === "connection"}>
            <Connection
              initial={null}
              layout="desktop"
              resuming={false}
              flatpak
              onConnect={(address) => connected.set(JSON.stringify(address))}
            />
          </If>
          <If when={props.page === "update-settings"}>
            <ClientAppUpdate phone={false} flatpak update={update} />
          </If>
          <If when={props.page === "update-notice"}>
            <ClientUpdateNotice flatpak update={update} />
          </If>
        </View>
      </Screen.Provider>
    </Host.Provider>
  );
}

void Storage.getItem("page").then((page) =>
  mount(() => <Fixture page={page ?? "connection"} />),
);
