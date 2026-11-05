import type {
  ConversationSummary,
  MemberView,
  SendResult,
} from "@eta/client-contracts";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { plainDraft } from "@/lib/composer";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { Chat } from "@/test-chat";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
  productHost,
} from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { storageKey, useWorkspaceStore } from "./workspace-store";

const ARIA = "a1";
const BOLT = "a2";
const CLEO = "a3";
const trio = [memberView(ARIA), memberView(BOLT), memberView(CLEO)];
const agents = [
  agentView({ id: ARIA, name: "Aria" }),
  agentView({ id: BOLT, name: "Bolt" }),
  agentView({ id: CLEO, name: "Cleo" }),
];

let sent: Record<string, unknown>[] = [];
let groups = 0;
let CONV = "";

function hostFor(summaries: ConversationSummary[]) {
  const host = productHost({
    agents,
    conversations: summaries,
    messages: Object.fromEntries(summaries.map((s) => [s.id, []])),
  });
  host.handle("conversations.send", (args): SendResult => {
    const fields = args as { clientId: string; conversationId: string };
    sent.push(args as Record<string, unknown>);
    return {
      message: messageView({
        id: fields.clientId,
        conversationId: fields.conversationId,
      }),
      replies: [],
      joined: [],
      nobody: false,
    };
  });
  return host;
}

function start(
  fields: {
    stewardId?: string | null;
    participants?: MemberView[];
    kind?: ConversationSummary["kind"];
  } = {},
) {
  hostFor([
    conversationView({
      id: CONV,
      stewardId: ARIA,
      participants: trio,
      ...fields,
    }),
  ]);
  return mount(<Chat conversationId={CONV} />);
}

const picker = () =>
  document.querySelector<HTMLElement>('[data-testid="composer-members"]')!;
const editor = () => document.querySelector<HTMLElement>("[contenteditable]")!;
const type = (value: string, conversation = CONV) =>
  act(async () =>
    useOutbox.getState().setDraft(conversation, plainDraft(value)),
  );
async function enter() {
  await act(async () => {
    editor().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flush();
}
const say = async (value: string) => {
  await type(value);
  await enter();
};
/** Radix opens a menu on pointer down. */
async function openMenu() {
  await act(async () => {
    picker().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const items = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
async function pick(label: string) {
  await openMenu();
  const item = items().find((candidate) =>
    candidate.textContent.includes(label),
  );
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
  await flush();
}
const remembered = () =>
  useWorkspaceStore.getState().workspace.stickyTargets?.[CONV];

beforeEach(() => {
  groups += 1;
  CONV = `composer-target-${groups}`;
  sent = [];
  localStorage.clear();
  useWorkspaceStore.setState({ workspace: {} });
  useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
});
afterEach(async () => {
  useOutbox.setState({ outgoing: [] });
  await flush();
  await cleanup();
  setWire(undefined);
});

describe("who the composer says a message is for", () => {
  it("shows the steward until a choice is made, and leaves the routing to the host", async () => {
    await start();
    expect(picker().textContent).toBe("Aria");
    expect(picker().title).toBe("将唤醒 Aria");
    await say("你好");
    expect(sent[0]).toMatchObject({ text: "你好", mentions: [] });
    expect(picker().textContent).toBe("Aria");
    expect(remembered()).toBeUndefined();
  });

  it("names a steward who is not a member yet", async () => {
    await start({ participants: [memberView(BOLT), memberView(CLEO)] });
    expect(picker().textContent).toBe("Aria");
    await pick("Bolt");
    await say("@Aria 你来");
    // The host adds a steward it is left to pick, so the row is sent naming nobody.
    expect(sent[0]!.mentions).toEqual([]);
    expect(remembered()).toBeUndefined();
  });

  it("keeps the old prompt when there is no steward and no choice", async () => {
    await start({ stewardId: null });
    expect(picker().textContent).toBe("@ 说给谁");
    await openMenu();
    expect(items().map((item) => item.textContent)).toEqual([
      "@所有人",
      "Aria",
      "Bolt",
      "Cleo",
    ]);
  });

  it("offers the steward first, then everyone, then the other members, with one tick", async () => {
    await start();
    await openMenu();
    expect(items().map((item) => item.textContent)).toEqual([
      "Aria✓",
      "@所有人",
      "Bolt",
      "Cleo",
    ]);
    await act(async () => items()[2]!.click());
    await flush();
    await openMenu();
    expect(items().map((item) => item.textContent)).toEqual([
      "Aria",
      "@所有人",
      "Bolt✓",
      "Cleo",
    ]);
  });

  it("follows what is typed at once, before anything is sent", async () => {
    await start();
    await pick("Cleo");
    await type("@Aria @Bolt 看一下");
    expect(picker().textContent).toBe("Aria、Bolt");
    await type("@所有人 看一下");
    expect(picker().textContent).toBe("@所有人");
    await type("");
    expect(picker().textContent).toBe("Cleo");
  });
});

describe("keeping the choice", () => {
  it("sends every message to a picked member, and writes nothing into the text", async () => {
    await start();
    await pick("Bolt");
    expect(editor().textContent).toBe("");
    expect(picker().textContent).toBe("Bolt");
    await say("第一条");
    await say("第二条");
    expect(sent.map((args) => [args.text, args.mentions])).toEqual([
      ["第一条", [BOLT]],
      ["第二条", [BOLT]],
    ]);
    expect(picker().textContent).toBe("Bolt");
  });

  it("survives a reload", async () => {
    const { show } = await start();
    await pick("Bolt");
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
      stickyTargets: { [CONV]: [BOLT] },
    });
    await show(null);
    const saved = localStorage.getItem(storageKey)!;
    useWorkspaceStore.setState({ workspace: {} });
    localStorage.setItem(storageKey, saved);
    await useWorkspaceStore.persist.rehydrate();
    await show(<Chat conversationId={CONV} />);
    expect(picker().textContent).toBe("Bolt");
    await say("回来了");
    expect(sent[0]!.mentions).toEqual([BOLT]);
  });

  it("wakes everyone on every message once everyone is picked", async () => {
    await start();
    await pick("所有人");
    expect(picker().textContent).toBe("@所有人");
    expect(picker().title).toBe("将唤醒 Aria、Bolt、Cleo");
    expect(remembered()).toBe("everyone");
    await say("一");
    await say("二");
    expect(sent.map((args) => args.mentions)).toEqual([
      [ARIA, BOLT, CLEO],
      [ARIA, BOLT, CLEO],
    ]);
  });

  it("goes back to the steward from the menu and then follows a new steward", async () => {
    const { show } = await start();
    await pick("Bolt");
    await pick("Aria");
    expect(remembered()).toBeUndefined();
    await say("回主理人");
    expect(sent[0]!.mentions).toEqual([]);
    await show(null);
    hostFor([
      conversationView({ id: CONV, stewardId: CLEO, participants: trio }),
    ]);
    await show(<Chat conversationId={CONV} />);
    await flush();
    expect(picker().textContent).toBe("Cleo");
    await say("换人了");
    expect(sent[1]!.mentions).toEqual([]);
  });

  it("takes what was typed for this message and keeps it for the next", async () => {
    await start();
    await pick("Cleo");
    await say("@Aria @Bolt 一起看");
    expect(sent[0]).toMatchObject({
      text: "@Aria @Bolt 一起看",
      mentions: [ARIA, BOLT],
    });
    expect(picker().textContent).toBe("Aria、Bolt");
    await say("接着看");
    expect(sent[1]!.mentions).toEqual([ARIA, BOLT]);
  });

  it("keeps a typed everyone as everyone, not as a list of names", async () => {
    await start();
    await say("@所有人 开会");
    expect(sent[0]!.mentions).toEqual([ARIA, BOLT, CLEO]);
    expect(remembered()).toBe("everyone");
  });

  it("clears the choice when the steward is typed, rather than saving their id", async () => {
    await start();
    await pick("Bolt");
    await say("@Aria 你来");
    expect(sent[0]!.mentions).toEqual([ARIA]);
    expect(remembered()).toBeUndefined();
    await say("下一条");
    expect(sent[1]!.mentions).toEqual([]);
  });

  it("uses the choice for a steer, like any message", async () => {
    await start();
    await pick("Bolt");
    await say("/steer 改一下");
    expect(sent[0]).toMatchObject({
      text: "改一下",
      mode: "steer",
      mentions: [BOLT],
    });
  });

  it("keeps one choice per group", async () => {
    const other = `${CONV}-other`;
    const summary = (id: string) =>
      conversationView({ id, stewardId: ARIA, participants: trio });
    hostFor([summary(CONV), summary(other)]);
    const { show } = await mount(<Chat conversationId={CONV} />);
    await pick("Bolt");
    await show(<Chat conversationId={other} />);
    await flush();
    expect(picker().textContent).toBe("Aria");
    await pick("所有人");
    await show(<Chat conversationId={CONV} />);
    await flush();
    expect(picker().textContent).toBe("Bolt");
  });

  it("drops a member who left, and returns to the steward when nobody is left", async () => {
    useWorkspaceStore.setState({
      workspace: { stickyTargets: { [CONV]: [BOLT, CLEO] } },
    });
    const { show } = await start();
    expect(picker().textContent).toBe("Bolt、Cleo");
    await show(null);
    hostFor([
      conversationView({
        id: CONV,
        stewardId: ARIA,
        participants: [memberView(ARIA), memberView(CLEO)],
      }),
    ]);
    await show(<Chat conversationId={CONV} />);
    await flush();
    expect(picker().textContent).toBe("Cleo");
    await say("只剩你");
    expect(sent[0]!.mentions).toEqual([CLEO]);
    await show(null);
    hostFor([
      conversationView({
        id: CONV,
        stewardId: ARIA,
        participants: [memberView(ARIA)],
      }),
    ]);
    await show(<Chat conversationId={CONV} />);
    await flush();
    expect(picker().textContent).toBe("Aria");
    await say("回来");
    expect(sent[1]!.mentions).toEqual([]);
    expect(remembered()).toBeUndefined();
  });

  it("has no control and keeps nothing in a direct chat", async () => {
    await start({ kind: "direct", participants: [memberView(BOLT)] });
    expect(picker()).toBeNull();
    await say("@Bolt 你好");
    expect(sent[0]!.mentions).toEqual([BOLT]);
    expect(remembered()).toBeUndefined();
  });
});
