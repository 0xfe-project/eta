import type { MessageView } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Label } from "../../src/components";
import { chatText, descriptionText } from "../../src/components/eta-editor";
import { Message } from "../../src/pages/chat/message";
import { createHost, Host } from "../../src/services/host";

// Tables and the other GFM blocks as agents write them, each shown by a text system: a table after
// a blank line, one right under a line of text, one with a mention, code and a link in its cells,
// one between folded pastes; task lists, a footnote, an alert, a rule and code around a table; a
// task's description with a table; and a reply still being written that ends in a table.

const OPUS = "agent-opus";
const table = "| Name | Size |\n|---|---:|\n| alpha | 12 |\n| beta | 7 |";
const log = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
const pasted = `Before: ${log}\n\n${table}\n\nAfter: ${log}`;
const pasteStart = "Before: ".length;
const afterStart = pasted.lastIndexOf(log);

export const samples: Record<
  string,
  { text: string; blocks?: [number, number][] }
> = {
  Spaced: { text: `Here is the comparison:\n\n${table}\n\nThat is all.` },
  Tight: {
    text: `下面是对比：\n${table.replace("Name", "名字")}\nThat is all.`,
  },
  Lines: { text: `First line\nsecond line\n${table.replace("Size", "Count")}` },
  Pasted: {
    text: pasted,
    blocks: [
      [pasteStart, pasteStart + log.length],
      [afterStart, afterStart + log.length],
    ],
  },
  Blocks: {
    text: [
      "Todo:",
      "- [ ] write it",
      "- [x] read it",
      "",
      "A claim[^1] here.",
      "",
      "> [!NOTE]",
      "> Watch out.",
      "",
      "---",
      "",
      "```ts",
      "const before = 1;",
      "```",
      "| Kind | Count |",
      "|---|---|",
      "| fence | 2 |",
      "```sh",
      "echo after",
      "```",
      "",
      "[^1]: The source.",
    ].join("\n"),
  },
};

const reply: MessageView = {
  id: "m1",
  conversationId: "group",
  seq: 1,
  kind: "message",
  author: "agent",
  agentId: OPUS,
  text: "Owners:\n| Who | What |\n|---|---|\n| @Opus | `run.ts` and [docs](http://example.invalid/docs) |",
  mentions: [],
  data: {},
  thinking: "",
  status: "done",
  revision: 1,
  rootMessageId: null,
  replyToId: null,
  createdAt: Date.UTC(2026, 10, 21, 9, 30),
  updatedAt: Date.UTC(2026, 10, 21, 9, 30),
};

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid", token: "secret" });
  host.state.update((state) => ({ ...state, status: "open" }));
  host.agent = ((id: string) =>
    id === OPUS ? { id, name: "Opus" } : undefined) as typeof host.agent;
  const streamed = signal(
    "Results so far:\n| Step | State |\n|---|---|\n| one | do",
  );
  const streaming = signal(true);
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1, padding: 16, gap: 12 }}>
        {Object.entries(samples).map(([label, text]) => (
          <chatText.View text={text} label={label} />
        ))}
        <descriptionText.View
          text={{ text: `Plan:\n${table.replace("alpha", "gamma")}` }}
          label="Description"
        />
        <Message
          item={reply}
          additions={[]}
          canInsert={false}
          onInsert={() => {}}
          phone={false}
          members={[{ agentId: OPUS, status: "idle" }] as never[]}
          onArtifact={() => {}}
          onWidgetDraft={() => {}}
          onTask={() => {}}
          onReadDraft={() => {}}
          onMember={() => {}}
          registerAction={() => () => {}}
        />
        <chatText.View
          text={{ text: streamed() }}
          streaming={streaming()}
          label="Streaming"
        />
        <View
          role="button"
          accessibilityLabel="Finish"
          onPress={() => {
            streamed.set(`${streamed()}ne |\n| two | done |`);
            streaming.set(false);
          }}
        >
          <Label>Finish</Label>
        </View>
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
