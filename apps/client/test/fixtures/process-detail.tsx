import type {
  AgentMessage,
  MessageView,
  ViewMessageRow,
} from "@eta/client-contracts";
import { colorScheme, mount, View } from "nsh";
import { palette, Palette } from "../../src/components";
import { Message } from "../../src/pages/chat/message";
import { Appearance } from "../../src/pages/settings/appearance";
import { createHost, Host } from "../../src/services/host";
import {
  createProcessDetail,
  ProcessDetails,
} from "../../src/services/process-detail";

// Ada's reply at work (a thought, words, a call) and Settings › Appearance beside it to switch
// how much of its process shows.

const at = Date.UTC(2026, 10, 21, 9, 30);

function row(seq: number, message: Record<string, unknown>): ViewMessageRow {
  return {
    entryId: `e${seq}`,
    seq,
    at: at + seq,
    message: { timestamp: at + seq, ...message } as unknown as AgentMessage,
  };
}

const rows = [
  row(1, { role: "user", content: "Why does the model return 401?" }),
  row(2, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Look at the provider config." },
      { type: "text", text: "I'll check config.json first." },
      {
        type: "toolCall",
        id: "t1",
        name: "read",
        arguments: { path: "config.json" },
      },
    ],
  }),
  row(3, {
    role: "toolResult",
    toolCallId: "t1",
    content: [{ type: "text", text: "baseUrl: https://example.invalid" }],
    isError: false,
  }),
];

const item: MessageView = {
  id: "ada-1",
  conversationId: "group",
  seq: 2,
  kind: "message",
  author: "agent",
  agentId: "ada",
  text: "",
  thinking: "",
  status: "working",
  revision: 1,
  mentions: [],
  rootMessageId: null,
  replyToId: null,
  data: { runFrom: 0 },
  createdAt: at,
  updatedAt: at,
};

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>() => undefined as T;
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      agents: {
        version: 1,
        revisions: {},
        sections: { list: [{ id: "ada", name: "Ada" }] },
      },
      "sessions.s-ada": {
        version: 1,
        revisions: {},
        sections: {
          transcript: { messages: rows },
          core: { session: "s-ada", running: true },
        },
      },
    },
  }));
  const processDetail = createProcessDetail();
  return (
    <Palette.Provider value={() => palette(colorScheme())}>
      <Host.Provider value={host}>
        <ProcessDetails.Provider value={processDetail}>
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ flex: 1 }}>
              <Message
                item={item}
                additions={[]}
                canInsert={false}
                onInsert={() => {}}
                phone={false}
                members={[
                  {
                    agentId: "ada",
                    sessionId: "s-ada",
                    lastSeq: 1,
                    status: "working",
                    activeReplyId: "ada-1",
                  },
                ]}
                onArtifact={() => {}}
                onWidgetDraft={() => {}}
                onTask={() => {}}
                onReadDraft={() => {}}
                registerAction={() => () => {}}
              />
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
        </ProcessDetails.Provider>
      </Host.Provider>
    </Palette.Provider>
  );
}

mount(Fixture);
