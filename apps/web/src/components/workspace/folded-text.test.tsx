import type { MessageView } from "@eta/client-contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { foldChoice } from "@/lib/fold";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { Chat } from "@/test-chat";
import { surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";

// What a long message is folded to, and what the reader's choice survives. The fold is about the
// box around the words, so the markdown renderer is standing in for the words it turns into them;
// its own rendering is tested with it, not here.
rstest.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: string }) => <p>{children}</p>,
}));

const KEY = "eta.card-folds.v1";
const EXPAND = "展开全文";
const COLLAPSE = "收起";

/** Forty lines of answer: over both of the thresholds `isLongPaste` weighs. */
const LONG = Array.from(
  { length: 40 },
  (_, i) => `第 ${i + 1} 段：这一行是回复里的一行。`,
).join("\n");

const activity = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    name: "shell",
    input: { command: `step-${i}` },
    output: "ok",
    status: "completed",
  }));

let conversations = 0;

/** Open `kind` chat with these rows. */
async function start(kind: "group" | "direct", rows: MessageView[]) {
  conversations += 1;
  const id = `folded-text-${conversations}`;
  const summary = conversationView({
    id,
    kind,
    participants: [memberView("a1", { sessionId: "s1" })],
  });
  for (const row of rows) row.conversationId = id;
  surfaceHost({
    agents: [agentView({ id: "a1", name: "研究员" })],
    conversations: [summary],
    messages: { [id]: rows },
  });
  const mounted = await mount(<Chat conversationId={id} />);
  await flush();
  return mounted;
}

const user = (fields: Partial<MessageView> = {}) =>
  messageView({ conversationId: "", author: "user", text: "问题", ...fields });
const reply = (fields: Partial<MessageView> = {}) =>
  messageView({
    conversationId: "",
    author: "agent",
    agentId: "a1",
    text: LONG,
    ...fields,
  });

/** The clamped box around a row's words, wherever it is on the page. */
const clamps = (root: ParentNode) => [
  ...root.querySelectorAll<HTMLElement>(".line-clamp-12"),
];
/** The fold's button, by the word on it. */
const foldButton = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].filter((b) => b.textContent === label);

beforeEach(() => {
  localStorage.setItem(KEY, "{}");
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  useOutbox.setState({ drafts: {}, outgoing: [] });
});

describe("a long reply", () => {
  it("shows twelve lines and the way to the rest, in a chat of two", async () => {
    const { container } = await start("direct", [user(), reply()]);
    const answer = container.querySelector(
      ".message.assistant .message-content",
    );
    expect(answer?.querySelector(".line-clamp-12")).not.toBeNull();
    // Folded means the whole text is still there to be opened, not gone from the row.
    expect(answer?.textContent).toContain("第 40 段");
    expect(foldButton(answer!, EXPAND)).toHaveLength(1);
    expect(foldButton(answer!, COLLAPSE)).toHaveLength(0);

    await click(foldButton(answer!, EXPAND)[0]);
    expect(answer?.querySelector(".line-clamp-12")).toBeNull();
    expect(foldButton(answer!, COLLAPSE)).toHaveLength(1);

    await click(foldButton(answer!, COLLAPSE)[0]);
    expect(answer?.querySelector(".line-clamp-12")).not.toBeNull();
  });

  it("leaves a short reply exactly as it was", async () => {
    const { container } = await start("direct", [
      user(),
      reply({ text: "就两句。\n没了。" }),
    ]);
    const answer = container.querySelector(
      ".message.assistant .message-content",
    );
    expect(answer?.getAttribute("class")).toBe("message-content");
    expect(container.querySelector(".line-clamp-12")).toBeNull();
    expect(foldButton(container, EXPAND)).toHaveLength(0);
  });

  it("folds on either threshold — the characters, or the lines", async () => {
    const chars = reply({ id: "by-chars", text: "字".repeat(1001) });
    const lines = reply({ id: "by-lines", text: "一行\n".repeat(13) });
    // Exactly at both: 12 lines, 1000 characters (11 × 82 + 87 + 11 newlines). Neither is over,
    // so a message that merely fills a screen is left alone.
    const exact = reply({
      id: "at-the-edge",
      text: [
        ...Array.from({ length: 11 }, () => "字".repeat(82)),
        "字".repeat(87),
      ].join("\n"),
    });
    const { container } = await start("direct", [user(), chars, lines, exact]);
    const at = (id: string) =>
      container.querySelector(`#msg-${id} .message-content`)!;
    expect(at("by-chars").querySelector(".line-clamp-12")).not.toBeNull();
    expect(at("by-lines").querySelector(".line-clamp-12")).not.toBeNull();
    // 1000 characters over four lines is neither over: nothing is folded, nothing is offered.
    expect(at("at-the-edge").querySelector(".line-clamp-12")).toBeNull();
    expect(foldButton(container, EXPAND)).toHaveLength(2);
  });

  it("folds the answer's own box, and nothing of the row around it", async () => {
    const { container } = await start("direct", [user(), reply()]);
    const clamp = clamps(container)[0]!;
    // The cards and the footer (the time, the copy) are outside the fold.
    expect(clamp.closest(".message-footer")).toBeNull();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => copied.push(text) },
    });
    await click(container.querySelector(".message-copy-btn"));
    expect(copied).toEqual([LONG]);
  });

  it("folds the words you sent with the same piece as the words it wrote", async () => {
    const { container } = await start("direct", [
      user({ text: LONG }),
      reply(),
    ]);
    expect(clamps(container)).toHaveLength(2);
    expect(foldButton(container, EXPAND)).toHaveLength(2);
    const answer = container.querySelector(
      ".message.assistant .message-content",
    );
    const sent = container.querySelector(".message.user .message-content");
    expect(answer?.querySelector(".line-clamp-12")).not.toBeNull();
    expect(sent?.querySelector(".line-clamp-12")).not.toBeNull();
    expect(
      sent?.querySelector(".line-clamp-12")?.nextElementSibling?.className,
    ).toBe(
      answer?.querySelector(".line-clamp-12")?.nextElementSibling?.className,
    );
  });
});

describe("a boxed reply, in a group", () => {
  it("folds its answer under the process row, and shows it open in the dialog", async () => {
    const answer = reply({
      thinking: "想一想",
      data: { activity: activity(2) },
    });
    const { container } = await start("group", [user(), answer]);
    const box = container.querySelector(".process-fold");
    expect(box).not.toBeNull();
    // The answer is below the process row, folded like any other.
    const place = container.querySelector(
      ".message.assistant .message-content",
    );
    expect(place?.querySelector(".line-clamp-12")).not.toBeNull();

    await click(box?.querySelector("summary"));
    await click(box?.querySelector("button"));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    // The same answer, drawn again in the dialog: folded too, and the same fold.
    expect(dialog.querySelector(".line-clamp-12")).not.toBeNull();
    await click(foldButton(dialog, EXPAND)[0]);
    expect(dialog.querySelector(".line-clamp-12")).toBeNull();
    // One choice, not one per copy: the row on the page opened with it.
    expect(clamps(container)).toHaveLength(0);
    expect(foldChoice(answer.id)).toBe(true);
  });
});

describe("the reader's own fold", () => {
  it("is kept by the row's id, and outlives the row being drawn again", async () => {
    const answer = reply();
    const { container } = await start("direct", [user(), answer]);
    await click(foldButton(container, EXPAND)[0]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({
      [answer.id]: 1,
    });

    await cleanup();
    setWire(undefined);
    const again = await start("direct", [user(), answer]);
    const box = again.container.querySelector(
      ".message.assistant .message-content",
    );
    expect(box?.querySelector(".line-clamp-12")).toBeNull();
    expect(foldButton(box!, COLLAPSE)).toHaveLength(1);

    // Folding it back is a choice as well, and is kept the same way.
    await click(foldButton(again.container, COLLAPSE)[0]);
    expect(foldChoice(answer.id)).toBe(false);
  });

  it("is one row's business: opening one long reply leaves the other folded", async () => {
    const first = reply({ id: "first" });
    const second = reply({ id: "second" });
    const { container } = await start("direct", [user(), first, second]);
    await click(foldButton(container, EXPAND)[0]);
    expect(clamps(container)).toHaveLength(1);
    expect(container.querySelector("#msg-first .line-clamp-12")).toBeNull();
    expect(
      container.querySelector("#msg-second .line-clamp-12"),
    ).not.toBeNull();
  });
});
