import type { ConversationSummary } from "@eta/client-contracts";
import type { WireSocketEvents } from "@eta/client-contracts/wire";
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../src/components";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: "Ada",
  participants: [
    { agentId: "Ada", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

/**
 * A phone's conversation page on a host it reaches through sockets the test
 * drives with the buttons above it: "Greet" (the host says hello),
 * "Greet with heartbeat" (a host that answers pings, which never answers
 * here), "Drop" (the socket closes). "Attempts N" counts the sockets opened.
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
  const greet = (heartbeat: boolean) =>
    sockets.at(-1)?.message(
      JSON.stringify({
        type: "hello",
        ops: [],
        mounted: [],
        state: {
          conversations: {
            sections: { list: [summary] },
            revisions: { list: "1" },
          },
        },
        ...(heartbeat ? { heartbeat: true } : {}),
      }),
    );
  host.start({ origin: "http://fixture.invalid" });
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", gap: 8, paddingTop: 48 }}>
          <Button label="Greet" onPress={() => greet(false)} />
          <Button label="Greet with heartbeat" onPress={() => greet(true)} />
          <Button label="Drop" onPress={() => sockets.at(-1)?.close()} />
          <Text>{`Attempts ${attempts()}`}</Text>
        </View>
        <Conversation
          id="group"
          layout="phone"
          onTask={noop}
          onRelatedTask={noop}
          onAccessLost={noop}
          onRoutines={noop}
          onCloseTask={noop}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
