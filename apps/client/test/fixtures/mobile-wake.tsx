import type { WireSocketEvents } from "@eta/client-contracts/wire";
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../src/components";
import { showsWorkspace } from "../../src/app/workspace-gate";
import { createHost } from "../../src/services/host";

/**
 * What a phone shows after the app went to the background and came back, with the sockets driven
 * by the buttons: "Greet" (the host says hello), "Drop" (the socket closes), "Wake" (the app
 * returns to the foreground, which reconnects to the same host by itself) and "Switch host" (the
 * user picks another one). "Attempts N" counts the sockets opened.
 */
function Fixture() {
  const sockets: WireSocketEvents[] = [];
  const attempts = signal(0);
  const host = createHost({
    openSocket: (_address, events) => {
      sockets.push(events);
      attempts.set(sockets.length);
      return { send: () => {}, close: () => {} };
    },
  });
  const address = { origin: "http://fixture.invalid" };
  const greet = () =>
    sockets.at(-1)?.message(
      JSON.stringify({
        type: "hello",
        ops: [],
        mounted: [],
        state: {
          conversations: { sections: { list: [] }, revisions: { list: "1" } },
        },
      }),
    );
  host.start(address);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 8, paddingTop: 48 }}>
        <Button label="Greet" onPress={() => greet()} />
        <Button label="Drop" onPress={() => sockets.at(-1)?.close()} />
        <Button
          label="Wake"
          onPress={() => host.start(address, { keepWorkspace: true })}
        />
        <Button
          label="Switch host"
          onPress={() => host.start({ origin: "http://other.invalid" })}
        />
      </View>
      <Text>{"Attempts " + attempts()}</Text>
      <Text>{"Paused " + (host.paused() ? "yes" : "no")}</Text>
      <Text>
        {showsWorkspace({
          connected: host.hasConnected(),
          everConnected: host.everConnected(),
          changingHost: false,
          settled: true,
        })
          ? "Workspace"
          : "Connection"}
      </Text>
    </View>
  );
}

mount(() => <Fixture />);
