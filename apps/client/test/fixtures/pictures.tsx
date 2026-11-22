import type { MessageView } from "@eta/client-contracts";
import { mount, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { Message } from "../../src/pages/chat/message";
import { TranscriptLine } from "../../src/pages/chat/run/transcript-line";
import { createHost, Host } from "../../src/services/host";

/** A 4 × 3 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNwaDgARww4OQBZNhIB0175YwAAAABJRU5ErkJggg==";

const SHOT = "6a0d3f0e-0000-4000-8000-000000000001";
const PHOTO = "6a0d3f0e-0000-4000-8000-000000000002";
const NOTES = "6a0d3f0e-0000-4000-8000-000000000003";

/** A sent message with two pictures and a text file, and a run step that carried two pictures. */
function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid", token: "secret" });
  host.state.update((state) => ({ ...state, status: "open" }));
  const item: MessageView = {
    id: "m1",
    conversationId: "group",
    seq: 1,
    kind: "message",
    author: "user",
    agentId: null,
    text: "Look at these",
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {
      attachments: [
        { id: SHOT, name: "shot.png", contentType: "image/png", size: 2048 },
        { id: NOTES, name: "notes.txt", contentType: "text/plain", size: 1024 },
        { id: PHOTO, name: "photo.jpg", contentType: "image/jpeg", size: 3072 },
      ],
    },
    createdAt: Date.UTC(2026, 10, 21, 9, 30),
    updatedAt: Date.UTC(2026, 10, 21, 9, 30),
  };
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1, justifyContent: "center", gap: 12 }}>
        <Button label="Elsewhere" onPress={() => {}} />
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
        <TranscriptLine
          session="s-ada"
          block={{
            type: "user",
            id: "u1",
            text: "Two screenshots",
            images: [
              { mimeType: "image/png", data: PNG, entryId: "u1", index: 0 },
              { mimeType: "image/png", data: PNG, entryId: "u1", index: 1 },
            ],
          }}
          firstTool={false}
          afterTool={false}
          phone={windowSize().width < 600}
          selected={false}
          opened={false}
          onToggle={() => {}}
        />
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
