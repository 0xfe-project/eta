import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { productHost } from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { InviteDialog } from "./invite-dialog";

const toasts = rstest.hoisted(() => ({ error: rstest.fn() }));
rstest.mock("sonner", () => ({ toast: { error: toasts.error } }));

const agents = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `a${i + 1}`,
    name: i === 0 ? "装配检查" : `Agent ${i + 1}`,
    runtime: i === 1 ? ("claude" as const) : ("eta" as const),
  }));

let host: ReturnType<typeof productHost>;
let failWith: string | undefined;
beforeEach(() => {
  failWith = undefined;
  host = productHost();
  host.handle("conversations.invite", () => {
    if (failWith !== undefined) throw new Error(failWith);
    return {};
  });
});
afterEach(async () => {
  await cleanup();
  setWire(undefined);
  toasts.error.mockClear();
});

const dialog = () => document.querySelector('[role="dialog"]');
const rows = () => [...document.querySelectorAll('[role="dialog"] li')];
const tick = (name: string) =>
  click(
    rows()
      .find((row) => row.textContent?.includes(name))
      ?.querySelector('[role="checkbox"]'),
  );
const submitButton = () =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((b) =>
    /^邀请 \d+ 位$/.test(b.textContent ?? ""),
  );

async function open(count: number) {
  const onOpenChange = rstest.fn();
  await mount(
    <InviteDialog
      open
      onOpenChange={onOpenChange}
      conversationId="g1"
      candidates={agents(count)}
    />,
  );
  await flush();
  return onOpenChange;
}

describe("inviting agents into a group", () => {
  it("draws each agent as a tick row with its runtime, and nothing ticked cannot be sent", async () => {
    await open(3);
    expect(rows()).toHaveLength(3);
    expect(rows()[1]?.textContent).toContain("Claude Code");
    expect(submitButton()?.textContent).toBe("邀请 0 位");
    expect(submitButton()?.hasAttribute("disabled")).toBe(true);
    // Few agents: no search.
    expect(dialog()?.querySelector("input")).toBeNull();
  });

  it("sends every ticked agent in one call, then closes", async () => {
    const onOpenChange = await open(3);
    await tick("装配检查");
    await tick("Agent 3");
    expect(dialog()?.textContent).toContain("已选 2 位");
    expect(submitButton()?.hasAttribute("disabled")).toBe(false);
    await click(submitButton());
    await flush();
    const invites = host.calls.filter((c) => c.action === "invite");
    expect(invites).toHaveLength(1);
    expect(invites[0]?.args).toEqual({
      conversationId: "g1",
      agentIds: ["a1", "a3"],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears what was ticked", async () => {
    await open(3);
    await tick("装配检查");
    await click(button(dialog()!, "清空"));
    expect(submitButton()?.hasAttribute("disabled")).toBe(true);
    expect(dialog()?.textContent).not.toContain("已选");
  });

  it("sends with Enter", async () => {
    await open(3);
    await tick("Agent 2");
    const box = rows()[1]?.querySelector('[role="checkbox"]');
    await act(async () => {
      box?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flush();
    expect(host.calls.find((c) => c.action === "invite")?.args).toEqual({
      conversationId: "g1",
      agentIds: ["a2"],
    });
  });

  it("keeps the dialog and the ticks when the invite fails, and says why", async () => {
    failWith = "no such agent: a3";
    const onOpenChange = await open(3);
    await tick("装配检查");
    await tick("Agent 3");
    await click(submitButton());
    await flush();
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(String(toasts.error.mock.calls[0]?.[0])).toContain(
      "no such agent: a3",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("已选 2 位");
  });

  it("offers a search past eight agents, and it narrows the list by name", async () => {
    await open(9);
    const input = dialog()?.querySelector("input");
    expect(input).not.toBeNull();
    expect(rows()).toHaveLength(9);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "装配");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("装配检查"),
    ]);
    await act(async () => {
      setter?.call(input, "nobody");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toHaveLength(0);
    expect(dialog()?.textContent).toContain("没有匹配的智能体");
  });
});
