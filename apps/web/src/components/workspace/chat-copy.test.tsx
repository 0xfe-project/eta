import type { MessageView } from "@eta/client-contracts";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { closeBrowser, hasBrowser, onPage, PHONE } from "@/test-browser";
import { Chat } from "@/test-chat";
import { surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";

const AGENT = "a1";
let CONV = "";
let conversations = 0;
let n = 0;
const row = (fields: Partial<MessageView>): MessageView => {
  n += 1;
  return messageView({
    id: `${CONV}-${n}`,
    conversationId: CONV,
    seq: n,
    ...fields,
  });
};

const REVIEW = [
  "<captain-review>",
  "The platform Supervisor queued the following observations.",
  "1. [task_run_offline] Task #7 is waiting for an offline machine.",
  '{ "taskId": "t1", "taskNumber": 7 }',
  "</captain-review>",
].join("\n");
const review = () => row({ author: "system", text: REVIEW });

/** One of each row the copy is or is not on, in a group. */
function transcript(): MessageView[] {
  const user = row({ text: "问题" });
  return [
    user,
    row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      thinking: "先看 OG 图从哪里来。",
      text: "换好了",
      data: {
        activity: [
          {
            id: "t1",
            name: "bash",
            input: { command: "ls" },
            output: "",
            status: "completed",
          },
        ],
      },
    }),
    row({ author: "agent", agentId: AGENT, text: "另一条回复" }),
    row({
      kind: "system",
      author: "system",
      text: "A is now the steward.",
      data: { event: "steward", from: "a2", to: AGENT },
    }),
    review(),
  ];
}

let copied: string[] = [];
beforeEach(() => {
  n = 0;
  conversations += 1;
  CONV = `chat-copy-${conversations}`;
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  useOutbox.setState({ drafts: {}, outgoing: [] });
});

function start(history: MessageView[]) {
  const summary = conversationView({
    id: CONV,
    name: "官网改版",
    participants: [memberView(AGENT, { sessionId: "s1" })],
    lastSeq: n,
  });
  surfaceHost({
    agents: [agentView({ id: AGENT, name: "Ada" })],
    conversations: [summary],
    messages: { [CONV]: history },
  });
  return mount(<Chat conversationId={CONV} />);
}

const footerButton = (message: Element | null | undefined) =>
  message?.querySelector(":scope > .message-footer .message-copy-btn");

describe("the copy button beside a message's time", () => {
  it("is under your own message, after the time, and copies what you wrote as written", async () => {
    const text = "@Ada 把 **OG 图**换成新的\n\nSafari 下也测一下";
    const { container } = await start([
      row({
        text,
        data: {
          attachments: [
            { id: "f1", name: "og.png", contentType: "image/png", size: 10 },
          ],
        },
      }),
    ]);
    await flush();
    const user = container.querySelector(".message.user");
    const footer = user?.querySelector(":scope > .message-footer");
    const button = footerButton(user)!;
    expect(button).not.toBeNull();
    // The time, then the message's actions (Insert, while it is answered), copy last.
    expect(footer?.firstElementChild?.tagName).toBe("TIME");
    expect(footer?.lastElementChild).toBe(button);
    expect(button.textContent).toBe("复制");

    await click(button);
    await flush();
    expect(copied).toEqual([text]);
    expect(button.textContent).toBe("已复制");
  });

  it("still copies a reply's Markdown, after its time", async () => {
    const user = row({ text: "问题" });
    const { container } = await start([
      user,
      row({
        author: "agent",
        agentId: AGENT,
        replyToId: user.id,
        text: "已换成 **1200×630** 的新图",
      }),
    ]);
    await flush();
    const reply = container.querySelector(".message.assistant");
    const footer = reply?.querySelector(":scope > .message-footer");
    expect(footer?.firstElementChild?.tagName).toBe("TIME");
    const button = footerButton(reply)!;
    expect(footer?.lastElementChild).toBe(button);
    await click(button);
    await flush();
    expect(copied).toEqual(["已换成 **1200×630** 的新图"]);
  });

  it("is on a group reply whose process is folded into a box", async () => {
    const user = row({ text: "问题" });
    const { container } = await start([
      user,
      row({
        author: "agent",
        agentId: AGENT,
        replyToId: user.id,
        thinking: "先看 OG 图从哪里来。",
        text: "换好了",
        data: {
          activity: [
            {
              id: "t1",
              name: "bash",
              input: { command: "ls" },
              output: "",
              status: "completed",
            },
          ],
        },
      }),
    ]);
    await flush();
    const reply = container.querySelector(".message.assistant");
    expect(reply?.querySelector(".process-fold")).not.toBeNull();
    const button = footerButton(reply)!;
    expect(button).not.toBeNull();
    await click(button);
    await flush();
    expect(copied).toEqual(["换好了"]);
  });

  it("copies a Captain review as the platform wrote it, from the card's header", async () => {
    const { container } = await start([review()]);
    await flush();
    const card = container.querySelector(".captain-review");
    const button = card!.querySelector(":scope > header .message-copy-btn")!;
    expect(button).not.toBeNull();
    // After the time, as on a reply: the header reads left to right like a reply's footer.
    expect(button.previousElementSibling?.tagName).toBe("TIME");
    await click(button);
    await flush();
    expect(copied).toEqual([REVIEW]);
  });

  it("is on every message exactly once, and on no system row", async () => {
    const { container } = await start(transcript());
    await flush();
    const messages = [
      ...container.querySelectorAll(".message, .captain-review"),
    ];
    // Your message, the folded reply, the plain reply and the review.
    expect(messages).toHaveLength(4);
    for (const message of messages)
      expect(message.querySelectorAll(".message-copy-btn")).toHaveLength(1);
    expect(container.querySelectorAll(".message-copy-btn")).toHaveLength(4);
    const notice = container.querySelector(".system-message");
    expect(notice).not.toBeNull();
    expect(notice?.querySelector(".message-copy-btn")).toBeNull();
  });

  it("is not on a message still being sent, which has no time either until it is sent", async () => {
    // Nothing has been said until the host has it: the line under a message is its time, and
    // a sending message has none, so it has no copy either (what you typed is still in front
    // of you, and Edit takes it back if it fails).
    useOutbox.setState({
      outgoing: [
        {
          id: "0b7a3a1e-58f5-4b33-9a42-0d0c7ddc0d4b",
          conversationId: CONV,
          text: "还在路上的一句",
          blocks: [],
          mentions: [],
          mode: "queue",
          attachments: [],
        },
      ],
    });
    const { container } = await start([]);
    await flush();
    const sending = container.querySelector(".message.user");
    expect(sending?.textContent).toContain("还在路上的一句");
    expect(container.textContent).toContain("发送中");
    expect(sending?.querySelector(".message-footer")).toBeNull();
    expect(sending?.querySelector("time")).toBeNull();
    expect(container.querySelector(".message-copy-btn")).toBeNull();
  });
});

/**
 * Whether it shows is up to the cascade, so it is asked of a real browser: the markup the chat
 * rendered, on a page styled by the app's compiled stylesheet. A rule that outranks the reveal
 * fails these; reading the rule back out of the source would not notice.
 */
describe("when the copy button shows, as a browser draws it", () => {
  afterAll(closeBrowser);

  const rendered = async () => {
    const { container } = await start(transcript());
    await flush();
    return container.innerHTML;
  };
  const opacity = (page: Page, selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).opacity);
  const USER = ".message.user .message-copy-btn";
  const REPLY = ".message.assistant .message-copy-btn";
  const CARD = ".captain-review .message-copy-btn";

  it("is hidden until its message, or its review card, is hovered", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    await onPage(await rendered(), async (page) => {
      for (const button of [USER, REPLY, CARD])
        expect(await opacity(page, button)).toBe("0");
      await page.hover(".message.user .message-content");
      expect(await opacity(page, USER)).toBe("1");
      expect(await opacity(page, CARD)).toBe("0");
      await page.hover(".captain-review article");
      expect(await opacity(page, CARD)).toBe("1");
      expect(await opacity(page, USER)).toBe("0");
    });
  });

  it("shows when reached from the keyboard, and while it says copied", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    await onPage(await rendered(), async (page) => {
      // Tab until the review's copy has the focus: the browser decides it is :focus-visible.
      for (let presses = 0; presses < 40; presses += 1) {
        await page.keyboard.press("Tab");
        if (
          await page
            .locator(CARD)
            .evaluate((el) => el === document.activeElement)
        )
          break;
      }
      expect(
        await page.locator(CARD).evaluate((el) => el.matches(":focus-visible")),
      ).toBe(true);
      expect(await opacity(page, CARD)).toBe("1");
      await page
        .locator(REPLY)
        .first()
        .evaluate((el) => el.setAttribute("data-copied", "true"));
      expect(await opacity(page, `${REPLY}[data-copied="true"]`)).toBe("1");
    });
  });

  it("stays up on a touch screen, the size it looks, with a finger-sized place to tap", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const markup = await rendered();
    const box = (page: Page) =>
      page
        .locator(REPLY)
        .first()
        .evaluate((el) => {
          const { width, height } = el.getBoundingClientRect();
          return { width, height };
        });
    // Which button a tap this far off its centre lands on, if any.
    const tapped = (page: Page, dx: number, dy: number) =>
      page
        .locator(REPLY)
        .first()
        .evaluate(
          (el, [x, y]) => {
            const rect = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2 + x!,
              rect.top + rect.height / 2 + y!,
            );
            return hit === el || el.contains(hit);
          },
          [dx, dy],
        );
    const desktop = await onPage(markup, async (page) => ({
      box: await box(page),
      below: await tapped(page, 0, 16),
    }));
    // With a mouse, a click 16px under its middle misses: the button is its text and a hairline.
    expect(desktop.below).toBe(false);
    await onPage(
      markup,
      async (page) => {
        for (const button of [USER, REPLY, CARD])
          expect(await opacity(page, button)).toBe("1");
        // It looks exactly as it does with a mouse...
        expect(await box(page)).toEqual(desktop.box);
        expect(desktop.box.height).toBeLessThan(24);
        // ...and a finger up to ~19px off its middle, any direction, still lands on it.
        for (const [dx, dy] of [
          [0, 19],
          [0, -19],
          [19, 0],
          [-19, 0],
        ] as const)
          expect(await tapped(page, dx, dy)).toBe(true);
      },
      PHONE,
    );
  });
});
