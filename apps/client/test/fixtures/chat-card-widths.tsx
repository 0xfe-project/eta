import type {
  AgentView,
  BoardTaskView,
  ConversationSummary,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import type { Flavor, PaletteId } from "../../src/components/palettes";
import type { ChatWidth } from "../../src/pages/settings/appearance";
import { mount, setColorScheme, signal, UrlScheme, windowSize } from "nsh";
import { Workspace } from "../../src/app/workspace";
import {
  Fonts,
  palette,
  Palette,
  SafeArea,
  Screen,
} from "../../src/components";
import {
  AttachmentFiles,
  createAttachmentFiles,
} from "../../src/services/attachment-files";
import { createHost, Host } from "../../src/services/host";
import {
  createPictureMode,
  PictureModes,
} from "../../src/services/picture-mode";

const agent: AgentView = {
  id: "ada",
  name: "Ada",
  instructions: "",
  persona: "Engineer",
  model: "claude-sonnet",
  runtime: "pi",
  thinkingLevel: null,
  machineId: null,
  plugins: [],
  skippedPlugins: [],
  systemRole: null,
  avatarSeed: null,
  avatarSeeds: [],
  home: "",
  homeProjectId: "project",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "eta",
  archived: false,
  stewardId: "ada",
  participants: [
    { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 5,
  readSeq: 5,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const base = {
  conversationId: "group",
  status: "done" as const,
  revision: 1,
  thinking: "",
  rootMessageId: null,
  replyToId: null,
  mentions: [] as string[],
  createdAt: 1732500000000,
  updatedAt: 1732500000000,
};

const task: BoardTaskView = {
  id: "task-414",
  number: 414,
  title: "Align draft and confirmed task cards with chat content width",
  status: "in_progress",
  createdBy: { kind: "agent", agentId: "ada" },
  assigneeAgentId: "ada",
  conversationId: "group",
  runStatus: "running",
  comments: 0,
  createdAt: 1732500000000,
  updatedAt: 1732500000000,
};

const messages: MessageView[] = [
  {
    ...base,
    id: "m1",
    seq: 1,
    kind: "message",
    author: "user",
    agentId: null,
    text: "Check that the draft task card and confirmed task card align with the chat column width.",
    data: {},
  },
  {
    ...base,
    id: "m2",
    seq: 2,
    kind: "message",
    author: "agent",
    agentId: "ada",
    thinking: "Checking chat column layout and horizontal alignment.",
    text: "Here is an agent reply paragraph spanning across the chat content column so both left and right edges can be compared directly against the draft card, the confirmed task card, and the thinking process bar above.",
    data: {},
  },
  {
    ...base,
    id: "m3",
    seq: 3,
    kind: "task_draft",
    author: "agent",
    agentId: "ada",
    text: "Draft task card following appearance chat width",
    data: {
      title: "Draft task card following appearance chat width",
      description:
        "Keep the draft card aligned with the rest of the transcript column.",
      workspace: "worktree",
    },
  },
  {
    ...base,
    id: "m4",
    seq: 4,
    kind: "task_card",
    author: "agent",
    agentId: "ada",
    text: task.title,
    data: {
      taskId: task.id,
      number: task.number,
      title: task.title,
    },
  },
  {
    ...base,
    id: "m5",
    seq: 5,
    kind: "message",
    author: "agent",
    agentId: "ada",
    text: "Another paragraph below both cards to show the left and right edges of body text in the same column.",
    data: {},
  },
];

function Fixture() {
  const parsed = new URL(
    UrlScheme.url() ?? "eta://fixture?width=standard&theme=light",
  );
  const initialWidth = (parsed.searchParams.get("width") ??
    "standard") as ChatWidth;
  const initialTheme =
    parsed.searchParams.get("theme") === "dark" ? "dark" : "light";
  setColorScheme(initialTheme);

  const host = createHost();
  const timeline: TimelineSection = { messages, hasMore: false, held: [] };
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: { sections: { list: [agent] }, revisions: {}, version: 0 },
      conversations: {
        sections: { list: [summary] },
        revisions: {},
        version: 0,
      },
      tasks: { sections: { list: [task] }, revisions: {}, version: 0 },
      "conversations.group": {
        sections: { timeline },
        revisions: {},
        version: 0,
      },
      providers: { sections: { config: {} }, revisions: {}, version: 0 },
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>() => undefined as T;

  const chatWidth = signal<ChatWidth>(initialWidth);
  const theme = signal<"system" | "light" | "dark">(initialTheme);
  const chatRail = signal(false);
  const paletteId = signal<PaletteId>("default");
  const flavor = signal<Flavor>("mocha");
  const fonts = signal({ interface: "", mono: "" });
  const pictureMode = createPictureMode();
  const attachmentFiles = createAttachmentFiles(host);

  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const c = () =>
    palette(theme() === "dark" ? "dark" : "light", paletteId(), flavor());

  return (
    <Host.Provider value={host}>
      <PictureModes.Provider value={pictureMode}>
        <AttachmentFiles.Provider value={attachmentFiles}>
          <Palette.Provider value={c}>
            <Fonts.Provider value={fonts}>
              <Screen.Provider value={layout}>
                <SafeArea style={{ backgroundColor: c().canvas }}>
                  <Workspace
                    layout={layout()}
                    theme={theme()}
                    onTheme={(next) => {
                      theme.set(next);
                      setColorScheme(next);
                    }}
                    paletteId={paletteId()}
                    onPalette={paletteId.set}
                    flavor={flavor()}
                    onFlavor={flavor.set}
                    chatWidth={chatWidth()}
                    onChatWidth={chatWidth.set}
                    chatRail={chatRail()}
                    onChatRail={chatRail.set}
                    onFonts={fonts.set}
                    onConnect={() => {}}
                  />
                </SafeArea>
              </Screen.Provider>
            </Fonts.Provider>
          </Palette.Provider>
        </AttachmentFiles.Provider>
      </PictureModes.Provider>
    </Host.Provider>
  );
}

mount(Fixture);
