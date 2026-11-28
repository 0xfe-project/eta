import type { MessageView } from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { mount, signal, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { MessageViewport } from "../../src/components/eta-editor/plugins/picture-link";
import { Message } from "../../src/pages/chat/message";
import { createHost, Host } from "../../src/services/host";
import {
  createPictureMode,
  PictureModes,
} from "../../src/services/picture-mode";

const SHOT = "6a0d3f0e-0000-4000-8000-000000000001";
const PHOTO = "6a0d3f0e-0000-4000-8000-000000000002";
const THIRD = "6a0d3f0e-0000-4000-8000-000000000005";
const OLD = "6a0d3f0e-0000-4000-8000-000000000004";

const TEXT =
  "Before the first.\n\nBetween them, a few words.\n\nAnd after the second.";

/** A message whose two pictures stood among its words, and an older one that never said where. */
function Fixture() {
  const host = createHost();
  const pictures = createPictureMode();
  pictures.set("expanded");
  // The box the messages scroll in: "Look away" moves it to a corner that holds none of the marks.
  const away = signal(false);
  let list: ViewRef | undefined;
  let corner: ViewRef | undefined;
  host.address.set({ origin: "http://example.invalid", token: "secret" });
  host.state.update((state) => ({ ...state, status: "open" }));
  const row = (
    id: string,
    data: MessageView["data"],
    text: string,
  ): MessageView => ({
    id,
    conversationId: "group",
    seq: 1,
    kind: "message",
    author: "user",
    agentId: null,
    text,
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data,
    createdAt: Date.UTC(2026, 10, 21, 9, 30),
    updatedAt: Date.UTC(2026, 10, 21, 9, 30),
  });
  const anchored = row(
    "m1",
    {
      attachments: [
        { id: SHOT, name: "shot.png", contentType: "image/png", size: 2048 },
        { id: PHOTO, name: "photo.jpg", contentType: "image/jpeg", size: 3072 },
        { id: THIRD, name: "third.png", contentType: "image/png", size: 4096 },
      ],
      anchors: [
        { attachmentId: SHOT, at: TEXT.indexOf("Between") },
        { attachmentId: PHOTO, at: TEXT.indexOf("And after") },
        { attachmentId: THIRD, at: 0 },
      ],
    },
    TEXT,
  );
  const older = row(
    "m2",
    {
      attachments: [
        { id: OLD, name: "old.png", contentType: "image/png", size: 1024 },
      ],
    },
    "Sent before pictures had a place",
  );
  const show = (item: MessageView) => (
    <Message
      item={item}
      additions={[]}
      canInsert={false}
      onInsert={() => {}}
      phone={windowSize().width < 600}
      members={[]}
      onArtifact={() => {}}
      onWidgetDraft={() => {}}
      onTask={() => {}}
      onReadDraft={() => {}}
      registerAction={() => () => {}}
    />
  );
  return (
    <Host.Provider value={host}>
      <PictureModes.Provider value={pictures}>
        <MessageViewport.Provider value={() => (away() ? corner : list)}>
          <View style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Button label="Elsewhere" onPress={() => {}} />
            <Button label="Look away" onPress={() => away.set(true)} />
            <View
              ref={(node) => {
                corner = node;
              }}
              style={{ height: 8 }}
            />
            <View
              ref={(node) => {
                list = node;
              }}
            >
              {show(anchored)}
              {show(older)}
            </View>
          </View>
        </MessageViewport.Provider>
      </PictureModes.Provider>
    </Host.Provider>
  );
}

mount(Fixture);
