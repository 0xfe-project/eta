import type {
  AgentMessage,
  MessageView,
  ViewMessageRow,
} from "@eta/client-contracts";
import { colorScheme, mount, View } from "nsh";
import { Button, palette, Palette } from "../../src/components";
import { Message } from "../../src/pages/chat/message";
import { Appearance } from "../../src/pages/settings/appearance";
import { createHost, Host } from "../../src/services/host";
import {
  createProcessDetail,
  ProcessDetails,
} from "../../src/services/process-detail";

// Ada's reply at work (a thought, words, eight calls of five kinds) and Settings › Appearance
// beside it to switch how much of its process shows; the run can call once more, or be one
// that only thought.

const at = Date.UTC(2026, 10, 21, 9, 30);

function row(seq: number, message: Record<string, unknown>): ViewMessageRow {
  return {
    entryId: `e${seq}`,
    seq,
    at: at + seq,
    message: { timestamp: at + seq, ...message } as unknown as AgentMessage,
  };
}

const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "toolCall",
  id,
  name,
  arguments: input,
});

const result = (seq: number, id: string) =>
  row(seq, {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });

const briefing = row(1, {
  role: "user",
  content: "Why does the model return 401?",
});

const rows = [
  briefing,
  row(2, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Look at the provider config." },
      { type: "text", text: "I'll check config.json first." },
      call("b1", "bash", { command: "ls" }),
      call("b2", "bash", { command: "cat .env" }),
      call("w1", "web_fetch", { url: "https://example.invalid/a" }),
    ],
  }),
  result(3, "b1"),
  result(4, "b2"),
  result(5, "w1"),
  row(6, {
    role: "assistant",
    content: [
      call("b3", "bash", { command: "env" }),
      call("w2", "web_fetch", { url: "https://example.invalid/b" }),
      call("r1", "read", { path: "config.json" }),
      call("g1", "grep", { pattern: "baseUrl" }),
      call("x1", "write", { path: "notes.md" }),
    ],
  }),
  ...["b3", "w2", "r1", "g1", "x1"].map((id, index) => result(7 + index, id)),
];

/** One more call, still running. */
const oneMore = row(12, {
  role: "assistant",
  content: [call("b4", "bash", { command: "curl -I" })],
});

/** A run that only thought. */
const thoughtOnly = [
  briefing,
  row(2, {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Look at the provider config." }],
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
  const show = (messages: ViewMessageRow[]) =>
    host.state.update((state) => ({
      ...state,
      status: "open",
      targets: {
        ...state.targets,
        agents: {
          version: 1,
          revisions: {},
          sections: { list: [{ id: "ada", name: "Ada" }] },
        },
        "sessions.s-ada": {
          version: 1,
          revisions: {},
          sections: {
            transcript: { messages },
            core: { session: "s-ada", running: true },
          },
        },
      },
    }));
  show(rows);
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
              <Button
                label="Call once more"
                onPress={() => show([...rows, oneMore])}
              />
              <Button label="Only thought" onPress={() => show(thoughtOnly)} />
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
