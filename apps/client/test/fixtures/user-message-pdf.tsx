import type { MessageView } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Message } from "../../src/pages/chat/message";
import { createHost, Host } from "../../src/services/host";

const picture =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const long = "screenshot_20261126_010037_dev.eta.client_very_long_name.pdf";

const item: MessageView = {
  id: "m1",
  conversationId: "c1",
  seq: 1,
  kind: "message",
  author: "user",
  agentId: null,
  text: "Look",
  thinking: "",
  status: "done",
  revision: 1,
  mentions: [],
  rootMessageId: null,
  replyToId: null,
  data: {
    attachments: [
      { id: "a1", name: long, contentType: "application/pdf", size: 70 },
    ],
  },
  createdAt: 0,
  updatedAt: 0,
};

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  host.state.update((state) => ({ ...state, status: "open" }));
  host.call = async <T,>() =>
    ({ contentType: "application/pdf", data: picture }) as T;
  return (
    <Host.Provider value={host}>
      <View style={{ padding: 16 }}>
        <Message
          item={item}
          additions={[]}
          canInsert={false}
          onInsert={() => {}}
          phone
          members={[]}
          onArtifact={() => {}}
          onWidgetDraft={() => {}}
          onTask={() => {}}
          onReadDraft={() => {}}
          registerAction={() => () => {}}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
