import type { MessageView } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Label } from "../../src/components";
import { chatText } from "../../src/components/eta-editor";
import { AttachmentFiles } from "../../src/services/attachment-files";
import { Appearance } from "../../src/pages/settings/appearance";
import { Message } from "../../src/pages/chat/message";
import { createHost, Host } from "../../src/services/host";
import {
  createPictureMode,
  PictureModes,
} from "../../src/services/picture-mode";

// A user message as the composer sends it (a mention, a folded paste, two pictures and a PDF), a
// reply in Markdown with a mention, a picture and a code block, and Settings › Appearance beside
// them to switch how pictures show; a note with a folded paste, and a reply still being written, a
// chunk at a time.

const REVIEWER = "agent-reviewer";
const OPUS = "agent-opus";
const head = "Please check @Reviewer, log: ";
const log = Array.from({ length: 42 }, (_, i) => `line ${i}`).join("\n");

const base = {
  conversationId: "group",
  thinking: "",
  status: "done",
  revision: 1,
  rootMessageId: null,
  replyToId: null,
  createdAt: Date.UTC(2026, 10, 21, 9, 30),
  updatedAt: Date.UTC(2026, 10, 21, 9, 30),
} as const;

const sent: MessageView = {
  ...base,
  id: "m1",
  seq: 1,
  kind: "message",
  author: "user",
  agentId: null,
  text: `${head}${log}`,
  mentions: [REVIEWER],
  data: {
    blocks: [[head.length, head.length + log.length]],
    attachments: [
      { id: "p1", name: "before.png", contentType: "image/png", size: 2048 },
      { id: "p2", name: "after.png", contentType: "image/png", size: 3072 },
      {
        id: "f1",
        name: "spec.pdf",
        contentType: "application/pdf",
        size: 86016,
      },
    ],
  },
};

const reply: MessageView = {
  ...base,
  id: "m2",
  seq: 2,
  kind: "message",
  author: "agent",
  agentId: REVIEWER,
  text: "Two causes, @Opus takes it: ![shot.png](http://example.invalid/shot.png)\n\n```tsx\n<Row inset={12} />\n```",
  mentions: [],
  data: {},
};

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid", token: "secret" });
  host.state.update((state) => ({ ...state, status: "open" }));
  host.agent = ((id: string) =>
    id === REVIEWER
      ? { id, name: "Reviewer" }
      : id === OPUS
        ? { id, name: "Opus" }
        : undefined) as typeof host.agent;
  const pictures = createPictureMode();
  const opened = signal("");
  const saved = signal("");
  // Saving is the app's (a download, the share sheet): here it says what it was asked for.
  const files = {
    save: async (file: { id: string }) => saved.set(file.id),
    busy: () => undefined,
    writer: () => null,
  } as never;
  const streamed = signal("Working on **it**");
  const streaming = signal(true);
  const members = [
    { agentId: REVIEWER, status: "idle" },
    { agentId: OPUS, status: "idle" },
  ] as never[];
  const message = (item: MessageView) => (
    <Message
      item={item}
      additions={[]}
      canInsert={false}
      onInsert={() => {}}
      phone={false}
      members={members}
      onArtifact={() => {}}
      onWidgetDraft={() => {}}
      onTask={() => {}}
      onReadDraft={() => {}}
      onMember={(id) => opened.set(id)}
      registerAction={() => () => {}}
    />
  );
  return (
    <Host.Provider value={host}>
      <AttachmentFiles.Provider value={files}>
        <PictureModes.Provider value={pictures}>
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ flex: 1 }}>
              {message(sent)}
              {message(reply)}
              <If when={opened()}>
                <Label>{`Opened member ${opened()}`}</Label>
              </If>
              <If when={saved()}>
                <Label>{`Saved file ${saved()}`}</Label>
              </If>
              <chatText.View
                text={{ text: `Note: ${log}`, blocks: [[6, 6 + log.length]] }}
                label="Note"
              />
              <chatText.View
                text={{ text: streamed() }}
                streaming={streaming()}
                label="Streaming reply"
              />
              <View
                role="button"
                accessibilityLabel="More"
                onPress={() =>
                  streamed.set(
                    `${streamed()}\n\n- step one\n- step two\n\n\`\`\`ts\nconst a`,
                  )
                }
              >
                <Label>More</Label>
              </View>
              <View
                role="button"
                accessibilityLabel="Done"
                onPress={() => {
                  streamed.set(`${streamed()} = 1;\n\`\`\`\n\nAll done.`);
                  streaming.set(false);
                }}
              >
                <Label>Done</Label>
              </View>
            </View>
            <View style={{ width: 420 }}>
              <Appearance
                phone={false}
                theme="system"
                onTheme={() => {}}
                paletteId="default"
                onPalette={() => {}}
                flavor="mocha"
                onFlavor={() => {}}
                chatWidth="standard"
                onChatWidth={() => {}}
                chatRail={false}
                onChatRail={() => {}}
                onFonts={() => {}}
              />
            </View>
          </View>
        </PictureModes.Provider>
      </AttachmentFiles.Provider>
    </Host.Provider>
  );
}

mount(Fixture);
